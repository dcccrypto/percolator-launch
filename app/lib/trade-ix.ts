/**
 * The v18 TradeCpi instruction(s), extracted from hooks/useTrade.ts so the
 * first-trade flow (UX WP-6: [Deposit, Trade] against a portfolio that does not exist yet when
 * the tx is signed) builds the byte-identical instruction with a PREDICTED taker identity.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { encodeTradeCpi, ACCOUNTS_TRADE_CPI, buildAccountMetas, buildIx } from "@percolatorct/sdk";
import { tradeFeeBpsToSign } from "@/lib/limits/fee-channel";
import { withLevGuardTail } from "@/lib/v22/lev-guard";

export interface TradeIdentity {
  portfolioId: bigint;
  positionEpoch: bigint;
}

export interface TradeCpiIxParams {
  programId: PublicKey;
  signer: PublicKey;
  market: PublicKey;
  accountA: PublicKey;
  accountB: PublicKey;
  matcherProg: PublicKey;
  matcherCtx: PublicKey;
  matcherDelegate: PublicKey;
  takerId: TradeIdentity;
  lpId: TradeIdentity & { matcherSequence: bigint };
  marketId: bigint;
  /** Legs (sum = size); each becomes its own single-leg TradeCpi (see buildTradeIxs). */
  legs: bigint[];
  size: bigint;
  limitPriceE6: bigint;
  /** The P2 signed fee cap, when the channel is on. */
  feeBps?: bigint;
  /** The market's configured trade fee (wrapperConfigV17.tradeFeeBps). */
  marketTradeFeeBps?: bigint;
  /**
   * v2.2: the market has its leverage guard account (lib/v22/lev-guard.ts levGuardExists). Each TradeCpi then carries the guard as its
   * LAST account (the program strips it); without it an opening trade on a guarded market fails Custom(132). Absent / false = the
   * instruction is byte-identical to before.
   */
  levGuard?: boolean;
}

/**
 * F-2 (live SDK tests 2026-10-01): `BatchTradeCpi`'s `max_slippage_atoms` / `max_fee_atoms` are
 * HARD caps on the batch's aggregate adverse slippage (quote atoms, each leg's exec price vs its
 * oracle price) and aggregate taker fee; 0/0 refuses every fill (Custom 9). Caps for a batch the
 * taker signed with per-leg `limitPriceE6`: slippage = sum |q| * |limit - mark| / 1e6 (the most the
 * per-leg limits already allow); fee = sum |q| * worst price * feeBps / 1e4, where the worst price
 * is max(limit, mark) raised by the fallback slippage margin (the charged fee moves with the
 * price the engine values the fill at: pricing it at the app's mark left ~1 atom of headroom and
 * failed Custom 9 on a one-tick move in devnet sims, QA of #2731). Rounded up, +1 atom/leg.
 * With no limit (0) the slippage budget falls back to `fallbackSlippageBps` of notional.
 */
export function batchTradeCaps(p: {
  legs: Array<{ sizeQ: bigint; limitPriceE6: bigint; markE6: bigint }>;
  feeBps: bigint;
  fallbackSlippageBps?: bigint;
}): { maxSlippageAtoms: bigint; maxFeeAtoms: bigint } {
  const fallback = p.fallbackSlippageBps ?? 500n;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  let slip = 0n;
  let fee = 0n;
  for (const l of p.legs) {
    const q = abs(l.sizeQ);
    const mark = l.markE6 > 0n ? l.markE6 : 0n;
    const notional = ceilDiv(q * mark, 1_000_000n);
    slip += l.limitPriceE6 > 0n && mark > 0n ? ceilDiv(q * abs(l.limitPriceE6 - mark), 1_000_000n) + 1n : ceilDiv(notional * fallback, 10_000n) + 1n;
    const worst = l.limitPriceE6 > mark ? l.limitPriceE6 : mark;
    const feeNotional = ceilDiv(q * ceilDiv(worst * (10_000n + fallback), 10_000n), 1_000_000n);
    fee += ceilDiv(feeNotional * (p.feeBps > 0n ? p.feeBps : 0n), 10_000n) + 1n;
  }
  return { maxSlippageAtoms: slip, maxFeeAtoms: fee };
}

/** One TradeCpi (tag 10) for `sizeQ`, bound to both portfolios' identity (v18 wire). */
function tradeCpiIx(p: TradeCpiIxParams, sizeQ: bigint, fee: bigint): TransactionInstruction {
  const ix = buildIx({
    programId: p.programId,
    keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      p.signer, // [0] signerA
      p.market, // [1] market
      p.accountA, // [2] accountA (taker portfolio)
      p.accountB, // [3] accountB (LP portfolio)
      p.matcherProg, // [4] matcherProg
      p.matcherCtx, // [5] matcherCtx
      p.matcherDelegate, // [6] matcherDelegate
    ]),
    data: encodeTradeCpi({
      accountAPortfolioId: p.takerId.portfolioId,
      accountAPositionEpoch: p.takerId.positionEpoch,
      accountBPortfolioId: p.lpId.portfolioId,
      accountBPositionEpoch: p.lpId.positionEpoch,
      accountBMatcherSequence: p.lpId.matcherSequence,
      assetIndex: 0,
      marketId: p.marketId,
      sizeQ: sizeQ.toString(),
      feeBps: fee,
      limitPrice: p.limitPriceE6.toString(),
      backingFeeCapBps: 0,
    }),
  });
  return withLevGuardTail(ix, p.market, p.levGuard === true);
}

/**
 * The trade instructions for `legs` (sum = size). Every leg is on asset 0, and the wrapper allows
 * ONE leg per asset in a BatchTradeCpi (a second same-asset leg is InvalidInstruction, Custom 9:
 * live SDK tests M-1). So a size over the matcher's per-fill cap becomes SEVERAL single-leg
 * TradeCpi instructions in ONE transaction (one signature; each is its own matcher call and
 * respects the per-fill cap). v18 identity: TradeCpi reads but does not advance accountB's
 * matcher sequence, and the taker's position epoch only moves on a position episode; the
 * pre-sign simulation of the whole transaction is the guard either way.
 */
export function buildTradeIxs(p: TradeCpiIxParams): TransactionInstruction[] {
  const fee = tradeFeeBpsToSign(p.feeBps, p.marketTradeFeeBps);
  const legs = p.legs.length > 0 ? p.legs : [p.size];
  return legs.map((q) => tradeCpiIx(p, q, fee));
}

/** A single TradeCpi (first-trade flow). Refuses a multi-leg split (use buildTradeIxs). */
export function buildTradeCpiIx(p: TradeCpiIxParams): TransactionInstruction {
  const ixs = buildTradeIxs(p);
  if (ixs.length !== 1) throw new Error("buildTradeCpiIx builds one leg; use buildTradeIxs for a split order");
  return ixs[0];
}
