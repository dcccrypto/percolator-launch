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

const WRAPPER = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const MARKET_ID = 1n;
const owner = Keypair.generate().publicKey;
const sendTx = vi.fn();
const findV17Portfolio = vi.fn();

/** Portfolio bytes with one asset-0 leg of signed size `q` (0 = no leg). */
function portfolioWithPosition(q: bigint): Buffer {
  const d = new Uint8Array(9563);
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
  }),
}));
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
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  sendTx: (...a: unknown[]) => sendTx(...a),
}));

import { useFirstTrade } from "@/hooks/useFirstTrade";
import { takeFillResult } from "@/lib/limits/fill-check";
import { fmtQ } from "@/lib/limits/format";

async function fundAndTrade(size: bigint) {
  const { result } = renderHook(() => useFirstTrade(Keypair.generate().publicKey.toBase58()));
  let sig = "";
  await act(async () => {
    sig = (await result.current.fundAndTrade({ size, depositAtoms: 55_060_000n, limitPriceE6: 127_659_537n, amountLabel: "55.06 USDC" })).signature;
  });
  return sig;
}

describe("useFirstTrade records the MEASURED fill for the ticket", () => {
  beforeEach(() => {
    sendTx.mockReset();
    findV17Portfolio.mockReset();
    findV17Portfolio.mockResolvedValue(null);
    getAccountInfo.mockClear();
    chain.beforeQ = 0n;
    chain.afterQ = 0n;
  });

  it("first trade (new account): a 0.8225 SOL order that landed as 72 q is a PARTIAL fill of 72", async () => {
    sendTx.mockResolvedValue("sigFirst");
    chain.afterQ = 72n;
    const sig = await fundAndTrade(822_500n);
    expect(sig).toBe("sigFirst");
    expect(takeFillResult(sig)).toEqual({ kind: "partial", filledQ: 72n });
    // the post-trade read is pinned to the tx's slot so a cached pre-trade read can't answer
    expect(getAccountInfo).toHaveBeenCalledWith(expect.any(PublicKey), { commitment: "confirmed", minContextSlot: chain.slot });
  });

  it("returning user ([deposit, trade]): the delta is measured from the position held before", async () => {
    findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey);
    sendTx.mockResolvedValue("sigFund");
    chain.beforeQ = 1_000_000n;
    chain.afterQ = 1_000_072n;
    const sig = await fundAndTrade(822_500n);
    expect(takeFillResult(sig)).toEqual({ kind: "partial", filledQ: 72n });
  });

  it("#49: both sends report the broadcast through onProgress", async () => {
    const onConfirming = vi.fn();
    const run = async () => {
      const { result } = renderHook(() => useFirstTrade(Keypair.generate().publicKey.toBase58()));
      await act(async () => {
        await result.current.fundAndTrade({ size: 822_500n, depositAtoms: 55_060_000n, limitPriceE6: 127_659_537n, amountLabel: "55.06 USDC", onConfirming });
      });
    };
    sendTx.mockResolvedValue("sigFirst");
    await run(); // new account: [create, init, deposit, trade]
    findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey);
    await run(); // returning user: [deposit, trade]
    expect(sendTx).toHaveBeenCalledTimes(2);
    for (const [arg] of sendTx.mock.calls) expect(arg).toEqual(expect.objectContaining({ onProgress: onConfirming }));
  });

  it("a full fill is still reported as full", async () => {
    sendTx.mockResolvedValue("sigFull");
    chain.afterQ = 822_500n;
    const sig = await fundAndTrade(822_500n);
    expect(takeFillResult(sig)).toEqual({ kind: "full", filledQ: 822_500n });
  });

  it("a zero fill (no room at all) is reported as zero, never as Opened", async () => {
    sendTx.mockResolvedValue("sigZero");
    chain.afterQ = 0n;
    const sig = await fundAndTrade(822_500n);
    expect(takeFillResult(sig)).toEqual({ kind: "zero", filledQ: 0n });
  });
});

describe("fmtQ: a non-zero size below the 4 dp shown never reads as 0", () => {
  it("72 q is <0.0001, not 0", () => {
    expect(fmtQ(72n)).toBe("<0.0001");
    expect(fmtQ(-72n)).toBe("−<0.0001");
  });
  it("unchanged elsewhere", () => {
    expect(fmtQ(0n)).toBe("0");
    expect(fmtQ(100n)).toBe("0.0001");
    expect(fmtQ(822_500n)).toBe("0.8225");
    expect(fmtQ(12_400_000n)).toBe("12.4");
  });
});
