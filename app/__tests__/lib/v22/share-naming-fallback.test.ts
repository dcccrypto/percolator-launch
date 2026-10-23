// @vitest-environment node
/** F4: tag 122 must never stop a launch. Balance preflight, failure attribution, and the automatic retry without the naming. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22 } from "@/lib/v22/sdk";
import { SHARE_NAMING_HOLD_LAMPORTS } from "@/lib/v22/share-naming";
import {
  SHARE_NAMING_BALANCE_HEADROOM_LAMPORTS, evidenceFromPlan, failingInstructionIndex, isShareNamingFailure, sendWithShareNamingFallback,
  shareNamingAffordable, withoutShareNaming,
} from "@/lib/v22/share-naming-fallback";

afterEach(() => {
  __setDevnetV22ForTest(null);
  delete process.env.NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING;
});
const W = Keypair.generate().publicKey, P = Keypair.generate().publicKey;
const ix = (program: PublicKey, tag: number) => new TransactionInstruction({ programId: program, keys: [], data: Buffer.from([tag, 0]) });
const NEED = SHARE_NAMING_HOLD_LAMPORTS + SHARE_NAMING_BALANCE_HEADROOM_LAMPORTS;

describe("shareNamingAffordable (balance preflight for the 30,000,000-lamport hold)", () => {
  it("flag off: false and NO RPC call", async () => {
    __setDevnetV22ForTest(false);
    const getBalance = vi.fn(async () => 10 ** 12);
    expect(await shareNamingAffordable({ getBalance }, W)).toBe(false);
    expect(getBalance).not.toHaveBeenCalled();
  });
  it("flag on: true at hold + headroom, false one lamport below, false when the read fails or naming is switched off", async () => {
    __setDevnetV22ForTest(true);
    expect(await shareNamingAffordable({ getBalance: async () => NEED }, W)).toBe(true);
    expect(await shareNamingAffordable({ getBalance: async () => NEED - 1 }, W)).toBe(false);
    expect(await shareNamingAffordable({ getBalance: async () => { throw new Error("429"); } }, W)).toBe(false);
    process.env.NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING = "0";
    expect(await shareNamingAffordable({ getBalance: async () => NEED }, W)).toBe(false);
  });
});

describe("attribution", () => {
  it("failingInstructionIndex reads an object or the JSON inside a message", () => {
    expect(failingInstructionIndex({ InstructionError: [4, { Custom: 1 }] })).toBe(4);
    expect(failingInstructionIndex('simulation failed: {"InstructionError":[7,{"Custom":1}]}')).toBe(7);
    expect(failingInstructionIndex("boom")).toBeNull();
    expect(failingInstructionIndex(null)).toBeNull();
  });
  it("tag 122 of THIS wrapper, or a failed Metaplex program, is naming's failure; any other instruction is not", () => {
    expect(isShareNamingFailure({ failingProgram: P.toBase58(), failingTag: 122 }, P)).toBe(true);
    expect(isShareNamingFailure({ logs: [`Program ${METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBase58()} failed: custom program error: 0x1`] }, P)).toBe(true);
    // NEGATIVE CONTROLS
    expect(isShareNamingFailure({ failingProgram: P.toBase58(), failingTag: 75 }, P)).toBe(false); // a deposit
    expect(isShareNamingFailure({ failingProgram: P.toBase58(), failingTag: 74 }, P)).toBe(false); // the vault create
    expect(isShareNamingFailure({ failingProgram: W.toBase58(), failingTag: 122 }, P)).toBe(false); // tag 122 of another program
    expect(isShareNamingFailure({ logs: [`Program ${METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBase58()} success`] }, P)).toBe(false);
    expect(isShareNamingFailure({}, P)).toBe(false);
  });
  it("evidenceFromPlan maps the failing index into the planned list", () => {
    const planned = [ix(SystemProgram.programId, 0), ix(P, 74), ix(P, 122), ix(P, 75)];
    expect(isShareNamingFailure(evidenceFromPlan('{"InstructionError":[2,{"Custom":1}]}', [], planned), P)).toBe(true);
    expect(isShareNamingFailure(evidenceFromPlan('{"InstructionError":[3,{"Custom":1}]}', [], planned), P)).toBe(false);
    expect(isShareNamingFailure(evidenceFromPlan('{"InstructionError":[99,{"Custom":1}]}', [], planned), P)).toBe(false);
  });
  it("withoutShareNaming drops only this wrapper's 122", () => {
    const a = [ix(P, 74), ix(P, 122), ix(W, 122), ix(P, 75)];
    expect(withoutShareNaming(a, P).map((i) => [i.programId.equals(P), i.data[0]])).toEqual([[true, 74], [false, 122], [true, 75]]);
  });
});

describe("sendWithShareNamingFallback (simulate-first seed send)", () => {
  const namingRefusal = { failingProgram: P.toBase58(), failingTag: 122 };
  it("a refusal at tag 122: ONE retry without the naming, which lands", async () => {
    const send = vi.fn(async (name: boolean) => { if (name) throw new Error("naming refused"); return "sig"; });
    const onFallback = vi.fn();
    expect(await sendWithShareNamingFallback(send, true, P, () => namingRefusal, onFallback)).toEqual({ signature: "sig", named: false });
    expect(send.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
  it("no failure: sent once, named", async () => {
    const send = vi.fn(async () => "sig");
    expect(await sendWithShareNamingFallback(send, true, P, () => namingRefusal)).toEqual({ signature: "sig", named: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("NEGATIVE CONTROLS: a refusal elsewhere (the vault create) is NOT retried; a failing retry propagates; naming off is sent once", async () => {
    const other = vi.fn(async () => { throw new Error("74 refused"); });
    await expect(sendWithShareNamingFallback(other, true, P, () => ({ failingProgram: P.toBase58(), failingTag: 74 }))).rejects.toThrow("74 refused");
    expect(other).toHaveBeenCalledTimes(1);
    const both = vi.fn(async (name: boolean) => { throw new Error(name ? "first" : "second"); });
    await expect(sendWithShareNamingFallback(both, true, P, () => namingRefusal)).rejects.toThrow("second");
    expect(both).toHaveBeenCalledTimes(2);
    const off = vi.fn(async () => { throw new Error("x"); });
    await expect(sendWithShareNamingFallback(off, false, P, () => namingRefusal)).rejects.toThrow("x");
    expect(off).toHaveBeenCalledTimes(1);
    const noEvidence = vi.fn(async () => { throw new Error("rpc"); });
    await expect(sendWithShareNamingFallback(noEvidence, true, P, () => null)).rejects.toThrow("rpc");
    expect(noEvidence).toHaveBeenCalledTimes(1);
  });
});

describe("wiring", () => {
  it("the sequential Earn seed (Step 4) goes through the fallback sender, with the balance preflight", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("hooks/useCreateMarket.ts", "utf8");
    expect(src).toContain("await sendWithShareNamingFallback(");
    expect(src.match(/shareNamingAffordable\(/g)?.length).toBe(2); // batched / single-tx plan + sequential Step 4
  });
});
