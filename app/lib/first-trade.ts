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
import { PublicKey as PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_INIT_USER,
  WELL_KNOWN,
  buildAccountMetas,
  buildIx,
  encodeDepositCollateral,
  encodeInitUser,
} from "@percolatorct/sdk";
import { buildTradeCpiIx, type TradeIdentity } from "@/lib/trade-ix";
import { rentSol } from "@/lib/rent";
import { portfolioAccountLen } from "@/lib/v22/layout";
import { assetWrapperOff } from "@/lib/limits/constants";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { createPortfolioAccountIx } from "@/lib/v22/layout";
import { marketOffsetsOrNull } from "@/lib/v22/market-offsets";
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { computeLimitPriceE6 } from "@/lib/slippage";

/** offset_of!(AssetOracleProfileV16, next_portfolio_id); the profile opens the asset wrapper. */
export const OP_NEXT_PORTFOLIO_ID = 480;

/** Absolute offset of asset 0's next_portfolio_id in the v2.1 market account (v2.2: `marketOffsets(...).wrapperOff(0) + OP_NEXT_PORTFOLIO_ID`). */
export const NEXT_PORTFOLIO_ID_OFF = assetWrapperOff(0) + OP_NEXT_PORTFOLIO_ID;

/** The market's portfolio-id counter (u64 LE). null when the account is too short. */
export function readNextPortfolioId(market: Uint8Array): bigint | null {
  const M = marketOffsetsOrNull(market, "readNextPortfolioId");
  if (!M) return null;
  const off = M.wrapperOff(0) + OP_NEXT_PORTFOLIO_ID;
  if (market.length < off + 8) return null;
  return new DataView(market.buffer, market.byteOffset, market.byteLength).getBigUint64(off, true);
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
 * k = leverage100 * feeBps / 1e6.
 *
 * The engine's gate is what decides, not the ticket's margin. It charges the taker fee first, then
 * needs equity >= max(notional x IM, floor) + a target-lag penalty, with the notional at ITS
 * effective price (v16 compute_account_health_cert / target_effective_lag_loss_penalty), while the
 * ticket sizes from the display feed. engineGateBps turns that into two numbers vs the display:
 * the price ratio r and the lag penalty. A margin M at leverage lev then needs
 * M x lev x (IM x r + lag + fee x rf), rf = the fee's price ratio (engineGateBps.feeRatioBps: a long's fee
 * is charged at the fill, which may be anywhere up to its limit). At a max leverage that divides 10000 (10x, 5x, ...) there is
 * no slack, so an unadjusted Max was refused Custom(49) on every fee-charging market.
 * Omitting initialMarginBps keeps the legacy cap.
 */
export function tradableMarginAtoms(p: {
  inMarketAvailable: bigint;
  walletAtoms: bigint;
  leverage100: number;
  feeBps: bigint;
  /** The market's initial margin; omitted = no engine-gate cap (legacy). */
  initialMarginBps?: bigint;
  /** engineGateBps for the order's side; omitted = engine price equals the display price. */
  gate?: EngineGate;
  decimals?: number;
}): bigint {
  // 2026-10-02 (live report): the 10% deposit buffer must never shrink what the ticket offers —
  // "Available 9,154" against a 10.1k wallet read as missing money. The buffer is now taken only
  // from what the wallet has left (fundDepositAtoms), so the whole wallet backs margin + fee:
  //   max(M, engine IM) - A + fee <= W - cent
  const A = p.inMarketAvailable > 0n ? p.inMarketAvailable : 0n;
  const decimals = p.decimals ?? 6;
  const cent = decimals >= 2 ? 10n ** BigInt(decimals - 2) : 1n;
  const W = p.walletAtoms - cent;
  const lev100 = BigInt(Math.max(100, Math.round(p.leverage100)));
  const fee = p.feeBps > 0n ? p.feeBps : 0n;
  const im = p.initialMarginBps ?? 0n;
  const { r, rf, lag } = gateOf(p.gate);
  // Per unit of margin, scaled by GATE_SCALE: the engine IM (with the lag penalty) and the fee.
  const imPer = lev100 * (im * r + lag * RATIO_ONE);
  const feePer = lev100 * fee * rf;
  if (W > 0n) {
    // Bundled: the ticket deposits max(M, engine IM) - A + fee, so the gate holds after the fee.
    const m = ((W + A) * GATE_SCALE) / ((imPer > GATE_SCALE ? imPer : GATE_SCALE) + feePer);
    if (m > A) return m;
  }
  // No deposit: engine IM + fee must fit A. Below max leverage that is already true at M = A.
  if (im <= 0n || imPer + feePer <= GATE_SCALE) return A;
  const m = ((A > MAX_PAD_ATOMS ? A - MAX_PAD_ATOMS : 0n) * GATE_SCALE) / (imPer + feePer);
  return m;
}

