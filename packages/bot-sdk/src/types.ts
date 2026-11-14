/**
 * Wire types of /api/v1. Engine integers (q, E6 prices, collateral atoms, the margin/fee bps stored in a market's config) are
 * decimal strings: parse them with BigInt. Values the API computes (price impact, spreads, expected fee and fee cap in bps,
 * leverage, ages) are JSON numbers.
 */

export type ErrorCode =
  | "bad_request" | "payload_too_large" | "unauthorized" | "forbidden_scope" | "disabled" | "not_found" | "method_not_allowed"
  | "rate_limited" | "idempotency_conflict" | "idempotency_in_progress" | "order_cancelled" | "request_expired" | "maintenance"
  | "rpc_unavailable" | "internal" | "market_not_found" | "market_unsupported" | "market_unreadable" | "market_stale"
  | "no_portfolio" | "bad_portfolio" | "no_lp" | "slippage_cap_exceeded" | "notional_cap_exceeded" | "size_cap_exceeded"
  | "leverage_cap_exceeded" | "reduce_only_violation" | "no_position" | "insufficient_margin" | "insufficient_funds"
  | "fee_raise_required" | "fee_above_max" | "fee_unreadable" | "too_large" | "simulation_failed" | "bad_signature";

/** Codes the SDK itself raises when there was no API envelope. */
export type ClientErrorCode = "network_error" | "bad_response" | "timeout";

export interface OnchainError {
  code: number;
  name: string | null;
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; retryable: boolean; onchain?: OnchainError; details?: Record<string, unknown>; logs?: string[] };
}

export interface Meta {
  slot: number;
  observedAt: string;
}

export interface OracleFreshness {
  mode: string;
  modeByte: number;
  lastPushSlot: string | null;
  ageSlots: number | null;
  ageSecs: number | null;
  staleBoundSecs: number;
  staleBoundSource: "market" | "default";
  stale: boolean;
  markEwmaE6: string;
}

export interface Market {
  market: string;
  programId: string;
  symbol: string | null;
  name: string | null;
  lotExp: number;
  assets: number;
  /** The token the market holds as collateral. */
  collateralMint: string;
  /** null = a collateral the API cannot value in USD (orders that add risk are refused). */
  collateralDecimals: number | null;
  oracleMode: string;
  effectivePriceE6: string;
  targetPriceE6: string;
  markEwmaE6: string;
  oracle: OracleFreshness;
  /** The market's configured BASE trade fee, bps (a config integer, so a string). */
  feeBps: string;
  maxLeverage: number | null;
  openInterest: { longQ: string; shortQ: string };
}

export interface MarketDetail extends Market {
  risk: Record<string, unknown>;
}

export interface MarketList extends Meta {
  count: number;
  skipped: number;
  markets: Market[];
}

export interface MarketOne extends Meta {
  market: MarketDetail;
}

export interface Funding extends Meta {
  market: string;
  enabled: boolean;
  active: boolean;
  direction: string;
  rateE9PerSlot: string;
  ratePerSlot: number;
  pctPer8h: number;
  impliedPctPer8h: number;
  premiumE9PerSlot: string;
  skewE9PerSlot: string;
  maxAbsE9PerSlot: string;
  bothSidesOpen: boolean;
  priceManaged: boolean;
  slotsPer8h: number;
}

export interface SideLimit {
  maxQ: string | null;
  reason: string | null;
  halted: boolean;
}

export interface Quote {
  market: string;
  side: "buy" | "sell";
  sizeQ: string;
  notionalAtoms: string;
  effectivePriceE6: string;
  /** Oracle freshness, same rule as Market.oracle. A stale market still quotes; orders that add risk are refused. */
  oracle: { stale: boolean; ageSecs: number | null; staleBoundSecs: number };
  slippageBps: number;
  limitPriceE6: string;
  estExecPriceE6: string | null;
  /** null when nothing fills. */
  priceImpactBps: number | null;
  totalSpreadBps: number | null;
  withinLimit: boolean | null;
  matcher: Record<string, unknown>;
  /** What the fill is expected to charge: base fee + the matcher's adaptive fee, bps of notional. null when nothing fills. */
  expectedFeeBps: number | null;
  expectedFeeAtoms: string | null;
  /** The fee cap a build signs (the MOST a fill may charge), bps. Far above expectedFeeBps by design. */
  feeCapBps: number | null;
  baseFeeBps: number;
  feeChargedInPrice: boolean;
  maxSizePerSide: { long: SideLimit | null; short: SideLimit | null };
  exceedsMaxSize: boolean;
  lotExp: number;
}

export interface QuoteResponse extends Meta {
  quote: Quote;
}

export interface DepthRow {
  notionalUsd: number;
  sizeQ: string;
  fillQ: string | null;
  filledFully: boolean;
  execPriceE6: string | null;
  spreadBps: number | null;
  impactBps: number | null;
}

export interface DepthResponse extends Meta {
  depth: {
    market: string;
    effectivePriceE6: string;
    model: string;
    note: string;
    asks: DepthRow[];
    bids: DepthRow[];
    maxSizePerSide: { long: SideLimit | null; short: SideLimit | null };
    oracle: { stale: boolean; ageSecs: number | null; staleBoundSecs: number };
    feeCapBps: number | null;
    baseFeeBps: number;
    lotExp: number;
  };
}

export interface Position {
  asset: number;
  side: "long" | "short";
  rawBasisQ: string;
  sizeQ: string | null;
  entryPriceE6: string | null;
  entrySource: string | null;
  entryIsEstimate: boolean | null;
  markPriceE6: string | null;
  unrealizedPnl: string | null;
  liqPriceE6: string | null;
  notional: string | null;
  /** notional / the portfolio's leverageEquity: the same equity the order leverage cap uses. */
  leverage: number | null;
  [k: string]: unknown;
}

