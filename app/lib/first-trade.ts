/**
 * UX WP-6 (audit §3.2, TR-5): the first trade on a market in ONE approval.
 *
 *   ONE tx = [CreateAccount, InitPortfolio, Deposit(predicted id, sequence 0),
 *             TradeCpi(predicted id, position epoch 0)]          (portfolio keypair co-signs)
 *   GH#2959: this was two txs (A = create+init, B = deposit+trade) signed together; wallets that
 *   simulate each tx alone (Solflare) refused B ("IncorrectProgramId": no portfolio until A lands).
 *
 * The predicted id is what InitPortfolio will assign, read from the DEPLOYED handler's own source:
 * `handle_init_portfolio` allocates `allocate_portfolio_id(profile0.next_portfolio_id)` from asset
 * 0's `AssetOracleProfileV16` (NOT `WrapperConfigV16`, whatever older comments say), and a fresh
 * portfolio's matcher sequence and position epoch are both 0 (whole-buffer zero at init). The
 * offset comes from rustc's offset_of! (fixture rust-p3-final.json `op.next_portfolio_id`), never
 * the SDK. If someone else initialises in between, the tx fails EngineProvenanceMismatch (atomic:
 * nothing lands) and is rebuilt with the real id: the one 2-prompt case ("someone joined this
 * market at the same moment").
 */
import { PublicKey as PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_INIT_USER,
  V17_PORTFOLIO_ACCOUNT_LEN,
  WELL_KNOWN,
  buildAccountMetas,
  buildIx,
  encodeDepositCollateral,
  encodeInitUser,
} from "@percolatorct/sdk";
import { buildTradeCpiIx, type TradeIdentity } from "@/lib/trade-ix";
import { assetWrapperOff } from "@/lib/limits/constants";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

/** offset_of!(AssetOracleProfileV16, next_portfolio_id); the profile opens the asset wrapper. */
export const OP_NEXT_PORTFOLIO_ID = 480;

/** Absolute offset of asset 0's next_portfolio_id in the market account. */
export const NEXT_PORTFOLIO_ID_OFF = assetWrapperOff(0) + OP_NEXT_PORTFOLIO_ID;

/** The market's portfolio-id counter (u64 LE). null when the account is too short. */
export function readNextPortfolioId(market: Uint8Array): bigint | null {
  if (market.length < NEXT_PORTFOLIO_ID_OFF + 8) return null;
  return new DataView(market.buffer, market.byteOffset, market.byteLength).getBigUint64(NEXT_PORTFOLIO_ID_OFF, true);
}

/** Port of `state::allocate_portfolio_id`: 0 (pre-counter sentinel) is normalised to 1. */
export function predictPortfolioId(next: bigint): bigint {
  return next === 0n ? 1n : next;
}

/** The deposit the first trade needs: margin + fee + a 10% buffer (§3.2), rounded up to a cent. */
export function firstTradeDepositAtoms(marginAtoms: bigint, feeAtoms: bigint, decimals = 6): bigint {
  const need = marginAtoms + feeAtoms;
  if (need <= 0n) return 0n;
  const buffered = (need * 110n + 99n) / 100n;
  const cent = decimals >= 2 ? 10n ** BigInt(decimals - 2) : 1n;
  return ((buffered + cent - 1n) / cent) * cent;
}

/**
 * The largest margin a ticket can offer when the wallet can top the account up in the same
 * approval (UX WP-6 fund-and-trade). Live report 2026-10-01 (Squid): with an account on the
 * market, "Available" and 25/50/75/Max counted ONLY the in-market capital, so a trader with
 * plenty of sim-USDC in the wallet looked capped at their old deposit.
 *
 * Max M satisfies firstTradeDepositAtoms(M - A, fee(M)) <= W, with fee(M) = M * lev * feeBps:
 *   1.1 * (M - A + M*k) <= W - cent   =>   M <= ((W - cent) / 1.1 + A) / (1 + k),
 * k = leverage100 * feeBps / 1e6. Never less than A (in-market capital alone needs no deposit).
 */
