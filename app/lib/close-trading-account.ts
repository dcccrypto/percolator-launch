/**
 * "Close trading account" (dcccrypto/percolator-launch#3426): a trader whose trading account (portfolio)
 * on a LIVE market is empty can close it and take the account rent back with the owner-signed
 * ClosePortfolio (tag 8) the wrapper already accepts. `lib/limits/own-portfolio-cleanup.ts` builds that
 * instruction for RESOLVED markets; this module reuses the same builder and adds the part a live market
 * needs: knowing, from the account bytes, whether the wrapper will accept it.
 *
 * On-chain rules mirrored (percolator-prog devnet/v22-fresh-ids 81ed7fdf, src/v16_program.rs):
 *   handle_close_portfolio  :19711  accounts [closer s,w][market w][portfolio w], both owned by the wrapper,
 *                                   portfolio at the market's exact account length (:19729, InvalidAccountLen);
 *   identity binding        :19747  portfolio_id + matcher_sequence + position_epoch must equal the live
 *                                   account (else EngineStale 19), so a close built while empty cannot land
 *                                   after a deposit / trade;
 *   authority               :19760/:19777  `portfolio.header.owner == closer` (the MUTABLE owner: an NFT-wrapped
 *                                   portfolio's owner is the escrow PDA, so the wallet cannot close it);
 *                                   anything else is Unauthorized 8 on a live market;
 *   emptiness               :19785  group.deregister_empty_materialized_portfolio_not_atomic -> engine
 *                                   `is_empty_for_dematerialization` (percolator v16.rs:6302 @ 3ce4cbd1);
 *                                   not empty is LockActive, mapped to EngineLockActive 21;
 *   rent                    :19793  `close_portfolio_account_to_market_slab(portfolio, closer)` (:42363)
 *                                   zeroes the account and moves ALL its lamports to the closer.
 * Engine emptiness = no active leg, capital 0, pnl 0, reserved pnl 0, fee credits 0, cancel-deposit escrow 0,
 * no stale / b-stale / rebalance / liquidation flag, close progress empty (or inert-canceled / finalized-inert),
 * no unfinalized resolved payout receipt, and no occupied source domain. There is no dust allowance: any
 * remaining collateral blocks it, and there is no market-mode requirement for the owner.
 *
 * The LP (matcher-enabled) portfolio is the market's counterparty book and is never offered here.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { UserFacingError } from "@/lib/errorMessages";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { readPortfolioIdentity } from "@/lib/v18-wire";
import { ownerClosePortfolioIx } from "@/lib/limits/own-portfolio-cleanup";
import { parsePortfolio, portfolioAccountLen, portfolioLegGeometry } from "@/lib/v22/layout";
import { rentSol } from "@/lib/rent";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { keepAppMessage, parseFailure, plainMessage } from "@/lib/limits/user-message";

/** Why a trading account cannot be closed right now. */
export type CloseRefusal =
  | "not-yours" // the mutable owner is not this wallet
  | "wrapped" // the wallet is the original owner but the account sits in a position NFT's escrow
  | "lp" // the market's liquidity (matcher-enabled) account
  | "has-balance" // capital, fee credits or a cancel-deposit escrow remain
  | "open-position" // an active leg
  | "unsettled" // pnl, a lock / stale flag, a close in progress, a payout receipt or a source claim remains
  | "unreadable"; // not a portfolio this build can decode

export type Closability = { closable: true } | { closable: false; reason: CloseRefusal };

/** The parsed portfolio shape this module reads (both layouts return it). */
export type ParsedPortfolio = ReturnType<typeof parsePortfolio>;

