/** Council r10 recheck D1: the opening transaction carries the funding memo (lib/funding-memo.ts) on the first-trade paths. */
/**
 * A confirmed fund-and-trade is not proof the requested size filled. The matcher clips an order
 * to the LP's inventory room and TradeCpi still returns Ok. Live devnet 2026-10-04 (SOL/USD
 * 9efj3hdg..., tx 5Jy8aZEd...): a 2x $100 LONG requested sizeQ 822_500 (0.8225 SOL); the LP's
 * matcher had inventory_base -16_695_812 against max_inventory_abs 16_695_884 (72 q of long
 * room), so the leg landed with basis_pos_q 72 (0.000072 SOL). The ticket still said
 * "Opened 0.8225 SOL long at $121.58", because useFirstTrade never measured the fill and the
 * ticket treats "no fill result" as a full fill.
 *
 * useFirstTrade now measures the position delta (lib/limits/fill-check.ts measureFill, the same
 * slot-pinned read useTrade uses) and records it for the ticket's takeFillResult(sig).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { blankPortfolio } from "../helpers/v22-fixtures";

const WRAPPER = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const MARKET_ID = 1n;
const owner = Keypair.generate().publicKey;
const sendTx = vi.fn();
const findV17Portfolio = vi.fn();

/** Portfolio bytes with one asset-0 leg of signed size `q` (0 = no leg). */
function portfolioWithPosition(q: bigint): Buffer {
  const d = new Uint8Array(blankPortfolio()); // the ACTIVE layout (9,563 B v18 flag off, 10,603 B VERSION 19 flag on); leg fields up to the basis do not move
  const dv = new DataView(d.buffer);
  const l = C.PF_LEGS;
  if (q !== 0n) {
    d[l + C.LEG_ACTIVE] = 1;
    dv.setUint32(l + C.LEG_ASSET_INDEX, 0, true);
    dv.setBigUint64(l + C.LEG_MARKET_ID, MARKET_ID, true);
    d[l + C.LEG_SIDE] = q > 0n ? 0 : 1;
    const mag = q < 0n ? -q : q;
    dv.setBigUint64(l + C.LEG_BASIS_POS_Q, mag & 0xffff_ffff_ffff_ffffn, true);
    dv.setBigUint64(l + C.LEG_BASIS_POS_Q + 8, mag >> 64n, true);
  }
  return Buffer.from(d);
}

/** Position the taker's portfolio holds before / after the trade (the slot-pinned read). */
const chain = { beforeQ: 0n, afterQ: 0n, slot: 507_467_779 };
const getAccountInfo = vi.fn(async (_pk: PublicKey, opts?: unknown) => {
  const pinned = typeof opts === "object" && opts !== null && "minContextSlot" in opts;
  return { data: portfolioWithPosition(pinned ? chain.afterQ : chain.beforeQ) };
});
const getSignatureStatuses = vi.fn(async () => ({ value: [{ slot: chain.slot }] }));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: owner, signAllTransactions: vi.fn(), signTransaction: vi.fn() }),
  useConnectionCompat: () => ({
    connection: {
      getAccountInfo: (...a: [PublicKey, unknown?]) => getAccountInfo(...a),
      getSignatureStatuses: () => getSignatureStatuses(),
      getMinimumBalanceForRentExemption: vi.fn(async () => 1_000_000),
    },
  }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: { collateralMint: Keypair.generate().publicKey },
    programId: WRAPPER,
    wrapperConfigV17: { tradeFeeBps: 5n },
    refresh: vi.fn(),
    raw: new Uint8Array(16),
  }),
}));
// v2.2 on, a single-asset market: the order goes through the memo path.
// The 121 peer refresh: the order is rebuilt from its body with a peer crank in front (lib/v22/trade-refresh-wire.ts).
vi.mock("@/lib/v21/loss-stale-retry", async (orig) => ({ ...(await orig<typeof import("@/lib/v21/loss-stale-retry")>()), isLossStaleError: (e: unknown) => String(e).includes("LOSS_STALE_121"), lossStaleHandlingEnabled: () => false }));
vi.mock("@/lib/v22/trade-refresh-wire", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-refresh-wire")>()),
  planTradeRefresh: async (_c: unknown, input: { body: import("@solana/web3.js").TransactionInstruction[] }) => ({ cranks: [{ role: "peer" }], instructions: [peerCrank, ...input.body] }),
  sendWithRefreshRetry: async (plan: () => Promise<import("@solana/web3.js").TransactionInstruction[]>, send: (ixs: import("@solana/web3.js").TransactionInstruction[]) => Promise<string>) => send(await plan()),
}));
const peerCrank = new (require("@solana/web3.js").TransactionInstruction)({ programId: new (require("@solana/web3.js").PublicKey)(new Uint8Array(32).fill(99)), keys: [], data: Buffer.from([1]) });
vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/flag")>()), isDevnetV22Enabled: () => true }));
vi.mock("@/lib/v22/trade-refresh", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/trade-refresh")>()), marketAssetSlots: () => 1 }));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  getAta: vi.fn(async () => Keypair.generate().publicKey),
  deriveVaultAuthority: vi.fn(() => [Keypair.generate().publicKey, 255]),
}));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: vi.fn() }));
vi.mock("@/lib/deposit-guard", () => ({ assertDepositWithinBalance: vi.fn() }));
vi.mock("@/lib/v18-wire", () => ({
  fetchAssetMarketId: vi.fn(async () => MARKET_ID),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 7n, matcherSequence: 3n, positionEpoch: 1n })),
}));
vi.mock("@/hooks/useTrade", () => ({
  findV17Portfolio: (...a: unknown[]) => findV17Portfolio(...a),
  resolveLpTradeAccounts: vi.fn(async () => ({
    accountB: Keypair.generate().publicKey,
    matcherProg: Keypair.generate().publicKey,
    matcherCtx: Keypair.generate().publicKey,
    matcherDelegate: Keypair.generate().publicKey,
  })),
}));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/first-trade", async (orig) => {
  const real = await orig<typeof import("@/lib/first-trade")>();
  const ix = (tag: number, k: PublicKey) =>
    new TransactionInstruction({ programId: WRAPPER, keys: [{ pubkey: k, isSigner: false, isWritable: true }], data: Buffer.from([tag]) });
  return {
    ...real,
    readNextPortfolioId: () => 2n,
    buildFirstTradeInitIxs: (p: { portfolio: PublicKey }) => [ix(1, p.portfolio), ix(2, p.portfolio)],
    buildFundAndTradeIxs: (p: { portfolio: PublicKey }) => [ix(3, p.portfolio), ix(10, p.portfolio)],
  };
});
// The ADL-effective reads need a market account; stub them and keep the real sig registry.
const before = { value: null as { q: bigint; funding: { netPaid: bigint; legs: number } | null } | null };
const readBeforeTrade = vi.fn(async () => chain.beforeQ as bigint | null);
const measurePositionChange = vi.fn(async (_c: unknown, _p: PublicKey, _m: PublicKey, _s: string, beforeQ: bigint | null) =>
  beforeQ === null ? null : { beforeQ, afterQ: chain.afterQ },
);
vi.mock("@/lib/position-change", async (orig) => ({
  ...(await orig<typeof import("@/lib/position-change")>()),
  readBeforeTrade: (...a: unknown[]) => readBeforeTrade(...(a as [])),
  readBeforeTradeFull: async () => before.value,
  measurePositionChange: (...a: Parameters<typeof measurePositionChange>) => measurePositionChange(...a),
}));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  sendTx: (...a: unknown[]) => sendTx(...a),
}));