export interface Portfolio {
  address: string;
  market: string;
  programId: string;
  marketStatus: "ok" | "missing" | "unsupported" | "unreadable";
  symbol: string | null;
  isLp: boolean;
  capital: string;
  pnl: string;
  feeCredits: string;
  /** capital less the open position's unrealized loss and negative fee credits (gains not counted): the leverage denominator. */
  leverageEquity: string;
  /** Account value at the mark. */
  equity: string;
  /** Equity in the account's last health certificate; lags and can differ a lot from equity. Do not use it for margin decisions. */
  certifiedEquity: string | null;
  margin: { initialMarginBps: string | null; maintenanceMarginBps: string | null; maxLeverage: number | null };
  positions: Position[];
}

export interface Account extends Meta {
  wallet: string;
  count: number;
  portfolios: Portfolio[];
}

export interface HistoryItem {
  signature: string;
  slot: number;
  blockTime: number | null;
  portfolios: string[];
  ok: boolean;
  err: { code: number | null; name: string | null; raw: unknown } | null;
  memo: string | null;
  confirmationStatus: string | null;
}

export interface History {
  observedAt: string;
  source: "chain-signatures";
  note: string;
  slot: number;
  wallet: string;
  portfolios: string[];
  truncated: boolean;
  limit: number;
  items: HistoryItem[];
  nextBefore: string | null;
}

export interface OrderRequest {
  owner: string;
  market: string;
  side: "buy" | "sell";
  /** Engine q, a positive decimal string with no sign (`side` sets the direction; the quote's `size` is signed instead). */
  size: string;
  reduceOnly?: boolean;
  /** 1..1000, default 100 (0 is refused). */
  slippageBps?: number;
  limitPriceE6?: string;
  /** The highest fee CAP (feeCapBps) you accept; a build whose cap is higher is refused with fee_above_max. */
  maxFeeBps?: number;
  /** USD notional of THIS order (per order, not per position). */
  maxNotionalUsd?: number;
  maxLeverage?: number;
  portfolio?: string;
  /** Unix ms. */
  expiresAfter?: number;
}

export interface CloseRequest {
  owner: string;
  market: string;
  size?: string;
  slippageBps?: number;
  maxFeeBps?: number;
  portfolio?: string;
  expiresAfter?: number;
}

export interface DepositRequest {
  owner: string;
  market: string;
  amount: string;
  portfolio?: string;
  /** Public key of a fresh keypair you generate; it must co-sign the returned tx. */
  newPortfolio?: string;
  expiresAfter?: number;
}

export interface WithdrawRequest {
  owner: string;
  market: string;
  amount: string;
  portfolio?: string;
  expiresAfter?: number;
}

export interface ReturnedTx {
  purpose: string;
  /** Unsigned legacy transaction, base64. */
  transaction: string;
  messageHash: string;
  signers: string[];
  computeUnitLimit: number;
  simulation: { unitsConsumed: number | null; logsTail: string[] };
}

export interface BuildResponse {
  transactions: ReturnedTx[];
  blockhash: string;
  lastValidBlockHeight: number;
  /** true: the only tx is a maintenance crank; send it, then build again. */
  resubmitAfter: boolean;
  summary: BuildSummary;
  caps?: Record<string, unknown>;
}

export interface BuildSummary {
  market?: string;
  portfolio?: string;
  side?: "buy" | "sell";
  size?: string;
  limitPriceE6?: string;
  effectivePriceE6?: string;
  /** The fee cap the transaction signs: the most a fill may charge. */
  feeCapBps?: number | null;
  /** What a fill is expected to charge, bps of notional, and in collateral atoms. */
  expectedFeeBps?: number | null;
  expectedFeeAtoms?: string | null;
  reducing?: boolean;
  repairs?: string[];
  [k: string]: unknown;
}

/** What a build call returns: the API body plus the Idempotency-Key that was used (needed for cancelOrder). */
export type BuildResult = BuildResponse & { idempotencyKey: string };

export interface CancelResponse {
  idempotencyKey: string;
  cancelled: boolean;
  alreadyCancelled: boolean;
  lastValidBlockHeight: number | null;
  onchain: string;
}

export type TxState = "pending" | "processed" | "confirmed" | "finalized" | "failed" | "expired" | "unknown";

export interface TxStatus {
  signature: string;
  status: TxState;
  slot: number | null;
  confirmations: number | null;
  err: { raw: unknown; onchain: OnchainError | null } | null;
  blockHeight: number | null;
  lastValidBlockHeight: number | null;
  observedAt: string;
}

export interface Health {
  status: "ok";
  version: string;
  slot: number;
  blockHeight: number;
  rpcMs: number;
  observedAt: string;
  kv: { backend: "upstash" | "memory"; degraded: boolean };
  writesPaused: boolean;
}

export interface MarketEvent {
  market: string;
  slot: number;
  observedAt: string;
  effectivePriceE6?: string;
  targetPriceE6?: string;
  oracle?: { ageSlots: number | null; stale: boolean };
  openInterest?: { longQ: string; shortQ: string };
  error?: { code: string; retryable: boolean };
}

export type StreamEvent =
  | { type: "market"; id: string | null; data: MarketEvent }
  | { type: "heartbeat"; id: string | null; data: { slot: number; observedAt: string } }
  | { type: "error"; id: string | null; data: { code: string; retryable: boolean } };