/** Calm one-liners per reason; the UI shows them where an action is refused. */
export const CLOSE_ACCOUNT_COPY = {
  line: (sol: string) => `This market's trading account is empty. Close it to get ~${sol} SOL back.`,
  button: "Close account",
  confirm: (sol: string, again: string) =>
    `You'll get the account rent (~${sol} SOL) back. Trading here again sets up a new account (~${again} SOL).`,
  confirmButton: "Close and get SOL back",
  cancel: "Keep it",
  working: "Closing...",
  done: (sol: string) => `Account closed. ~${sol} SOL is back in your wallet.`,
  refusals: {
    "not-yours": "This account isn't yours to close. Nothing was sent.",
    wrapped: "This account is held by a position NFT. Unwrap it first. Nothing was sent.",
    lp: "This is the market's liquidity account, so it can't be closed here. Nothing was sent.",
    "has-balance": "Withdraw your balance first, then you can close the account. Nothing was sent.",
    "open-position": "Close your position first, then you can close the account. Nothing was sent.",
    unsettled: "This account is still settling. Try again in a moment. Nothing was sent.",
    unreadable: "We couldn't read this account, so nothing was sent. Refresh and try again.",
  } satisfies Record<CloseRefusal, string>,
  /** The on-chain refusals that can still happen after our own checks (a race). */
  changed: "This account changed just now, so nothing was closed. Refresh and try again.",
  notEmpty: "This account isn't empty yet, so nothing was closed.",
} as const;

/** SOL text for a lamport amount ("0.0492"): 4 significant decimals, never a constant. */
export function lamportsToSolText(lamports: number | bigint): string {
  const n = Number(lamports) / 1_000_000_000;
  return n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
}

/** What trading here again would cost in rent, from the ACTIVE layout's account length. */
export function reopenRentSolText(): string {
  return rentSol(portfolioAccountLen()).toFixed(3);
}

const U128_FIELDS = (b: Uint8Array, off: number, count: number): boolean => {
  for (let i = 0; i < count * 16; i++) if (b[off + i] !== 0) return false;
  return true;
};
const readU64 = (b: Uint8Array, off: number): bigint => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true);
const readU128 = (b: Uint8Array, off: number): bigint => readU64(b, off) | (readU64(b, off + 8) << 64n);

/**
 * Parsed-field emptiness (everything `parsePortfolio` decodes). Used by the UI on the scan store's
 * parsed portfolio; the hook additionally runs {@link assessPortfolioBytes} on fresh bytes.
 */
export function isPortfolioClosable(pf: ParsedPortfolio, wallet: PublicKey): Closability {
  if (!pf.owner.equals(wallet)) {
    return { closable: false, reason: pf.provenanceOwner.equals(wallet) ? "wrapped" : "not-yours" };
  }
  if (pf.matcherEnabled) return { closable: false, reason: "lp" };
  if (pf.activeBitmap !== 0n || pf.legs.some((l) => l.active)) return { closable: false, reason: "open-position" };
  if (pf.capital !== 0n || pf.feeCredits !== 0n || pf.cancelDepositEscrow !== 0n) return { closable: false, reason: "has-balance" };
  if (pf.pnl !== 0n || pf.reservedPnl !== 0n) return { closable: false, reason: "unsettled" };
  for (const s of pf.sourceDomains) {
    // engine PortfolioSourceDomainV16Account::is_occupied: any claim / lien / fee-slot field set.
    if (
      s.sourceClaimBoundNum !== 0n || s.sourceClaimLienedNum !== 0n || s.sourceClaimCounterpartyLienedNum !== 0n ||
      s.sourceClaimInsuranceLienedNum !== 0n || s.sourceLienEffectiveReserved !== 0n || s.sourceLienCounterpartyBackingNum !== 0n ||
      s.sourceLienInsuranceBackingNum !== 0n || s.sourceLienFeeLastSlot !== 0n || s.sourceClaimImpairedNum !== 0n ||
      s.sourceLienImpairedEffectiveReserved !== 0n || s.sourceLienCapitalAtRiskFeeRevenue !== 0n ||
      s.sourceLienImpairedCapitalAtRiskFeeRevenue !== 0n
    ) {
      return { closable: false, reason: "unsettled" };
    }
  }
  return { closable: true };
}

/**
 * The fields `parsePortfolio` does not decode: the four lock flags (after the 121 B health cert), the close
 * progress ledger (184 B) and the resolved payout receipt. Offsets come from the account's own VERSION table
 * (v2.1 and v2.2 both: sourceDomains end + 121 = locks, +4 = close progress, +184 = receipt).
 * Returns a refusal reason, or null when the engine would accept the account.
 */
