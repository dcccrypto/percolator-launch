// @vitest-environment node
/**
 * GH#2953: planSelfHeal refreshes a stale K/F cohort inside the user's own transaction.
 * Base bytes: the healthy PENGU capture (fixtures/v18-liveness, no bucket / side repair due),
 * with asset 0's stale_account_count_long set to 2, the live Percolator 9EPm8nB8 state.
 * The simulated engine refuses the user's trade Custom(21) unless every stale portfolio's
 * refresh precedes it (trade_preflight_risk_gate, engine v16.rs:22593).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { encodePermissionlessCrank } from "@percolatorct/sdk";
import { ENGINE_LOCK_ACTIVE_CODE, REPAIR_CU, healedListUsable, planSelfHeal, type SelfHealDeps } from "@/lib/self-heal";
import { STALE_REFRESH_CU } from "@/lib/stale-refresh";

const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MARKET = new PublicKey("BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY");
const SLOT = 505580400n;
const STALE_LONG_OFF = 592 + 758 + 1024 + 337;

function marketBytes(staleLong: bigint): Uint8Array {
  const raw = Buffer.from(readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", "pengu-market-v18-healthy.b64"), "utf8").trim(), "base64");
  const d = new Uint8Array(raw);
  new DataView(d.buffer, d.byteOffset, d.byteLength).setBigUint64(STALE_LONG_OFF, staleLong, true);
  return d;
}

const REFRESH_DATA = Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: [] }));
const isRefresh = (ix: TransactionInstruction) => ix.programId.equals(PROGRAM) && Buffer.from(ix.data).equals(REFRESH_DATA);

describe("planSelfHeal: stale K/F cohort (GH#2953)", () => {
  const cranker = Keypair.generate().publicKey;
  const stale = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const userIx = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([10, 9]) });
  const base = { programId: PROGRAM, market: MARKET, instructions: [userIx], computeUnits: 460_000 };

  function deps(staleLong: bigint, opts: { found?: PublicKey[]; refreshClears?: boolean; refreshRefused?: boolean } = {}) {
    const sims: TransactionInstruction[][] = [];
    const findStaleRefreshes = vi.fn(async () => opts.found ?? stale);
    const d: SelfHealDeps = {
      readMarket: async () => ({ data: marketBytes(staleLong), slot: SLOT }),
      simulate: async (ixs) => {
        sims.push(ixs);
        const first = ixs.findIndex(isRefresh);
        if (opts.refreshRefused && first >= 0) return { err: { InstructionError: [first, { Custom: 22 }] } };
        const refreshed = ixs.filter(isRefresh).map((ix) => ix.keys[2].pubkey.toBase58());
        const all = stale.every((pk) => refreshed.includes(pk.toBase58()));
        if (all && opts.refreshClears !== false) return { err: null };
        return { err: { InstructionError: [ixs.length - 1, { Custom: ENGINE_LOCK_ACTIVE_CODE }] } };
      },
      findStaleRefreshes,
    };
    return { d, sims, findStaleRefreshes };
  }

  it("a 21 on a stale-cohort market: refreshes of exactly the stale portfolios go before the trade", async () => {
    const { d, sims } = deps(2n);
    const r = await planSelfHeal({ ...base, staleRefreshCranker: cranker }, d);
    expect(r.outcome).toBe("repaired");
    expect(r.staleRefreshes).toBe(2);
    expect(r.instructions).toHaveLength(3);
    expect(r.instructions.slice(0, 2).every(isRefresh)).toBe(true);
    expect(r.instructions.slice(0, 2).map((ix) => ix.keys[2].pubkey.toBase58())).toEqual(stale.map((p) => p.toBase58()));
    expect(r.instructions[0].keys[0].pubkey.equals(cranker)).toBe(true); // the user signs the refresh
    expect(r.instructions[2]).toBe(userIx);
    expect(r.computeUnits).toBe(460_000 + 2 * STALE_REFRESH_CU);
    expect(sims).toHaveLength(2);
  });

  it("never puts catch-up cranks in front of the refreshes (an accrual would re-stale everyone)", async () => {
    const { d } = deps(2n);
    const r = await planSelfHeal({ ...base, staleRefreshCranker: cranker, catchUp: { cranker, portfolio: Keypair.generate().publicKey } }, d);
    expect(r.outcome).toBe("repaired");
    expect(r.catchUpCranks ?? 0).toBe(0);
    expect(r.instructions.filter((ix) => !isRefresh(ix) && ix !== userIx)).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: no stale cohort -> no scan, no simulation, unchanged", async () => {
    const { d, sims, findStaleRefreshes } = deps(0n);
    const r = await planSelfHeal({ ...base, staleRefreshCranker: cranker }, d);
    expect(r.outcome).toBe("no-repair-needed");
    expect(r.instructions).toBe(base.instructions);
    expect(findStaleRefreshes).not.toHaveBeenCalled();
    expect(sims).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: the caller did not opt in (no cranker) -> unchanged even when stale", async () => {
    const { d, findStaleRefreshes } = deps(2n);
    const r = await planSelfHeal(base, d);
    expect(r.outcome).toBe("no-repair-needed");
    expect(findStaleRefreshes).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: the refreshes do not clear the 21 -> unchanged (the real refusal surfaces)", async () => {
    const { d } = deps(2n, { refreshClears: false });
    const r = await planSelfHeal({ ...base, staleRefreshCranker: cranker }, d);
    expect(r.outcome).toBe("repair-did-not-help");
    expect(r.instructions).toBe(base.instructions);
    expect(r.computeUnits).toBe(base.computeUnits);
  });

  it("a refresh refused EngineNonProgress (22, newer mark pending) never replaces the user's 21", async () => {
    const { d } = deps(2n, { refreshRefused: true });
    const r = await planSelfHeal({ ...base, staleRefreshCranker: cranker }, d);
    expect(r.outcome).toBe("repair-did-not-help");
    expect(r.instructions).toBe(base.instructions);
  });

  it("healedListUsable: clean, or a non-19/21 from the user's own ix only", () => {
    const list = [
      new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([5]) }),
      userIx,
    ];
    expect(healedListUsable(null, list, PROGRAM, 1)).toBe(true);
    expect(healedListUsable({ InstructionError: [1, { Custom: 49 }] }, list, PROGRAM, 1)).toBe(true);
    expect(healedListUsable({ InstructionError: [1, { Custom: 21 }] }, list, PROGRAM, 1)).toBe(false);
    expect(healedListUsable({ InstructionError: [0, { Custom: 22 }] }, list, PROGRAM, 1)).toBe(false);
    expect(healedListUsable("BlockhashNotFound", list, PROGRAM, 1)).toBe(false);
  });

  it("NEGATIVE CONTROL: too many stale portfolios (scan returns none) -> unchanged", async () => {
    const { d } = deps(2n, { found: [] });
    const r = await planSelfHeal({ ...base, staleRefreshCranker: cranker }, d);
    expect(r.outcome).toBe("repair-did-not-help");
    expect(r.instructions).toBe(base.instructions);
  });

  it("CU never exceeds the 1.4M transaction cap", async () => {
    const { d } = deps(2n);
    const r = await planSelfHeal({ ...base, computeUnits: 1_300_000, staleRefreshCranker: cranker }, d);
    expect(r.computeUnits).toBeLessThanOrEqual(1_400_000);
    expect(REPAIR_CU).toBeGreaterThan(0);
  });
});
