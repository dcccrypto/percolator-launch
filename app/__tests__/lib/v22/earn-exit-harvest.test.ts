// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { parseFailure } from "@/lib/limits/user-message";
import { quoteExit, sendExit, type ExitRunDeps, type ExitRunInput, type SimResult } from "@/lib/v22/earn-exit-run";
import { TransactionInstruction as Ix } from "@solana/web3.js";
import type { ExitContext } from "@/lib/v22/earn-exit";

const k = () => Keypair.generate().publicKey;
const ctx = (): ExitContext => ({
  market: { programId: new PublicKey(resolveDevnetProgramIds().wrapper), market: k(), registryDomain: 0 },
  redeemer: k(),
  redeemerLpAta: k(),
  redeemerDest: k(),
  vaultToken: k(),
  sourceDomain: 0,
  shares: 1_000n,
});
const input = (mode: ExitRunInput["mode"] = "execute"): ExitRunInput => ({ ctx: ctx(), mode });
const stale = (n: number) => Array.from({ length: n }, () => ({ key: k(), legs: 1 }));
const ok = (after: bigint): SimResult => ({ err: null, logs: [], destAfter: after });
const prog = (code: number): SimResult => ({ err: { InstructionError: [0, { Custom: code }] }, logs: [`Program x failed: custom program error: 0x${code.toString(16)}`], destAfter: null });
const exec77 = (ixs: TransactionInstruction[]) => ixs.find((i) => i.data[0] === 77)!;

function deps(over: Partial<ExitRunDeps> & { sims?: SimResult[]; staleSets?: ReturnType<typeof stale>[]; sendErrors?: unknown[] }): { d: ExitRunDeps; log: string[] } {
  const log: string[] = [];
  const sims = [...(over.sims ?? [ok(1_000_000n)])];
  const staleSets = [...(over.staleSets ?? [[]])];
  const sendErrors = [...(over.sendErrors ?? [])];
  const d: ExitRunDeps = {
    readStale: async () => staleSets.length > 1 ? staleSets.shift()! : staleSets[0],
    readDestBalance: async () => 0n,
    simulate: vi.fn(async (ixs, units) => {
      log.push(`sim:${ixs.map((i) => i.data[0]).filter((t) => t === 77 || t === 78).join("+")}`);
      return sims.length > 1 ? sims.shift()! : sims[0];
    }),
    send: vi.fn(async (ixs, units) => {
      log.push(`send:${ixs.map((i) => i.data[0]).filter((t) => t === 77 || t === 78).join("+")}`);
      const e = sendErrors.shift();
      if (e) throw e;
      return "SIG";
    }),
    parse: parseFailure,
    sleep: async () => {},
    ...over,
  };
  return { d, log };
}
const err = (code: number) => new Error(`custom program error: 0x${code.toString(16)}`);

const harvest = (): Ix => new Ix({ programId: new PublicKey(resolveDevnetProgramIds().wrapper), keys: [], data: Buffer.from([78, 0, 0]) });

describe("v2.2 QA E-1: a bound vault's payout carries tag 78 in front when 77 says 84", () => {
  it("quote: 84 -> re-simulates with 78 before 77 and marks the quote; send carries 78 first in the SAME tx", async () => {
    const { d, log } = deps({ sims: [prog(84), ok(2_000_000n)], harvestIx: async () => harvest() });
    const r = await quoteExit(input("execute"), d);
    expect(r.status).toBe("quoted");
    if (r.status !== "quoted") return;
    expect(r.quote.harvest).toBe(true);
    expect(r.quote.quote).toBe(2_000_000n);
    expect(log).toEqual(["sim:77", "sim:78+77"]);
    const s = await sendExit(input("execute"), r.quote, d);
    expect(s.status).toBe("sent");
    expect(log[2]).toBe("send:78+77");
  });

  it("no 84: 78 is never added (it refuses 38 with nothing to harvest)", async () => {
    const { d, log } = deps({ sims: [ok(1_000_000n)], harvestIx: async () => harvest() });
    const r = await quoteExit(input("execute"), d);
    expect(r.status === "quoted" && r.quote.harvest).toBeFalsy();
    if (r.status === "quoted") await sendExit(input("execute"), r.quote, d);
    expect(log).toEqual(["sim:77", "send:77"]);
  });

  it("send: an 84 that appears after the quote adds 78 once; a 38 (already harvested) drops it once", async () => {
    const a = deps({ sims: [ok(1_000_000n)], harvestIx: async () => harvest(), sendErrors: [err(84)] });
    const qa = await quoteExit(input("execute"), a.d);
    if (qa.status !== "quoted") throw new Error("not quoted");
    expect((await sendExit(input("execute"), qa.quote, a.d)).status).toBe("sent");
    expect(a.log.slice(1)).toEqual(["send:77", "send:78+77"]);

    const b = deps({ sims: [prog(84), ok(1_000_000n)], harvestIx: async () => harvest(), sendErrors: [err(38)] });
    const qb = await quoteExit(input("execute"), b.d);
    if (qb.status !== "quoted") throw new Error("not quoted");
    expect((await sendExit(input("execute"), qb.quote, b.d)).status).toBe("sent");
    expect(b.log.slice(2)).toEqual(["send:78+77", "send:77"]);
  });

  it("pair mode puts 78 ahead of the 76 + 77 pair; an unbound vault (no harvestIx) is unchanged", async () => {
    const { d, log } = deps({ sims: [prog(84), ok(5n)], harvestIx: async () => harvest() });
    const r = await quoteExit(input("pair"), d);
    if (r.status !== "quoted") throw new Error("not quoted");
    await sendExit(input("pair"), r.quote, d);
    const sent = (d.send as unknown as { mock: { calls: [Ix[], number][] } }).mock.calls[0][0].map((i) => i.data[0]);
    expect(sent).toEqual([78, 76, 77]);
    expect(log[0]).toBe("sim:77");

    const u = deps({ sims: [prog(84)] });
    expect((await quoteExit(input("execute"), u.d)).status).toBe("failed");
  });
});