import { useFirstTrade } from "@/hooks/useFirstTrade";
import { MEMO_PROGRAM_ID, memoBaseFor } from "@/lib/funding-memo";

const memoOf = (call: unknown[]) => {
  const ixs = (call[0] as { instructions: TransactionInstruction[] }).instructions;
  const m = ixs.filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID));
  return m.length === 0 ? null : m.map((ix) => Buffer.from(ix.data).toString("utf8"));
};
async function fundAndTrade(size: bigint) {
  const { result } = renderHook(() => useFirstTrade(Keypair.generate().publicKey.toBase58()));
  let sig = "";
  await act(async () => {
    sig = (await result.current.fundAndTrade({ size, depositAtoms: 55_060_000n, limitPriceE6: 127_659_537n, amountLabel: "55.06 USDC" })).signature;
  });
  return sig;
}

describe("useFirstTrade: the funding memo on an open from flat", () => {
  beforeEach(() => {
    sendTx.mockReset();
    findV17Portfolio.mockReset();
    chain.beforeQ = 0n;
    chain.afterQ = 0n;
    before.value = null;
  });

  it("a new portfolio: [create, init, deposit, trade, memo 0], and the trading device notes the base for its own book", async () => {
    findV17Portfolio.mockResolvedValue(null);
    sendTx.mockResolvedValue("sigNew");
    chain.afterQ = 500n;
    await fundAndTrade(500n);
    expect(memoOf(sendTx.mock.calls[0])).toEqual(["perc:fb1:0"]);
    const ixs = (sendTx.mock.calls[0][0] as { instructions: TransactionInstruction[] }).instructions;
    expect(ixs[ixs.length - 1].programId.equals(MEMO_PROGRAM_ID)).toBe(true); // after the trade
    expect(memoBaseFor("sigNew")).toBe(0n);
  });

  it("a returning user, flat with no leg: the counter read before the trade", async () => {
    findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey);
    sendTx.mockResolvedValue("sigBack");
    before.value = { q: 0n, funding: { netPaid: 415_917n, legs: 0 } };
    chain.afterQ = 500n;
    await fundAndTrade(500n);
    expect(memoOf(sendTx.mock.calls[0])).toEqual(["perc:fb1:415917"]);
    expect(memoBaseFor("sigBack")).toBe(415_917n);
  });

  it("an add (already holding a leg) or an unread portfolio: no memo", async () => {
    findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey);
    sendTx.mockResolvedValue("sigAdd");
    before.value = { q: 300n, funding: { netPaid: 9n, legs: 1 } };
    chain.beforeQ = 300n;
    chain.afterQ = 800n;
    await fundAndTrade(500n);
    expect(memoOf(sendTx.mock.calls[0])).toBeNull();
    sendTx.mockReset();
    sendTx.mockResolvedValue("sigUnread");
    before.value = null;
    await fundAndTrade(500n);
    expect(memoOf(sendTx.mock.calls[0])).toBeNull();
  });
});

describe("useFirstTrade: the memo survives the 121 peer refresh", () => {
  it("refused 121 first: the rebuilt order (peer crank + body) still carries the memo", async () => {
    sendTx.mockReset();
    findV17Portfolio.mockReset();
    findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey);
    before.value = { q: 0n, funding: { netPaid: 442_997n, legs: 0 } };
    chain.beforeQ = 0n;
    chain.afterQ = 500n;
    sendTx.mockRejectedValueOnce(new Error("LOSS_STALE_121")).mockResolvedValueOnce("sigRefreshed");
    await fundAndTrade(500n);
    expect(sendTx).toHaveBeenCalledTimes(2);
    expect(memoOf(sendTx.mock.calls[1])).toEqual(["perc:fb1:442997"]);
    expect(memoBaseFor("sigRefreshed")).toBe(442_997n);
  });
});
