/**
 * Delta review MED-A (hook level, fund-and-trade: first trade AND returning user): a confirmed order signs the same chain cap as before, is
 * never silently re-signed at a raised cap on a 98, and has its busy-side rate re-read right before the wallet (`preSignCheck` handed to
 * sendTx): higher than confirmed => refused. Harness from useFirstTrade.fill-result.test.ts (sendTx is the mock: the test runs the check).
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
const signedFees: Array<bigint | undefined> = [];
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
    buildFundAndTradeIxs: (p: { portfolio: PublicKey; feeBps?: bigint }) => { signedFees.push(p.feeBps); return [ix(3, p.portfolio), ix(10, p.portfolio)]; },
  };
});
// The ADL-effective reads need a market account; stub them and keep the real sig registry.
const readBeforeTrade = vi.fn(async () => chain.beforeQ as bigint | null);
const measurePositionChange = vi.fn(async (_c: unknown, _p: PublicKey, _m: PublicKey, _s: string, beforeQ: bigint | null) =>
  beforeQ === null ? null : { beforeQ, afterQ: chain.afterQ },
);
vi.mock("@/lib/position-change", async (orig) => ({
  ...(await orig<typeof import("@/lib/position-change")>()),
  readBeforeTrade: (...a: unknown[]) => readBeforeTrade(...(a as [])),
  measurePositionChange: (...a: Parameters<typeof measurePositionChange>) => measurePositionChange(...a),
}));
const fresh = vi.fn(async (..._a: unknown[]): Promise<bigint | null> => 99n);
vi.mock("@/lib/v22/fresh-busy-fee", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/fresh-busy-fee")>()), readFreshBusyFeeBps: (...a: unknown[]) => fresh(...a) }));
const fetchTradeFeeBps = vi.fn(async (..._a: unknown[]): Promise<bigint | undefined> => 135n);
vi.mock("@/lib/limits/trade-fee-resolve", async (orig) => ({ ...(await orig<typeof import("@/lib/limits/trade-fee-resolve")>()), fetchTradeFeeBps: (...a: unknown[]) => fetchTradeFeeBps(...a) }));
vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/flag")>()), isDevnetV22Enabled: () => true }));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  sendTx: (...a: unknown[]) => sendTx(...a),
}));

import { useFirstTrade } from "@/hooks/useFirstTrade";
import { FeeChangedAfterReviewError } from "@/lib/limits/trade-fee-resolve";
import { BusyFeeRoseError } from "@/lib/v22/fresh-busy-fee";

const GUARD = { confirmedBusyFeeBps: 99n, direction: "long" as const, takerEffQ: 0n, sizeQ: 1_000_000n };
async function run(o: Record<string, unknown>) {
  const { result } = renderHook(() => useFirstTrade(Keypair.generate().publicKey.toBase58()));
  let sig: string | null = null; let err: unknown = null;
  await act(async () => {
    await result.current.fundAndTrade({ size: 1_000_000n, depositAtoms: 55_060_000n, limitPriceE6: 127_659_537n, amountLabel: "55.06 USDC", feeBps: 55n, ...o } as never)
      .then((r) => { sig = r.signature; }, (e) => { err = e; });
  });
  return { sig, err };
}
const refusal = (code: number) => Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`), { code });
const preSign = () => (sendTx.mock.calls[0][0] as { preSignCheck?: () => Promise<void> }).preSignCheck;

describe("useFirstTrade: a confirmed order signs the chain cap, never silently raises it, and re-reads the busy-side fee before signing", () => {
  beforeEach(() => {
    sendTx.mockReset();
    signedFees.length = 0;
    fetchTradeFeeBps.mockReset();
    fetchTradeFeeBps.mockResolvedValue(135n);
    fresh.mockReset();
    fresh.mockResolvedValue(99n);
    findV17Portfolio.mockReset();
    findV17Portfolio.mockResolvedValue(null);
    chain.beforeQ = 0n;
    chain.afterQ = 0n;
  });
  for (const [name, existing] of [["first trade (new account)", false], ["returning user (account exists)", true]] as const) {
    describe(name, () => {
      beforeEach(() => { if (existing) findV17Portfolio.mockResolvedValue(Keypair.generate().publicKey); });
      it("signs the chain cap (135) exactly as before, confirmed or not", async () => {
        sendTx.mockResolvedValue("sigOk");
        await run({ confirmedFeeCap: true, busyGuard: GUARD });
        await run({});
        expect(signedFees).toEqual([135n, 135n]);
      });
      it("a confirmed order hands sendTx a preSignCheck; an unconfirmed one does not", async () => {
        sendTx.mockResolvedValue("sigOk");
        await run({ confirmedFeeCap: true, busyGuard: GUARD });
        expect(typeof preSign()).toBe("function");
        sendTx.mockClear();
        await run({});
        expect(preSign()).toBeUndefined();
      });
      it("honest f8-like numbers (matcher moved, busy-side rate unchanged): NOT refused", async () => {
        sendTx.mockResolvedValue("sigOk");
        const { sig, err } = await run({ confirmedFeeCap: true, busyGuard: GUARD });
        expect(err).toBeNull();
        expect(sig).toBe("sigOk");
        await expect(preSign()!()).resolves.toBeUndefined();
      });
      it("busy-side rate rose after the confirm: refused with the busy-side line (nothing signed)", async () => {
        sendTx.mockResolvedValue("sigOk");
        await run({ confirmedFeeCap: true, busyGuard: GUARD });
        fresh.mockResolvedValue(106n);
        await expect(preSign()!()).rejects.toBeInstanceOf(BusyFeeRoseError);
      });
      it("equal / lower / unreadable: proceeds", async () => {
        sendTx.mockResolvedValue("sigOk");
        await run({ confirmedFeeCap: true, busyGuard: GUARD });
        for (const v of [99n, 10n, null]) { fresh.mockResolvedValue(v); await expect(preSign()!()).resolves.toBeUndefined(); }
      });
      it("confirmed + 98: one send, no raise (no util-max read), generic line when no busy-side rise is shown", async () => {
        sendTx.mockRejectedValue(refusal(98));
        const { err } = await run({ confirmedFeeCap: true, busyGuard: GUARD });
        expect(err).toBeInstanceOf(FeeChangedAfterReviewError);
        expect((err as Error).message).toBe("The fee changed while you were reviewing. Review it again. Nothing was charged.");
        expect(sendTx).toHaveBeenCalledTimes(1);
        expect(signedFees).toEqual([135n]);
        expect(fetchTradeFeeBps.mock.calls.some((c) => (c[3] as { withUtilMax?: boolean } | undefined)?.withUtilMax)).toBe(false);
      });
      it("confirmed + 98 and the fresh read shows the busy-side rate rose: the busy-side line", async () => {
        sendTx.mockRejectedValue(refusal(98));
        fresh.mockResolvedValue(130n);
        const { err } = await run({ confirmedFeeCap: true, busyGuard: GUARD });
        expect(err).toBeInstanceOf(BusyFeeRoseError);
        expect(sendTx).toHaveBeenCalledTimes(1);
      });
      it("confirmed + Custom 9: not remapped (the original error surfaces for the existing diagnosis)", async () => {
        const e9 = refusal(9);
        sendTx.mockRejectedValue(e9);
        const { err } = await run({ confirmedFeeCap: true, busyGuard: GUARD });
        expect(err).toBe(e9);
      });
    });
  }
  it("control (no confirm screen) + 98: the silent raise stands (two sends)", async () => {
    fetchTradeFeeBps.mockImplementation(async (...a: unknown[]) => ((a[3] as { withUtilMax?: boolean }).withUtilMax ? 400n : 135n));
    sendTx.mockRejectedValueOnce(refusal(98)).mockResolvedValue("sigRaised");
    const { sig } = await run({});
    expect(sig).toBe("sigRaised");
    expect(sendTx).toHaveBeenCalledTimes(2);
    expect(signedFees).toEqual([135n, 400n]);
  });
});
