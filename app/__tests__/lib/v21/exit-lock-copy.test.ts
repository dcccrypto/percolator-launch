// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MAX_EXIT_CRANKS, buildExitCrankIxs, pickCrankTargets, planExitCranks, type OpenPortfolio } from "@/lib/v21/exit-cranks";
import { computeEntryVsExit } from "@/lib/v21/entry-exit";
import { countdownLine, deriveCloseOnlyState, slotsToDuration } from "@/lib/v21/lock-episode";
import { adlEpisodeKey, decodeAdlEpisode, ADL_EPISODE_FIELD_OFF, buildAdlWindDownIx, adlWindDownDustNotionalAtoms } from "@/lib/v21/sdk";
import { V21_COPY } from "@/lib/v21/copy";
import { humanizeError, isEngineLockError } from "@/lib/errorMessages";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { decodeMarketHealth, MARKET_HEALTH_SLICE_LEN } from "@/lib/market-health";
import { ADL_ONE } from "@/lib/limits/constants";
import { marketRaw } from "./fixtures";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const k = () => Keypair.generate().publicKey;
const pf = (pnl: bigint, bitmap = 1n): OpenPortfolio => ({ key: k(), pnl, activeBitmap: bitmap });

describe("R3-M1 exit cranks", () => {
  it("only positioned portfolios, losers first, capped, never the excluded", () => {
    const flat = pf(-100n, 0n);
    const loser = pf(-50n);
    const worse = pf(-500n);
    const winner = pf(900n);
    const own = pf(-1n);
    const t = pickCrankTargets([flat, winner, loser, worse, own], 3, [own.key]);
    expect(t).toEqual([worse.key, loser.key, winner.key]);
    expect(t).not.toContainEqual(flat.key);
    expect(pickCrankTargets(Array.from({ length: 12 }, () => pf(-1n)))).toHaveLength(MAX_EXIT_CRANKS);
  });
  it("each crank is a PermissionlessCrank of that portfolio", () => {
    const PROG = k(); const M = k(); const c = k(); const target = k();
    const [ixn] = buildExitCrankIxs({ programId: PROG, cranker: c, market: M, targets: [target] });
    expect(ixn.programId.equals(PROG)).toBe(true);
    expect(ixn.keys.map((x) => x.pubkey.toBase58()).slice(0, 3)).toEqual([c, M, target].map((p) => p.toBase58()));
  });
  const deps = (ps: OpenPortfolio[], err: unknown = null) => ({ read: vi.fn(async () => ps), simulate: vi.fn(async () => ({ err, rpcFailed: false })) });
  const core = [Keypair.generate()].map(() => ({ programId: k(), keys: [], data: Buffer.from([77]) }) as never);
  const args = () => ({ programId: k(), cranker: k(), market: k(), core });
  it("kept when the whole transaction simulates clean", async () => {
    const d = deps([pf(-5n), pf(7n)]);
    const out = await planExitCranks(d, args());
    expect(out).toHaveLength(2);
    expect(d.simulate).toHaveBeenCalledTimes(1);
  });
  it("dropped when they would make the exit fail: the exit goes out as today", async () => {
    expect(await planExitCranks(deps([pf(-5n)], { InstructionError: [0, { Custom: 21 }] }), args())).toEqual([]);
  });
  it("nothing positioned, a failed read or a failed simulation RPC: no cranks, no throw", async () => {
    expect(await planExitCranks(deps([pf(1n, 0n)]), args())).toEqual([]);
    expect(await planExitCranks({ read: async () => { throw new Error("rpc"); }, simulate: async () => ({ err: null, rpcFailed: false }) }, args())).toEqual([]);
    expect(await planExitCranks({ read: async () => [pf(-1n)], simulate: async () => ({ err: null, rpcFailed: true }) }, args())).toEqual([]);
  });
});

