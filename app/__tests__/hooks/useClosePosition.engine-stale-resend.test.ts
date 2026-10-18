/**
 * AUD-APP-FLIP (ported to playground from v2.2 #3565): double-close safety on the close resend path.
 *
 * The close ix is a plain signed TradeCpi size with NO reduce-only flag. useClosePosition's withTransientRetry
 * rebuilt and resent the ORIGINAL closeSize after "Blockhash not found" / "block height exceeded" / "has expired";
 * if the first attempt actually landed, that resend OPENED the opposite side. Now, before any resend, the app
 * checks whether an earlier signature landed and re-sizes from the LIVE position (flat = done, flipped = refuse).
 *
 * The real useClosePosition + the real useTrade run end to end against real v18 bytes (harness from
 * useClosePosition.explicit-target.test.ts, #3301). Only the network edge is stubbed.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

const FX = join(__dirname, "..", "fixtures");
const b64 = (f: string) => Buffer.from(JSON.parse(readFileSync(join(FX, f), "utf8")).dataBase64, "base64");
const MARKET = new Uint8Array(b64("5bVTTMRc.ansem.market.json"));
const BASE = b64("DAC2a44p.portfolio.json");
const OWNER = new PublicKey(BASE.subarray(116, 148));
const SLAB = new PublicKey(BASE.subarray(16, 48)); // the market this portfolio belongs to
const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");

/** Fixture byte offsets of the first leg (probed against parsePortfolioV17). */
const LEG_ACTIVE = 356;
const LEG_SIDE = 369;
const LEG_BASIS = 370;
function portfolio(o: { side: 0 | 1; basis: bigint; active?: boolean; owner?: PublicKey; market?: PublicKey }): Buffer {
  const d = Buffer.from(BASE);
  d[LEG_ACTIVE] = o.active === false ? 0 : 1;
  d[LEG_SIDE] = o.side;
  d.writeBigUInt64LE(o.basis, LEG_BASIS);
  if (o.owner) o.owner.toBuffer().copy(d, 116);
  if (o.market) o.market.toBuffer().copy(d, 16);
  return d;
}

// Deterministic, ordered pubkeys: SHORT_PK < LONG_PK in base58 order (the canonical account is the SHORT).
const sortedKeys = Array.from({ length: 3 }, (_, i) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey)
  .sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
const [SHORT_PK, LONG_PK] = sortedKeys;
const SHORT_BASIS = 10_000_000n;
const LONG_BASIS = 40_000_000n;

const chain = new Map<string, { owner: PublicKey; data: Buffer }>();
const sent: Array<{ instructions: Array<{ keys: Array<{ pubkey: PublicKey }>; data: Buffer }> }> = [];
const tradeIxParams: Array<{ accountA: PublicKey; size: bigint }> = [];

const mocks = vi.hoisted(() => ({
  withdraw: vi.fn(),
  sweepReads: vi.fn(),
  toast: vi.fn(),
  script: [] as Array<() => void>,
  statuses: new Map<string, { err: unknown; confirmationStatus: string } | null>(),
}));

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
    // The scripted network outcome of THIS send (it may first move the chain: "the tx landed").
    mocks.script.shift()?.();
    return "SIG-" + sent.length;
  }),
  prewarmTxLanding: vi.fn(),
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

const SIG1 = "5".repeat(88); // a base58 signature shape
const TIMEOUT = `Confirmation timeout (60s) \u2014 tx may still land. Check explorer: ${SIG1}`;
const BLOCKHASH = "Blockhash not found";
const EXPIRED = `Signature ${SIG1} has expired: block height exceeded.`;
const STALE = `Transaction failed: {"InstructionError":[1,{"Custom":19}]}`;
const longPortfolio = (basis: bigint) => portfolio({ side: 0, basis });
const flatPortfolio = () => portfolio({ side: 0, basis: 0n, active: false });
const setChain = (data: Buffer) => chain.set(LONG_PK.toBase58(), { owner: PROGRAM, data });