/** The engine's gate vs the display price, for one side (engineGateBps). */
export interface EngineGate {
  /** Engine price / display, bps, rounded up; 10_000 = at or below the display price. */
  ratioBps: bigint;
  /** The engine's target-lag penalty as a share of the display notional, bps, rounded up. */
  lagBps: bigint;
  /**
   * The price the taker fee is charged at, vs the display, bps, rounded up. The engine charges the fee on the
   * matcher's exec price (v16.rs:18667), not the effective price. A long's exec may sit anywhere up to its limit,
   * the effective price x 1.05 (#3462, lib/open-limit.ts), so a long's fee is priced at max(ratio, limit); a short's
   * exec is at or above its (lower) limit, which bounds nothing upward, so it keeps the ratio. Omitted = ratioBps.
   */
  feeRatioBps?: bigint;
}

/** 10_000 bps = 1x. */
const RATIO_ONE = 10_000n;
/** lev100 (x100) x bps (x1e4) x ratio bps (x1e4). */
const GATE_SCALE = 10_000_000_000n;
/**
 * The engine ceils each term twice (risk_notional_ceil, then margin_requirement / checked_fee_bps),
 * so it can sit up to 2 atoms above our single ceil per term: engineOpenNeedAtoms pads each by 2.
 * Max keeps 3 atoms per term back (our ceil + that pad) x 3 terms, so it never trips that check.
 */
const ENGINE_CEIL_PAD = 2n;
const MAX_PAD_ATOMS = 9n;

const gateOf = (g?: EngineGate) => ({
  r: g && g.ratioBps > RATIO_ONE ? g.ratioBps : RATIO_ONE,
  rf: g && (g.feeRatioBps ?? g.ratioBps) > RATIO_ONE ? (g.feeRatioBps ?? g.ratioBps) : RATIO_ONE,
  lag: g && g.lagBps > 0n ? g.lagBps : 0n,
});

/**
 * The engine's IM and fee for an order sized off `displayE6`, relative to it:
 *  - ratioBps: IM and the fee are charged on size x the engine price. Both the current effective
 *    price and the target it is moving toward count (it can step up before the order lands); a
 *    price at or below the display adds nothing.
 *  - lagBps: while the effective price lags its target the engine adds the WHOLE adverse gap to
 *    initial margin (a long when the target is below, a short when it is above), not IM x gap.
 * An unreadable engine view adds nothing (the ticket's other paths treat a missing on-chain read
 * the same way).
 */
export function engineGateBps(
  displayE6: bigint | null | undefined,
  engine: { effectivePriceE6: bigint; targetPriceE6: bigint } | null,
  side: "long" | "short",
): EngineGate {
  const none = { ratioBps: RATIO_ONE, lagBps: 0n };
  if (!engine || !displayE6 || displayE6 <= 0n) return none;
  const sane = (v: unknown) => (typeof v === "bigint" ? sanitizePriceE6(v) : 0n);
  const eff = sane(engine.effectivePriceE6);
  const target = sane(engine.targetPriceE6);
  if (eff === 0n) return none;
  const up = (n: bigint) => (n * RATIO_ONE + displayE6 - 1n) / displayE6;
  const p = eff > target ? eff : target;
  const adverse = target === 0n ? 0n : side === "long" ? (target < eff ? eff - target : 0n) : target > eff ? target - eff : 0n;
  const ratioBps = p > displayE6 ? up(p) : RATIO_ONE;
  // A long's fee is charged at its fill, which the matcher may put anywhere up to the limit the ticket sends
  // (computeLimitPriceE6 around the effective price, exactly as lib/open-limit.ts builds it).
  const longLimit = side === "long" ? computeLimitPriceE6({ markE6: eff, size: 1n }) : 0n;
  const limitBps = longLimit > displayE6 ? up(longLimit) : RATIO_ONE;
  const feeRatioBps = limitBps > ratioBps ? limitBps : ratioBps;
  return { ratioBps, lagBps: adverse > 0n ? up(adverse) : 0n, feeRatioBps };
}

/**
 * What the engine's gate needs for an order of collateral notional `notionalAtoms` sized off the
 * display price: base IM, the target-lag penalty and the taker fee, each rounded up like the
 * engine plus ENGINE_CEIL_PAD. The caller applies the IM floor to `im` before adding `lag`.
 */
