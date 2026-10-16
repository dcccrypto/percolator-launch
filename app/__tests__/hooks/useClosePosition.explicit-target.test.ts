/**
 * #3301: Close on a row must act on THAT row's portfolio account.
 *
 * The real useClosePosition + the real useTrade run end to end against real v18 bytes (the captured
 * trader portfolio DAC2a44p, patched into three accounts of one wallet on one market, and the
 * captured ANSEM market). Only the network edge is stubbed: the connection, the LP resolver, the
 * wire identity reads and the transaction sender, which records the instructions it is handed so
 * the tests can read the account keys of the TradeCpi that would be signed.
 *
 * Scenario from the issue: the wallet owns SHORT 10 (the lowest pubkey, so the one the old code
 * resolved), LONG 40, and a flat account. Close on the LONG row used to read the SHORT, send a buy
 * of 10 and report success.
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

// Deterministic, ordered pubkeys: SHORT_PK < LONG_PK < FLAT_PK in base58 order.
const sortedKeys = Array.from({ length: 3 }, (_, i) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey)
  .sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
const [SHORT_PK, LONG_PK, FLAT_PK] = sortedKeys;
const SHORT_BASIS = 10_000_000n;
const LONG_BASIS = 40_000_000n;

const chain = new Map<string, { owner: PublicKey; data: Buffer }>();
const sent: Array<{ instructions: Array<{ keys: Array<{ pubkey: PublicKey }>; data: Buffer }> }> = [];
const tradeIxParams: Array<{ accountA: PublicKey; size: bigint }> = [];

const mocks = vi.hoisted(() => ({ withdraw: vi.fn(), sweepReads: vi.fn() }));

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
const connection = { getAccountInfo, getProgramAccounts, getMultipleAccountsInfo: vi.fn(async () => []) };

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
  useWalletCompat: () => ({ publicKey: OWNER, connected: true, signTransaction: vi.fn() }),
}));
// The canonical account the market shows by default (lowest pubkey) is the SHORT.
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({ idx: 0, pubkey: SHORT_PK, account: { positionSize: -SHORT_BASIS } }),
}));
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

describe("useClosePosition { portfolioPk } (#3301)", () => {
  it("the fixture is what the tests say it is: SHORT is the lowest pubkey, so the old resolution picks it", () => {
    expect(SHORT_PK.toBase58() < LONG_PK.toBase58()).toBe(true);
    expect(LONG_PK.toBase58() < FLAT_PK.toBase58()).toBe(true);
  });

  it("two owned portfolios on one slab: Close 100% on the LONG row builds the trade on the LONG account with the LONG's size", async () => {
    const { r, thrown } = await close(100, { portfolioPk: LONG_PK });
    expect(thrown).toBeNull();
    expect((r as { signature: string }).signature).toMatch(/^SIG-/);
    expect(sent).toHaveLength(1);
    // TradeCpi key 2 is accountA, the taker's portfolio: the account the row showed.
    expect(tradeKeysOfLastSend()[2]).toBe(LONG_PK.toBase58());
    expect(tradeKeysOfLastSend()).not.toContain(SHORT_PK.toBase58());
    // A close of LONG 40 sells 40 (negative), it does not buy the SHORT's 10.
    expect(tradeIxParams[0].accountA.equals(LONG_PK)).toBe(true);
    expect(tradeIxParams[0].size).toBe(-LONG_BASIS);
  });

  it("the percent is of the targeted account's leg: 50% of LONG 40 sells 20", async () => {
    await close(50, { portfolioPk: LONG_PK });
    expect(tradeKeysOfLastSend()[2]).toBe(LONG_PK.toBase58());
    expect(tradeIxParams[0].size).toBe(-LONG_BASIS / 2n);
  });

  it("Close on the SHORT row buys the SHORT's size on the SHORT account", async () => {
    await close(100, { portfolioPk: SHORT_PK });
    expect(tradeKeysOfLastSend()[2]).toBe(SHORT_PK.toBase58());
    expect(tradeIxParams[0].size).toBe(SHORT_BASIS);
  });

  it("reads exactly the named account and never scans the wallet's portfolios", async () => {
    await close(100, { portfolioPk: LONG_PK });
    const read = getAccountInfo.mock.calls.map((c) => (c[0] as PublicKey).toBase58());
    expect(read).toContain(LONG_PK.toBase58());
    expect(read).not.toContain(SHORT_PK.toBase58());
    expect(getProgramAccounts).not.toHaveBeenCalled();
  });

  it("the full-close sweep withdraws from the closed account only, strictly, and reads that account", async () => {
    await close(100, { portfolioPk: LONG_PK });
    await vi.waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1));
    const arg = mocks.withdraw.mock.calls[0][0] as { portfolioPk: PublicKey; strictPortfolio: boolean };
    expect(arg.portfolioPk.equals(LONG_PK)).toBe(true);
    expect(arg.strictPortfolio).toBe(true);
    expect(mocks.sweepReads).toHaveBeenCalledTimes(1);
  });

  it("a flat target is an error the user sees; nothing is sent and the other account is untouched", async () => {
    const { r, thrown, error } = await close(100, { portfolioPk: FLAT_PK });
    expect(r).toBeNull();
    expect((thrown as Error).message).toBe(TARGET_COPY.flat);
    expect(error).toBe(TARGET_COPY.flat);
    expect(sent).toHaveLength(0);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("a flat target is refused even though ANOTHER owned account has a position (no silent redirect)", async () => {
    // The old code resolved the SHORT here, sent a buy of 10, and reported success.
    const { thrown } = await close(100, { portfolioPk: FLAT_PK });
    expect(thrown).toBeInstanceOf(Error);
    expect(tradeIxParams).toHaveLength(0);
  });

  it("a target owned by another wallet is refused", async () => {
    seed({ [LONG_PK.toBase58()]: { data: portfolio({ side: 0, basis: LONG_BASIS, owner: Keypair.generate().publicKey }) } });
    const { thrown, error } = await close(100, { portfolioPk: LONG_PK });
    expect((thrown as Error).message).toBe(TARGET_COPY.unmatched);
    expect(error).toBe(TARGET_COPY.unmatched);
    expect(sent).toHaveLength(0);
  });

  it("a target on a different market is refused", async () => {
    seed({ [LONG_PK.toBase58()]: { data: portfolio({ side: 0, basis: LONG_BASIS, market: Keypair.generate().publicKey }) } });
    const { thrown } = await close(100, { portfolioPk: LONG_PK });
    expect((thrown as Error).message).toBe(TARGET_COPY.unmatched);
    expect(sent).toHaveLength(0);
  });

  it("a target not owned by the market program is refused", async () => {
    seed({ [LONG_PK.toBase58()]: { data: portfolio({ side: 0, basis: LONG_BASIS }), owner: Keypair.generate().publicKey } });
    const { thrown } = await close(100, { portfolioPk: LONG_PK });
    expect((thrown as Error).message).toBe(TARGET_COPY.unmatched);
    expect(sent).toHaveLength(0);
  });

  it("a target that does not exist is refused, with no fallback scan", async () => {
    seed({ [SHORT_PK.toBase58()]: { data: portfolio({ side: 1, basis: SHORT_BASIS }) } });
    const { thrown } = await close(100, { portfolioPk: LONG_PK });
    expect((thrown as Error).message).toBe(TARGET_COPY.unmatched);
    expect(getProgramAccounts).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("a reused read of one account never serves another (cache is per target)", async () => {
    await close(50, { portfolioPk: SHORT_PK });
    await close(50, { portfolioPk: LONG_PK }); // inside the 4 s read TTL
    expect(tradeIxParams.map((p) => p.size)).toEqual([SHORT_BASIS / 2n, -LONG_BASIS / 2n]);
    expect(tradeIxParams[1].accountA.equals(LONG_PK)).toBe(true);
  });

  it("no row (no target): the old resolution is kept, and a flat result is now an error instead of a silent success", async () => {
    seed({ [SHORT_PK.toBase58()]: { data: portfolio({ side: 1, basis: 0n, active: false }) } });
    const { r, thrown, error } = await close(100);
    expect(r).toBeNull();
    expect((thrown as Error).message).toBe(TARGET_COPY.flat);
    expect(error).toBe(TARGET_COPY.flat);
    expect(sent).toHaveLength(0);
  });

  it("no row (no target): with a position it still closes the wallet's default account", async () => {
    // The default read (no target) resolves through the shared scan; here it is the SHORT.
    seed({ [SHORT_PK.toBase58()]: { data: portfolio({ side: 1, basis: SHORT_BASIS }) } });
    await close(100);
    expect(tradeIxParams[0].accountA.equals(SHORT_PK)).toBe(true);
    expect(tradeIxParams[0].size).toBe(SHORT_BASIS);
  });
});