async function close(percent: number) {
  const { result } = renderHook(() => useClosePosition(SLAB.toBase58()));
  let r: unknown = null;
  let thrown: unknown = null;
  await act(async () => {
    try {
      r = await result.current.closePosition(percent, { portfolioPk: LONG_PK });
    } catch (e) {
      thrown = e;
    }
  });
  return { r, thrown, error: result.current.error };
}

beforeEach(() => {
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

describe("AUD-APP-FLIP: a close is never resent at a stale size", () => {
  it("attempt 1 landed but the client saw an expired blockhash: the live read shows flat, nothing is traded again", async () => {
    mocks.script.push(() => { setChain(flatPortfolio()); throw new Error(BLOCKHASH); });
    const { r, thrown, error } = await close(100);
    expect(thrown).toBeNull();
    expect(error).toBeNull();
    expect(sent).toHaveLength(1); // no second, no third trade at the stale size
    expect(tradeIxParams).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledWith("Position closed.", "success");
    expect(r).not.toBeNull();
  });

  it("a 'Signature <sig> has expired' whose signature DID land: the status check wins, no further trade", async () => {
    mocks.statuses.set(SIG1, { err: null, confirmationStatus: "finalized" });
    mocks.script.push(() => { throw new Error(EXPIRED); });
    const { r, thrown } = await close(100);
    expect(thrown).toBeNull();
    expect(getSignatureStatuses).toHaveBeenCalledWith([SIG1], { searchTransactionHistory: true });
    expect(sent).toHaveLength(1);
    expect((r as { signature: string }).signature).toBe(SIG1);
    expect(mocks.toast).toHaveBeenCalledWith("Position closed.", "success");
  });

  it("an expired signature that provably did NOT land and an unchanged position: resent once at the same size", async () => {
    mocks.script.push(() => { throw new Error(EXPIRED); });
    const { thrown } = await close(100);
    expect(thrown).toBeNull();
    expect(getSignatureStatuses).toHaveBeenCalledWith([SIG1], { searchTransactionHistory: true });
    expect(sent).toHaveLength(2);
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -LONG_BASIS]);
  });

  it("a confirmation timeout is never resent at all (it may have landed): one trade", async () => {
    mocks.script.push(() => { throw new Error(TIMEOUT); });
    const { thrown } = await close(100);
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("attempt 1 did not land and the position is untouched: attempt 2 is sized from the live position", async () => {
    mocks.script.push(() => { throw new Error(BLOCKHASH); });
    await close(100);
    expect(sent).toHaveLength(2);
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -LONG_BASIS]);
  });

  it("attempt 1 landed PART of a full close: the resend sells only what is left, never the stale size", async () => {
    mocks.script.push(() => { setChain(longPortfolio(15_000_000n)); throw new Error(BLOCKHASH); });
    await close(100);
    expect(tradeIxParams.map((t) => t.size)).toEqual([-LONG_BASIS, -15_000_000n]);
  });

  it("a 50% close that already landed is not repeated: the live position is already at the intended final size", async () => {
    mocks.script.push(() => { setChain(longPortfolio(LONG_BASIS / 2n)); throw new Error(BLOCKHASH); });
    const { thrown } = await close(50);
    expect(thrown).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("a position that flipped to the other side is never traded again", async () => {
    mocks.script.push(() => { setChain(portfolio({ side: 1, basis: 5_000_000n })); throw new Error(BLOCKHASH); });
    const { thrown, error } = await close(100);
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(error).toMatch(/nothing more was sent/);
  });

  it("if the app cannot tell whether the first attempt landed, it does not resend", async () => {
    getSignatureStatuses.mockRejectedValueOnce(new Error("rpc down"));
    mocks.script.push(() => { throw new Error(EXPIRED); });
    const { thrown, error } = await close(100);
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(error).toMatch(/nothing more was sent/);
  });

  it("if the live position cannot be read before a resend, it does not resend", async () => {
    mocks.script.push(() => { chain.delete(LONG_PK.toBase58()); throw new Error(BLOCKHASH); });
    const { thrown, error } = await close(100);
    expect(thrown).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(error).toMatch(/nothing more was sent/);
  });

  it("a non-transient program error (EngineStale 19) is not resent", async () => {
    mocks.script.push(() => { throw new Error(STALE); });
    await close(100);
    expect(sent).toHaveLength(1);
  });
});