describe("R3-L1 entry price vs current exit value", () => {
  const exact = { kind: "exact", earnedAtoms: 0n, unrealizedAtoms: 0n, realizedAtoms: 0n, costBasisAtoms: 100_000_000n } as const;
  it("quotes entry and exit per share, flags a lower exit", () => {
    const r = computeEntryVsExit({ earned: exact, exitAtoms: 91_000_000n, claimShares: 100_000_000n, decimals: 6, lpDecimals: 6 })!;
    expect(r.entryPerShare).toBeCloseTo(1, 6);
    expect(r.exitPerShare).toBeCloseTo(0.91, 6);
    expect(r.below).toBe(true);
    expect(r.belowPct).toBe(9);
  });
  it("at or above entry: not below", () => {
    const r = computeEntryVsExit({ earned: exact, exitAtoms: 103_000_000n, claimShares: 100_000_000n, decimals: 6, lpDecimals: 6 })!;
    expect(r.below).toBe(false);
    expect(r.belowPct).toBe(0);
  });
  it("only when the cost basis is exact for these shares; never a guess", () => {
    const args = { exitAtoms: 1n, claimShares: 1n, decimals: 6, lpDecimals: 6 };
    expect(computeEntryVsExit({ ...args, earned: null })).toBeNull();
    expect(computeEntryVsExit({ ...args, earned: { kind: "unavailable", reason: "out-of-sync" } })).toBeNull();
    expect(computeEntryVsExit({ earned: exact, exitAtoms: null, claimShares: 1n, decimals: 6, lpDecimals: 6 })).toBeNull();
    expect(computeEntryVsExit({ earned: exact, exitAtoms: 5n, claimShares: 0n, decimals: 6, lpDecimals: 6 })).toBeNull();
  });
  it("the reserve disclosure is the coordinator's wording", () => {
    expect(V21_COPY.earn.reserve).toBe("Withdrawals above the reserve wait for capital to be recalled from the market.");
    expect(V21_COPY.earn.reserveLong).toContain("at least 30% of the vault");
  });
});

describe("close-only episode countdown", () => {
  const engine = { aLong: ADL_ONE, aShort: ADL_ONE - 1n, marketId: 1n, epochLong: 0n, epochShort: 4n, oiEffLongQ: 50_000_000_000n, oiEffShortQ: 50_000_000_000n, effectivePriceE6: 1_000_000n };
  const raw = (since: bigint | null, max = 0) => {
    const r = marketRaw({});
    if (since !== null) {
      const off = 592 + 758 + 608; // asset 0 risk-limits record
      const dv = new DataView(r.buffer);
      const [kl, ks] = adlEpisodeKey(1n, 0n, 4n);
      dv.setUint32(off + ADL_EPISODE_FIELD_OFF.maxEpisodeSlots, max, true);
      dv.setBigUint64(off + ADL_EPISODE_FIELD_OFF.sinceSlot, since, true);
      dv.setUint32(off + ADL_EPISODE_FIELD_OFF.epochKeyLong, kl, true);
      dv.setUint32(off + ADL_EPISODE_FIELD_OFF.epochKeyShort, ks, true);
    }
    return r;
  };
  const st = (r: Uint8Array, now: bigint | null, e: typeof engine | null = engine) => deriveCloseOnlyState({ raw: r, engine: e, nowSlot: now, collateralDecimals: 6 });
  it("not close-only (A == ONE both sides) => nothing", () => {
    expect(st(raw(null), 1000n, { ...engine, aShort: ADL_ONE }).closeOnly).toBe(false);
    expect(st(raw(null), 1000n, null).closeOnly).toBe(false);
  });
  it("no timer yet => 'starts the first time anyone checks'; no wind-down offered", () => {
    const s = st(raw(null), 1000n);
    expect(s.closeOnly).toBe(true);
    expect(s.armed).toBe(false);
    expect(s.windDownNow).toBe(false);
    expect(countdownLine(s, V21_COPY.lock)).toBe(V21_COPY.lock.countdownNotStarted);
  });
  it("armed: counts down the default 9,000 slots; the line says about how long; still no wind-down", () => {
    const s = st(raw(10_000n), 10_000n + 3_000n);
    expect(s.remainingSlots).toBe(6_000n);
    expect(s.windDownNow).toBe(false);
    expect(countdownLine(s, V21_COPY.lock)).toBe("Open positions can be wound down automatically in about 40 min.");
  });
  it("a tightened bound is honoured", () => {
    expect(st(raw(10_000n, 300), 10_100n).remainingSlots).toBe(200n);
  });
  it("expired: the wait is over and a wind-down is offered, exactly at the bound", () => {
    expect(st(raw(10_000n), 10_000n + 8_999n).expired).toBe(false);
    const s = st(raw(10_000n), 10_000n + 9_000n);
    expect(s.expired).toBe(true);
    expect(s.windDownNow).toBe(true);
    expect(countdownLine(s, V21_COPY.lock)).toBe(V21_COPY.lock.countdownReady);
  });
  it("a different episode (epoch changed) is not armed", () => {
    expect(st(raw(10_000n), 12_000n, { ...engine, epochShort: 5n }).armed).toBe(false);
  });
  it("a dust side is wound down at once: the notional bound is one whole collateral unit", () => {
    expect(adlWindDownDustNotionalAtoms(6)).toBe(1_000_000n);
    const s = st(raw(null), 1000n, { ...engine, oiEffLongQ: 900_000n, oiEffShortQ: 100_000n });
    expect(s.dust).toBe(true);
    expect(s.windDownNow).toBe(true);
    expect(st(raw(null), 1000n, { ...engine, oiEffLongQ: 1_100_000n }).dust).toBe(false);
  });
  it("duration wording rounds up and never says 0 early", () => {
    expect(slotsToDuration(10n)).toBe("under a minute");
    expect(slotsToDuration(150n)).toBe("about 1 min");
    expect(slotsToDuration(9_000n)).toBe("about 60 min".replace("60 min", "1 h"));
    expect(slotsToDuration(9_001n)).toBe("about 1 h 01 min");
  });
  it("the episode decoder reads the record at asset-slot 652..", () => {
    const e = decodeAdlEpisode(raw(777n, 123), 0);
    expect(e.sinceSlot).toBe(777n);
    expect(e.maxEpisodeSlots).toBe(123);
  });
  it("tag 104 takes no signer and the mint at [3]", () => {
    const i = buildAdlWindDownIx(k(), { caller: k(), market: k(), portfolio: k(), collateralMint: k() }, { nowSlot: 0n, assetIndex: 0, portfolioId: 1n, positionEpoch: 2n });
    expect(i.data[0]).toBe(104);
    expect(i.data).toHaveLength(27);
    expect(i.keys.map((x) => `${x.isSigner ? "s" : "-"}${x.isWritable ? "w" : "-"}`).join(" ")).toBe("-- -w -w --");
  });
});