export function tradableMarginAtoms(p: {
  inMarketAvailable: bigint;
  walletAtoms: bigint;
  leverage100: number;
  feeBps: bigint;
  decimals?: number;
}): bigint {
  // 2026-10-02 (live report): the 10% deposit buffer must never shrink what the ticket offers —
  // "Available 9,154" against a 10.1k wallet read as missing money. The buffer is now taken only
  // from what the wallet has left (fundDepositAtoms), so the whole wallet backs margin + fee:
  //   (M - A) + M*k <= W - cent   =>   M <= (W - cent + A) / (1 + k)
  const A = p.inMarketAvailable > 0n ? p.inMarketAvailable : 0n;
  const decimals = p.decimals ?? 6;
  const cent = decimals >= 2 ? 10n ** BigInt(decimals - 2) : 1n;
  const W = p.walletAtoms - cent;
  if (W <= 0n) return A;
  const lev100 = BigInt(Math.max(100, Math.round(p.leverage100)));
  const fee = p.feeBps > 0n ? p.feeBps : 0n;
  const m = ((W + A) * 1_000_000n) / (1_000_000n + lev100 * fee);
  return m > A ? m : A;
}

/**
 * The deposit bundled with a trade: margin shortfall + fee + a 10% buffer, but the buffer only
 * comes out of what the wallet has spare — never below the order's real need (shortfall + fee),
 * never above the wallet (rounded down to a cent). Returns the need itself when the wallet can't
 * cover it, so the ticket's "over wallet" check still fires.
 */
export function fundDepositAtoms(shortAtoms: bigint, feeAtoms: bigint, walletAtoms: bigint, decimals = 6): bigint {
  const need = shortAtoms + feeAtoms;
  if (need <= 0n) return 0n;
  const buffered = firstTradeDepositAtoms(shortAtoms, feeAtoms, decimals);
  if (walletAtoms <= need) return need;
  const cent = decimals >= 2 ? 10n ** BigInt(decimals - 2) : 1n;
  const walletCents = (walletAtoms / cent) * cent;
  const capped = buffered < walletCents ? buffered : walletCents;
  return capped > need ? capped : need;
}

/** B landed against a portfolio id someone else took first (the race: rebuild B, one more prompt). */
export function isPortfolioIdRace(err: unknown): boolean {
  const r = err as { code?: unknown; message?: unknown } | null;
  if (r && typeof r.code === "number") return r.code === WRAPPER_ERR.EngineProvenanceMismatch;
  const msg = typeof r?.message === "string" ? r.message : String(err);
  const hex = `0x${WRAPPER_ERR.EngineProvenanceMismatch.toString(16)}`;
  return new RegExp(`"Custom"\\s*:\\s*${WRAPPER_ERR.EngineProvenanceMismatch}\\b|custom program error: ${hex}\\b`, "i").test(msg);
}

