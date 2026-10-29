// @vitest-environment node
/**
 * D16 (v22 deep memo 2026-10-29): on a GUARDED market the app's tag-103 prefix is preceded by the guard poke
 * (tag 124 op 4, NAV-sampling tail), exactly like the keeper's pre-allocate poke, so a loss and a big Earn
 * deposit in the same interval are not measured against the bigger pot. The poke never blocks the trade:
 * it rides only when [poke, 103] simulates clean, else the 103 goes alone as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { planAllocatePrefix } from "@/lib/v21/allocate-prefix";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resetLevGuardCache, levGuardPda } from "@/lib/v22/lev-guard";
import { deriveVaultLpExt } from "@/lib/v21/sdk";
import { deriveVaultLpState } from "@/lib/limits/p3-ix";
import { registryBytes, vaultLpStateBytes } from "../v21/fixtures";

const k = () => Keypair.generate().publicKey;
const PROG = k();
const MARKET = k();
const CRANKER = k();
const LP = k();

afterEach(() => {
  __setDevnetV21ForTest(null);
  __setDevnetV22ForTest(null);
  resetLevGuardCache();
});

function conn(guard: boolean) {
  const infos = [
    { owner: PROG, data: Buffer.from(registryBytes({ bound: true, domain: 0 })) },
    { owner: PROG, data: Buffer.from(vaultLpStateBytes(LP.toBytes())) },
  ];
  return {
    getAccountInfo: vi.fn(async (pk: PublicKey) =>
      guard && pk.equals(levGuardPda(PROG, MARKET)) ? { owner: PROG, data: Buffer.alloc(16), lamports: 1, executable: false } : null,
    ),
    getMultipleAccountsInfo: vi.fn(async () => infos),
  };
}
const run = (c: unknown, sim: (ixs: unknown[]) => Promise<{ err: unknown; rpcFailed: boolean }>) =>
  planAllocatePrefix({ connection: c as never, simulate: sim as never }, { programId: PROG, market: MARKET, cranker: CRANKER, beforeQ: 0n, signedSizeQ: 5n });
const clean = async () => ({ err: null, rpcFailed: false });

describe("D16: guard poke in front of the app's tag 103", () => {
  it("v2.2 ON, guarded market: [poke, 103], the poke in the keeper's exact account order", async () => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    const ixs = await run(conn(true), vi.fn(clean));
    expect(ixs.map((ix) => ix.data[0])).toEqual([124, 103]);
    const poke = ixs[0];
    expect(Array.from(poke.data)).toEqual([124, 4]);
    expect(poke.programId.equals(PROG)).toBe(true);
    expect(poke.keys.map((m) => m.pubkey.toBase58())).toEqual(
      [CRANKER, MARKET, levGuardPda(PROG, MARKET), LP, deriveVaultLpState(PROG, MARKET), deriveVaultLpExt(PROG, MARKET)].map((p) => p.toBase58()),
    );
    expect(poke.keys.map((m) => `${m.isSigner ? "s" : "-"}${m.isWritable ? "w" : "-"}`).join(" ")).toBe("s- -w -w -w -- --");
  });
  it("the pair is simulated together before it is kept", async () => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    const sim = vi.fn(clean);
    await run(conn(true), sim);
    expect(sim.mock.calls.map((c) => (c[0] as { data: Uint8Array }[]).map((ix) => ix.data[0]))).toEqual([[103], [124, 103]]);
  });
  it("the poke never blocks: a refused or unreadable pair simulation drops only the poke", async () => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    const pokeRefused = vi.fn(async (ixs: unknown[]) => (ixs.length === 2 ? { err: { InstructionError: [0, { Custom: 133 }] }, rpcFailed: false } : { err: null, rpcFailed: false }));
    expect((await run(conn(true), pokeRefused)).map((ix) => ix.data[0])).toEqual([103]);
    const rpcDown = vi.fn(async (ixs: unknown[]) => (ixs.length === 2 ? { err: null, rpcFailed: true } : { err: null, rpcFailed: false }));
    expect((await run(conn(true), rpcDown)).map((ix) => ix.data[0])).toEqual([103]);
  });
  it("no guard on the market: the 103 alone, as before", async () => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    expect((await run(conn(false), vi.fn(clean))).map((ix) => ix.data[0])).toEqual([103]);
  });
  it("v2.2 OFF: never a poke, and the guard is never looked up", async () => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(false);
    const c = conn(true);
    expect((await run(c, vi.fn(clean))).map((ix) => ix.data[0])).toEqual([103]);
    expect(c.getAccountInfo).not.toHaveBeenCalled();
  });
  it("no 103 (refused): no poke either", async () => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
    expect(await run(conn(true), vi.fn(async () => ({ err: { InstructionError: [0, { Custom: 100 }] }, rpcFailed: false })))).toEqual([]);
  });
});