describe("copy for 120/121/122, 92-99, 100-103", () => {
  beforeEach(() => __setDevnetV21ForTest(true));
  afterEach(() => __setDevnetV21ForTest(null));
  const W = resolveDevnetProgramIds().wrapper;
  const raised = (code: number) => `Program ${W} failed: custom program error: 0x${code.toString(16)}`;
  const ctx = { surface: "trade" as const };
  it("120/121/122 resolve (not 'Something went wrong') and 120-122 count as engine locks", () => {
    expect(resolveUserMessage(new Error(raised(120)), ctx).title).toBe("Close-only for now");
    expect(resolveUserMessage(new Error(raised(120)), ctx).body).toMatch(/close-only while it rebalances/);
    expect(resolveUserMessage(new Error(raised(121)), ctx).kind).toBe("loss-stale");
    expect(resolveUserMessage(new Error(raised(122)), { surface: "earn-withdraw" }).body).toMatch(/under-backed/);
    for (const c of [120, 121, 122]) expect(isEngineLockError(raised(c))).toBe(true);
  });
  it("every growth and Earn code has calm, specific copy and says closing works where it refuses new risk", () => {
    for (const c of [92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103]) {
      const u = resolveUserMessage(new Error(raised(c)), ctx);
      expect(u.kind, `code ${c}`).not.toBe("unmapped");
      expect(humanizeError(raised(c), "trade"), `code ${c}`).not.toMatch(/something went wrong/i);
    }
    for (const c of [92, 93, 95, 97, 103]) expect(resolveUserMessage(new Error(raised(c)), ctx).body).toMatch(/clos/i);
    expect(resolveUserMessage(new Error(raised(103)), ctx).body).toBe("This side is paused while the market's first-loss capital is rebuilt. Closing is always allowed.");
  });
  it("98 is a retryable busy-side fee refusal that explains itself, no jargon", () => {
    const u = resolveUserMessage(new Error(raised(98)), ctx);
    expect(u.variant).toBe("wait");
    expect(u.body).toMatch(/small extra fee/);
    expect(u.body + u.title).not.toMatch(/utilisation|utilization|kink|N_cap|h-lock|ADL/i);
  });
  it("CONTROL (today's programs, flag off): none of the v2.1 codes is interpreted", () => {
    __setDevnetV21ForTest(false);
    for (const c of [92, 98, 100, 103, 120, 121, 122]) {
      expect(resolveUserMessage(new Error(raised(c)), ctx).kind, `code ${c}`).toBe("unmapped");
      expect(humanizeError(raised(c), "trade"), `code ${c}`).not.toMatch(/closing|close-only|first-loss|busy/i);
    }
  });
  it("the codes are only the wrapper's: a foreign program's Custom(103) is not mapped", () => {
    const foreign = `Program ${Keypair.generate().publicKey.toBase58()} failed: custom program error: 0x67`;
    expect(resolveUserMessage(new Error(foreign), ctx).kind).toBe("unmapped");
  });
});

describe("market health: the h-lock byte is non-zero, not === 1", () => {
  const health = (byte: number) => {
    const d = new Uint8Array(MARKET_HEALTH_SLICE_LEN);
    d[10] = 1;
    d[592 + 621] = byte;
    return decodeMarketHealth(d, 0n, null).bankruptcyHlock;
  };
  it("0 off, 1 on, attributed (3, 255) on", () => {
    expect(health(0)).toBe(false);
    expect(health(1)).toBe(true);
    expect(health(3)).toBe(true);
    expect(health(255)).toBe(true);
  });
});