/** Which leg of B failed: the deposit (index 0 after the budget prefix) or the trade. */
export function failedFirstTradeLeg(err: unknown, depositIndex: number): "deposit" | "trade" | null {
  const r = err as { instructionIndex?: unknown; message?: unknown } | null;
  let idx: number | null = typeof r?.instructionIndex === "number" ? r.instructionIndex : null;
  if (idx === null) {
    const msg = typeof r?.message === "string" ? r.message : String(err);
    // JSON ("InstructionError":[3,...]), Rust debug (InstructionError(3, ...)), RPC text
    // ("Error processing Instruction 3: ...").
    const m = /"InstructionError"\s*:\s*\[\s*(\d+)|InstructionError\((\d+),|Error processing Instruction (\d+)/.exec(msg);
    if (m) idx = Number(m[1] ?? m[2] ?? m[3]);
  }
  if (idx === null) return null;
  return idx === depositIndex ? "deposit" : idx > depositIndex ? "trade" : null;
}

/** The deposit failed: the account exists, nothing was deposited (never swallowed, §3.2 item 5). */
export class FirstTradeDepositError extends Error {
  readonly amountLabel: string;
  constructor(amountLabel: string, cause?: unknown) {
    super(`Your trading account is set up but the deposit didn't go through. Deposit ${amountLabel} to trade.`, { cause });
    this.name = "FirstTradeDepositError";
    this.amountLabel = amountLabel;
  }
}

export const FIRST_TRADE_COPY = {
  line: "First trade on this market sets up your trading account (one approval)",
  button: (amount: string, side: string) => `Deposit ${amount} & ${side}`,
  race: "One more approval: someone joined this market at the same moment.",
  /** GH#2959: the user turned the fund-and-trade down in the wallet. */
  cancelled: "Trade cancelled in your wallet.",
  /** Devnet only: the usual reason a first trade gets turned down is a wallet still on Mainnet. Phantom
   *  then simulates the devnet transaction against Mainnet, shows "insufficient SOL" and can flag the
   *  site, so the user rejects it and nothing on our side can tell (no blockhash error reaches us). */
  cancelledDevnetWhy:
    "If your wallet said you don't have enough SOL, or warned about this site, it is probably still on Mainnet. In Phantom: Settings > Developer Settings > turn on Testnet Mode and pick Solana Devnet, then try again.",
} as const;

// ── The instructions (shared by hooks/useFirstTrade.ts and the LiteSVM bridge) ──────────────

export interface FirstTradeIxParams {
  programId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  userAta: PublicKey;
  vaultTokenAta: PublicKey;
  depositAtoms: bigint;
  lp: { accountB: PublicKey; matcherProg: PublicKey; matcherCtx: PublicKey; matcherDelegate: PublicKey };
  lpId: TradeIdentity & { matcherSequence: bigint };
  marketId: bigint;
  size: bigint;
  limitPriceE6: bigint;
  feeBps?: bigint;
  marketTradeFeeBps?: bigint;
}

/** The first trade's set-up legs: [CreateAccount(portfolio, full length), InitPortfolio]. */
export function buildFirstTradeInitIxs(p: Pick<FirstTradeIxParams, "programId" | "owner" | "market" | "portfolio">, rentLamports: number): TransactionInstruction[] {
  return [
    SystemProgram.createAccount({ fromPubkey: p.owner, newAccountPubkey: p.portfolio, lamports: rentLamports, space: V17_PORTFOLIO_ACCOUNT_LEN, programId: p.programId }),
    buildIx({ programId: p.programId, keys: buildAccountMetas(ACCOUNTS_INIT_USER, [p.owner, p.market, p.portfolio]), data: encodeInitUser({}) }),
  ];
}

/** [Deposit(id, sequence), TradeCpi(id, position epoch)] — for a fresh portfolio id is the
 *  PREDICTED one and sequence / epoch are 0. */
export function buildFundAndTradeIxs(p: FirstTradeIxParams, id: { portfolioId: bigint; sequence: bigint; positionEpoch: bigint }): TransactionInstruction[] {
  return [
    buildIx({
      programId: p.programId,
      keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [p.owner, p.market, p.portfolio, p.userAta, p.vaultTokenAta, WELL_KNOWN.tokenProgram]),
      data: encodeDepositCollateral({ portfolioId: id.portfolioId, expectedSequence: id.sequence, amount: p.depositAtoms.toString() }),
    }),
    buildTradeCpiIx({
      programId: p.programId,
      signer: p.owner,
      market: p.market,
      accountA: p.portfolio,
      ...p.lp,
      takerId: { portfolioId: id.portfolioId, positionEpoch: id.positionEpoch },
      lpId: p.lpId,
      marketId: p.marketId,
      legs: [p.size],
      size: p.size,
      limitPriceE6: p.limitPriceE6,
      feeBps: p.feeBps,
      marketTradeFeeBps: p.marketTradeFeeBps,
    }),
  ];
}