export function engineOpenNeedAtoms(
  notionalAtoms: bigint,
  initialMarginBps: bigint,
  feeBps: bigint,
  gate?: EngineGate,
): { im: bigint; lag: bigint; fee: bigint } {
  const { r, rf, lag } = gateOf(gate);
  const term = (num: bigint, den: bigint) => (num > 0n ? (num + den - 1n) / den + ENGINE_CEIL_PAD : 0n);
  if (notionalAtoms <= 0n) return { im: 0n, lag: 0n, fee: 0n };
  return {
    im: term(notionalAtoms * initialMarginBps * r, 100_000_000n),
    lag: term(notionalAtoms * lag, RATIO_ONE),
    fee: term(notionalAtoms * feeBps * rf, 100_000_000n),
  };
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

/** SOL the first trade moves into the new portfolio account's rent (~0.049 SOL at 9,563 bytes; ~0.055 at v2.2's 10,607). */
export const FIRST_TRADE_RENT_SOL = rentSol(portfolioAccountLen());
const rentLabel = `~${FIRST_TRADE_RENT_SOL.toFixed(2)} SOL`;

export const FIRST_TRADE_COPY = {
  line: `First trade on this market sets up your trading account (one approval, plus ${rentLabel} one-time account rent)`,
  /** The confirm modal's row for that rent. */
  rentRow: { label: "Account setup (one-time)", value: rentLabel },
  button: (amount: string, side: string) => `Deposit ${amount} & ${side}`,
  race: "One more approval: someone joined this market at the same moment.",
  /** Multi-asset market: the positions are refreshed in their own transaction before the order (shown for a ticket trade too). */
  twoTx: "This order refreshes positions first, so one approval may cover two transactions, or your wallet may ask twice.",
  /** GH#2959: the user turned the fund-and-trade down in the wallet. */
  cancelled: "Trade cancelled in your wallet.",
  /** Devnet only: the usual reason a first trade gets turned down is a wallet still on Mainnet. Phantom
   *  then simulates the devnet transaction against Mainnet, shows "insufficient SOL" and can flag the
   *  site, so the user rejects it and nothing on our side can tell (no blockhash error reaches us). */
  cancelledDevnetWhy:
    "If your wallet said you don't have enough SOL, or warned about this site, it is probably still on Mainnet. In Phantom: Settings > Developer Settings > turn on Testnet Mode and pick Solana Devnet, then try again.",
} as const;

/** True only for the Phantom wallet (adapter name). The Mainnet-mode hint above is Phantom's setting, so it is never shown to Solflare etc. */
export function isPhantomWalletName(name: string | null | undefined): boolean {
  return typeof name === "string" && /phantom/i.test(name);
}

/**
 * GH#2959 + RT5-2 (round f): the extra line for a fund-and-trade the user turned down. `why` (the Phantom Testnet-Mode
 * hint) only for Phantom on devnet; a timeout is never a "cancelled" and has no hint (it never reaches here: kind
 * "wallet-request-closed" is not quiet).
 */
export function firstTradeCancelledExtras(walletName: string | null | undefined, devnet: boolean): { body: string; why?: string } {
  return { body: FIRST_TRADE_COPY.cancelled, ...(devnet && isPhantomWalletName(walletName) ? { why: FIRST_TRADE_COPY.cancelledDevnetWhy } : {}) };
}

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
  /** v2.2: the market has its leverage guard account; the TradeCpi then carries it as its last account (lib/v22/lev-guard.ts). */
  levGuard?: boolean;
}

/** The first trade's set-up legs: [CreateAccount(portfolio, full length), InitPortfolio]. */
export function buildFirstTradeInitIxs(p: Pick<FirstTradeIxParams, "programId" | "owner" | "market" | "portfolio">, rentLamports: number): TransactionInstruction[] {
  return [
    createPortfolioAccountIx(p.owner, p.portfolio, rentLamports, p.programId),
    buildIx({ programId: p.programId, keys: buildAccountMetas(ACCOUNTS_INIT_USER, [p.owner, p.market, p.portfolio]), data: encodeInitUser({}) }),
  ];
}

/** Deposit(id, sequence) into `portfolio`. For a fresh portfolio the id is the PREDICTED one and the
 *  sequence is 0 (SOL-2: the standalone create-and-deposit uses exactly this leg). */
export function buildFirstDepositIx(
  p: Pick<FirstTradeIxParams, "programId" | "owner" | "market" | "portfolio" | "userAta" | "vaultTokenAta" | "depositAtoms">,
  id: { portfolioId: bigint; sequence: bigint },
): TransactionInstruction {
  return buildIx({
    programId: p.programId,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [p.owner, p.market, p.portfolio, p.userAta, p.vaultTokenAta, WELL_KNOWN.tokenProgram]),
    data: encodeDepositCollateral({ portfolioId: id.portfolioId, expectedSequence: id.sequence, amount: p.depositAtoms.toString() }),
  });
}

/** [Deposit(id, sequence), TradeCpi(id, position epoch)] — for a fresh portfolio id is the
 *  PREDICTED one and sequence / epoch are 0. */
export function buildFundAndTradeIxs(p: FirstTradeIxParams, id: { portfolioId: bigint; sequence: bigint; positionEpoch: bigint }): TransactionInstruction[] {
  return [
    buildFirstDepositIx(p, id),
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
      levGuard: p.levGuard,
    }),
  ];
}