export function rawStateRefusal(data: Uint8Array): CloseRefusal | null {
  const g = portfolioLegGeometry(data);
  if (!g) return "unreadable";
  const P = g.layout.portfolio;
  const locksOff = P.sourceDomainsOff + P.sourceDomainCap * P.sourceDomainStride + 121;
  const cpOff = locksOff + 4;
  const receiptOff = P.resolvedPayoutReceiptOff;
  if (cpOff + 184 !== receiptOff || data.length < receiptOff + 66) return "unreadable";
  // stale_state, b_stale_state, rebalance_lock, liquidation_lock
  for (let i = 0; i < 4; i++) if (data[locksOff + i] !== 0) return "unsettled";
  // CloseProgressLedgerV16Account: active, finalized, canceled, close_id u64, asset u32, market u64, side,
  // gross_loss u128, drift_ref u64, max_close u64, then eight u128 (support, junior, insurance, b_loss,
  // explicit, adl, drift_consumed, residual).
  const cp = data.subarray(cpOff, cpOff + 184);
  const active = cp[0] !== 0;
  const finalized = cp[1] !== 0;
  const canceled = cp[2] !== 0;
  const closeId = readU64(cp, 3);
  const gross = readU128(cp, 24);
  const irreversible = !U128_FIELDS(cp, 56, 7);
  const residual = readU128(cp, 168);
  const isEmpty = cp.every((x) => x === 0);
  const inertCanceled = canceled && !active && !finalized && closeId !== 0n && !irreversible && residual === gross;
  const finalizedInert = active && finalized && !canceled && residual === 0n;
  if (!isEmpty && !inertCanceled && !finalizedInert) return "unsettled";
  // ResolvedPayoutReceiptV16Account: present (64) && !finalized (65) blocks.
  if (data[receiptOff + 64] !== 0 && data[receiptOff + 65] === 0) return "unsettled";
  return null;
}

/** Full check on raw account bytes: ownership, LP, every parsed field, then the raw-only fields. */
export function assessPortfolioBytes(data: Uint8Array, wallet: PublicKey): Closability {
  let pf: ParsedPortfolio;
  try {
    pf = parsePortfolio(data);
  } catch {
    return { closable: false, reason: "unreadable" };
  }
  const parsed = isPortfolioClosable(pf, wallet);
  if (!parsed.closable) return parsed;
  if (isLpPortfolio(data)) return { closable: false, reason: "lp" };
  const raw = rawStateRefusal(data);
  return raw ? { closable: false, reason: raw } : { closable: true };
}

/** A refusal as the error the hook throws (calm copy, shown as is). */
export function closeRefusalError(reason: CloseRefusal): UserFacingError {
  return new UserFacingError(CLOSE_ACCOUNT_COPY.refusals[reason]);
}

/**
 * The ClosePortfolio instruction for exactly this account, built through the same builder the resolved-market
 * cleanup uses. The identity (portfolio id, matcher sequence, position epoch) is read from the SAME bytes that
 * were just assessed, so the on-chain 3-way binding holds only while the account is unchanged.
 */
export function buildCloseTradingAccountIx(p: {
  programId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  data: Uint8Array;
}): TransactionInstruction {
  return ownerClosePortfolioIx(p.programId, p.owner, p.market, { key: p.portfolio, ...readPortfolioIdentity(p.data) });
}

/**
 * The line shown when a close fails. Our own pre-sign checks throw calm copy (UserFacingError /
 * PortfolioTargetError) that is shown as is; a chain refusal goes through the message resolver, with the two
 * codes ClosePortfolio itself raises worded for this action (21 = account not empty, 19 = the account moved
 * since it was read). Never raw chain text.
 */
export function closeAccountErrorMessage(e: unknown): string {
  if (e instanceof UserFacingError || (e as { name?: unknown } | null)?.name === "PortfolioTargetError") {
    return (e as Error).message;
  }
  const { code } = parseFailure(e);
  if (code === WRAPPER_ERR.EngineLockActive) return CLOSE_ACCOUNT_COPY.notEmpty;
  if (code === WRAPPER_ERR.EngineStale) return CLOSE_ACCOUNT_COPY.changed;
  return plainMessage(e, { surface: "any" }, keepAppMessage);
}
