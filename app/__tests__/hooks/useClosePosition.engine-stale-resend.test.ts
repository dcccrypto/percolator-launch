/**
 * C1 + double-close safety (feature check 2026-10-18; audit of #3565). The real useClosePosition + the real useTrade run end to end against
 * captured v2.2 (VERSION 19) bytes: a one-slot market and a flat 10,603 B portfolio patched to hold a long. Only the network edge is stubbed.
 * Harness adapted from useClosePosition.explicit-target.test.ts (#3301), on v2.2 fixtures so it runs flag-on in every mode.
 *
 *  - a send that fails EngineStale (19) is resent ONCE, rebuilt; a second 19 stops with the calm line;
 *  - before ANY resend the app checks whether an earlier attempt landed (getSignatureStatuses, history searched) and re-sizes from the LIVE
 *    position: a close that already landed is never traded again (the close ix has no reduce-only flag, so a stale size would OPEN the other side).
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

const FX = join(__dirname, "..", "fixtures");
// v2.2 (VERSION 19) fixtures, so this runs with the flag on in every mode: a captured one-slot market and a captured flat 10,603 B portfolio
// whose leg bytes are patched (same leg offsets as v18: active 356, side 369, basis 370).
const MARKET_FX = JSON.parse(readFileSync(join(FX, "v22-market-single-asset-SOL.json"), "utf8"));
const PORTFOLIO_FX = JSON.parse(readFileSync(join(FX, "v22-flat-winner-portfolio-2026-10-11.json"), "utf8"));
const MARKET = new Uint8Array(Buffer.from(MARKET_FX.dataBase64, "base64"));
const BASE = Buffer.from(PORTFOLIO_FX.b64, "base64");
const OWNER = new PublicKey(PORTFOLIO_FX.owner);
const SLAB = new PublicKey(MARKET_FX.market);
const PROGRAM = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"); // v2.2 fresh-ID wrapper

const LEG_ACTIVE = 356;
const LEG_SIDE = 369;
const LEG_BASIS = 370;
function portfolio(o: { side: 0 | 1; basis: bigint; active?: boolean }): Buffer {
  const d = Buffer.from(BASE);
  SLAB.toBuffer().copy(d, 16);
  d[LEG_ACTIVE] = o.active === false ? 0 : 1;
  d[LEG_SIDE] = o.side;
  d.writeBigUInt64LE(o.basis, LEG_BASIS);
  return d;
}

// Deterministic, ordered pubkeys: SHORT_PK < LONG_PK < FLAT_PK in base58 order.
const sortedKeys = Array.from({ length: 3 }, (_, i) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey)
  .sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
const [SHORT_PK, LONG_PK, FLAT_PK] = sortedKeys;
const SHORT_BASIS = 10_000_000n;
const LONG_BASIS = 40_000_000n;

const chain = new Map<string, { owner: PublicKey; data: Buffer }>();
const sent: Array<{ instructions: Array<{ keys: Array<{ pubkey: PublicKey }>; data: Buffer }> }> = [];
const tradeIxParams: Array<{ accountA: PublicKey; size: bigint }> = [];

const mocks = vi.hoisted(() => ({ withdraw: vi.fn(), sweepReads: vi.fn(), script: [] as Array<() => void>, toast: vi.fn(), statuses: new Map<string, { err: unknown; confirmationStatus: string } | null>(), ambiguous: vi.fn(async (): Promise<string> => "not-landed") }));

const getAccountInfo = vi.fn(async (pk: PublicKey) => {
  if (pk.equals(SLAB)) return { data: Buffer.from(MARKET), owner: PROGRAM };
  return chain.get(pk.toBase58()) ?? null;
});
const getProgramAccounts = vi.fn(async () => {
  // What the OLD resolution scanned: every account this wallet owns on the market.
  return [...chain.entries()]
    .filter(([, v]) => v.owner.equals(PROGRAM))
    .map(([k, v]) => ({ pubkey: new PublicKey(k), account: { data: v.data } }));
});
const getSignatureStatuses = vi.fn(async (sigs: string[]) => ({ value: sigs.map((sg) => mocks.statuses.get(sg) ?? null) }));
const connection = { getAccountInfo, getProgramAccounts, getMultipleAccountsInfo: vi.fn(async () => []), getSignatureStatuses };

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({ publicKey: OWNER, connected: true, signTransaction: vi.fn() }),
}));
// The canonical account the market shows by default (lowest pubkey) is the SHORT.
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({ idx: 0, pubkey: SHORT_PK, account: { positionSize: -SHORT_BASIS } }),
}));
vi.mock("@/hooks/useToast", async (orig) => ({ ...((await orig()) as Record<string, unknown>), useOptionalToast: () => mocks.toast }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/hooks/useWithdraw", () => ({ useWithdraw: () => ({ withdraw: mocks.withdraw }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    raw: MARKET,
    programId: PROGRAM,
    config: {
      oracleAuthority: PublicKey.default,
      indexFeedId: PublicKey.default,
      authorityPriceE6: 1_000_000n,
      collateralMint: PublicKey.default,
    },
    wrapperConfigV17: { oracleMode: 0 },
    refresh: vi.fn(),
    slabAddress: SLAB.toBase58(),
  }),
}));
vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: () => ({ priceE6: 1_000_000n, priceUsd: 1, price: 1 }),
}));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/matcherCaps", () => ({ getMatcherCaps: vi.fn(async () => null), getLpInventoryState: vi.fn(async () => null) }));
vi.mock("@/lib/position-change", () => ({
  readBeforeTrade: vi.fn(async () => 0n),
  measurePositionChange: vi.fn(async () => ({ beforeQ: 0n, afterQ: 0n })),
  recordPositionChange: vi.fn(),
}));
vi.mock("@/lib/close-sweep", () => ({
  SWEEP_COPY: { prompt: () => "p", done: () => "d", kept: () => "k" },
  readSweepableCapital: async (p: { read: () => Promise<unknown> }) => {
    mocks.sweepReads(await p.read());
    return 5n;
  },
}));
vi.mock("@/lib/taker-crank", () => ({ planTakerCrank: vi.fn(async () => "none") }));
vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(),
  sendTxWaiting: vi.fn(async (a: (typeof sent)[number]) => {
    sent.push(a);
    // The program: a close sent at an already-flat position is not a close (here it would be refused 19; on chain it could open the other side).
    const live = chain.get(LONG_PK.toBase58());
    const flat = !live || live.data[LEG_ACTIVE] === 0 || live.data.readBigUInt64LE(LEG_BASIS) === 0n;
    mocks.script.shift()?.();
    if (flat) throw new Error(STALE);
    return "SIG-" + sent.length;
  }),
  prewarmTxLanding: vi.fn(),
  awaitAmbiguousOutcome: (...a: unknown[]) => mocks.ambiguous(...a),
  simulateForGate: vi.fn(),
  SimulationRefusal: class SimulationRefusal extends Error {},
  buildBatchTx: vi.fn(),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  getPriorityFee: vi.fn(),
}));
vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: vi.fn(async () => ({
    pubkey: new PublicKey(new Uint8Array(32).fill(13)),
    data: new Uint8Array(0),
    owner: new PublicKey(new Uint8Array(32).fill(14)),
    portfolioId: 1n,
    matcherProg: new PublicKey(new Uint8Array(32).fill(15)),
    matcherCtx: new PublicKey(new Uint8Array(32).fill(16)),
    matcherDelegate: new PublicKey(new Uint8Array(32).fill(17)),
    reason: "asset-admin",
  })),
}));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 2n, matcherSequence: 0n, positionEpoch: 0n })),
  fetchAssetMarketId: vi.fn(async () => 1n),
}));
vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
  assertCanonicalMatcher: () => {},
}));
vi.mock("@/lib/oraclePrice", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  detectOracleMode: () => "admin",
  resolveMarketPriceE6: () => 1_000_000n,
}));
vi.mock("@/lib/trade-ix", async (orig) => {
  const actual = (await orig()) as { buildTradeIxs: (p: { accountA: PublicKey; size: bigint }) => unknown };
  return {
    ...actual,
    buildTradeIxs: (p: { accountA: PublicKey; size: bigint }) => {
      tradeIxParams.push({ accountA: p.accountA, size: p.size });
      return actual.buildTradeIxs(p);
    },
  };
});

import { useClosePosition } from "@/hooks/useClosePosition";
import { TARGET_COPY } from "@/lib/portfolio-target";

function seed(accts: Record<string, { data: Buffer; owner?: PublicKey }>) {
  chain.clear();
  for (const [k, v] of Object.entries(accts)) chain.set(k, { owner: v.owner ?? PROGRAM, data: v.data });
}
function seedTwoOwned() {
  seed({
    [SHORT_PK.toBase58()]: { data: portfolio({ side: 1, basis: SHORT_BASIS }) },
    [LONG_PK.toBase58()]: { data: portfolio({ side: 0, basis: LONG_BASIS }) },
    [FLAT_PK.toBase58()]: { data: portfolio({ side: 0, basis: 0n, active: false }) },
  });
}

async function close(percent: number, opts?: Parameters<ReturnType<typeof useClosePosition>["closePosition"]>[1]) {
  const { result } = renderHook(() => useClosePosition(SLAB.toBase58()));
  let r: unknown = null;
  let thrown: unknown = null;
  await act(async () => {
    try {
      r = await result.current.closePosition(percent, opts);
    } catch (e) {
      thrown = e;
    }
  });
  return { r, thrown, error: result.current.error };
}
const tradeKeysOfLastSend = () => {
  const ixs = sent[sent.length - 1].instructions;
  return ixs[ixs.length - 1].keys.map((k) => k.pubkey.toBase58());
};

beforeEach(() => {
  sent.length = 0;
  tradeIxParams.length = 0;
  mocks.withdraw.mockReset();
  mocks.withdraw.mockResolvedValue("WD");
  mocks.sweepReads.mockReset();
  getAccountInfo.mockClear();
  getProgramAccounts.mockClear();
  seedTwoOwned();
});


import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";

const STALE = `Transaction failed: {"InstructionError":[1,{"Custom":19}]}`;
const SIG1 = "5".repeat(88); // a base58 signature shape
const TIMEOUT = `Confirmation timeout (60s) \u2014 tx may still land. Check explorer: ${SIG1}`;
const BLOCKHASH = "Blockhash not found";
const longPortfolio = (basis: bigint) => portfolio({ side: 0, basis });
const flatPortfolio = () => portfolio({ side: 0, basis: 0n, active: false });
const setChain = (data: Buffer) => chain.set(LONG_PK.toBase58(), { owner: PROGRAM, data });

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setUnknownLotExpForTest(0);
  sent.length = 0;
  tradeIxParams.length = 0;
  mocks.script.length = 0;
  mocks.statuses.clear();
  mocks.toast.mockReset();
  getSignatureStatuses.mockClear();
  mocks.withdraw.mockReset();
  mocks.withdraw.mockResolvedValue("WD");
  mocks.sweepReads.mockReset();
  chain.clear();
  setChain(longPortfolio(LONG_BASIS));
});

describe("C1: close that hits EngineStale at send time", () => {
  it("resends once with a freshly built trade and succeeds", async () => {
    mocks.script.push(() => { throw new Error(STALE); });
    const { r, thrown } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).toBeNull();
    expect((r as { signature: string }).signature).toMatch(/^SIG-/);
    expect(sent).toHaveLength(2);
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -LONG_BASIS]); // live position unchanged: same size, rebuilt
  });

  it("a second 19 stops: one retry only, calm line, no withdraw advice", async () => {
    mocks.script.push(() => { throw new Error(STALE); }, () => { throw new Error(STALE); });
    const { thrown, error } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(error).toBe("Prices moved on while sending; nothing was sent. Try again.");
    expect(error).not.toMatch(/withdraw/i);
  });

  it("another error code is not resent as a 19", async () => {
    mocks.script.push(() => { throw new Error(`Transaction failed: {"InstructionError":[1,{"Custom":49}]}`); });
    await close(100, { portfolioPk: LONG_PK });
    expect(sent).toHaveLength(1);
  });
});

describe("double-close safety: no resend of a close that already landed", () => {
  it("attempt 1 landed but the client saw an expired blockhash (transient retry): the live read shows flat, nothing is traded again", async () => {
    mocks.script.push(() => { setChain(flatPortfolio()); throw new Error(BLOCKHASH); });
    const { r, thrown, error } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).toBeNull();
    expect(error).toBeNull();
    expect(sent).toHaveLength(1); // no second, no third trade at the stale size
    expect(tradeIxParams).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledWith("Position closed.", "success");
    expect(r).not.toBeNull();
  });

  it("a confirmation timeout is never resent at all (it may have landed): one trade, the user is told it is still confirming", async () => {
    mocks.script.push(() => { throw new Error(TIMEOUT); });
    const { thrown } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("attempt 1 failed 19 but names a signature that DID land: the status check wins, no further trade, user sees closed", async () => {
    mocks.statuses.set(SIG1, { err: null, confirmationStatus: "finalized" });
    mocks.script.push(() => { setChain(flatPortfolio()); throw new Error(`${STALE} signature: ${SIG1}`); });
    const { thrown } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).toBeNull();
    expect(getSignatureStatuses).toHaveBeenCalledWith([SIG1], { searchTransactionHistory: true });
    expect(sent).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledWith("Position closed.", "success");
  });

  it("attempt 1 did not land and the position is untouched: attempt 2 is sized from the live position", async () => {
    mocks.script.push(() => { throw new Error(BLOCKHASH); });
    await close(100, { portfolioPk: LONG_PK });
    expect(sent).toHaveLength(2);
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -LONG_BASIS]);
  });

  it("attempt 1 landed PART of a full close: the resend sells only what is left, never the stale size", async () => {
    mocks.script.push(() => { setChain(longPortfolio(15_000_000n)); throw new Error(BLOCKHASH); });
    await close(100, { portfolioPk: LONG_PK });
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -15_000_000n]);
  });

  it("a 50% close that already landed is not repeated: the live position is already at the intended final size", async () => {
    mocks.script.push(() => { setChain(longPortfolio(LONG_BASIS / 2n)); throw new Error(BLOCKHASH); });
    await close(50, { portfolioPk: LONG_PK });
    expect(sent).toHaveLength(1);
  });

  it("a position that flipped to the other side is never traded again", async () => {
    mocks.script.push(() => { setChain(portfolio({ side: 1, basis: 5_000_000n })); throw new Error(BLOCKHASH); });
    const { thrown, error } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(error).toMatch(/nothing more was sent/);
  });

  it("if the app cannot tell whether the first attempt landed, it does not resend", async () => {
    getSignatureStatuses.mockRejectedValueOnce(new Error("rpc down"));
    mocks.script.push(() => { throw new Error(`${STALE} signature: ${SIG1}`); });
    const { thrown, error } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(error).toMatch(/nothing more was sent/);
  });
});

describe("#3565 Low: a known in-flight signature is waited for before any resend", () => {
  /** An error as sendTx throws it after an ambiguous broadcast: signature + blockhash attached. */
  const inFlightErr = (sig: string) => Object.assign(new Error(BLOCKHASH), { signature: sig, blockhash: "BH".padEnd(44, "1") });
  beforeEach(() => {
    mocks.ambiguous.mockReset();
  });

  it("the tx lands AFTER the first status check (the live read would still show the position): no resend, closed", async () => {
    mocks.ambiguous.mockImplementation(async () => {
      setChain(flatPortfolio()); // it landed while we waited
      return "landed";
    });
    mocks.script.push(() => { throw inFlightErr(SIG1); });
    const { thrown } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).toBeNull();
    expect(mocks.ambiguous).toHaveBeenCalledWith(expect.anything(), SIG1, "BH".padEnd(44, "1"));
    expect(sent).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledWith("Position closed.", "success");
  });

  it("it provably expired without landing: the resend goes ahead, sized from the live position", async () => {
    mocks.ambiguous.mockResolvedValue("not-landed");
    mocks.script.push(() => { throw inFlightErr(SIG1); });
    await close(100, { portfolioPk: LONG_PK });
    expect(sent).toHaveLength(2);
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -LONG_BASIS]);
  });

  it("undecidable (still pending / RPC down): nothing more is sent", async () => {
    mocks.ambiguous.mockResolvedValue("unknown");
    mocks.script.push(() => { throw inFlightErr(SIG1); });
    const { thrown, error } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(error).toMatch(/nothing more was sent/);
  });

  it("no blockhash known (a message-only signature): today's path, no wait", async () => {
    mocks.script.push(() => { throw new Error(BLOCKHASH); });
    await close(100, { portfolioPk: LONG_PK });
    expect(mocks.ambiguous).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
  });
});
