/**
 * Bot API error catalog and the envelope every /api/v1 error uses:
 *   { "error": { "code", "message", "retryable", "onchain"?: { "code", "name" }, "logs"? } }
 * Codes are stable strings (documented in the OpenAPI spec); HTTP status and retryable come from here, never from the
 * handler, so one code always means one thing.
 */
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { WRAPPER_ERR_V21 } from "@/lib/v21/wrapper-errors";
import { PERCOLATOR_ERRORS_V22 } from "@/lib/v22/sdk/errors-v22";

export const ERROR_CATALOG = {
  bad_request: { status: 400, retryable: false, message: "the request is not valid" },
  payload_too_large: { status: 413, retryable: false, message: "request body is too large" },
  unauthorized: { status: 401, retryable: false, message: "missing or invalid API key" },
  forbidden_scope: { status: 403, retryable: false, message: "this API key does not have the scope for this endpoint" },
  disabled: { status: 503, retryable: false, message: "the bot API is not enabled on this deployment" },
  not_found: { status: 404, retryable: false, message: "not found" },
  method_not_allowed: { status: 405, retryable: false, message: "method not allowed" },
  rate_limited: { status: 429, retryable: true, message: "rate limit reached" },
  idempotency_conflict: { status: 409, retryable: false, message: "this Idempotency-Key was used with a different request" },
  idempotency_in_progress: { status: 409, retryable: true, message: "a request with this Idempotency-Key is still running" },
  order_cancelled: { status: 409, retryable: false, message: "this Idempotency-Key was cancelled" },
  request_expired: { status: 400, retryable: false, message: "expiresAfter is in the past" },
  maintenance: { status: 503, retryable: true, message: "writes are paused for maintenance" },
  rpc_unavailable: { status: 503, retryable: true, message: "the Solana RPC failed, try again" },
  kv_unavailable: { status: 503, retryable: true, message: "the API's key store is unavailable, try again" },
  client_ip_unknown: { status: 503, retryable: false, message: "the server could not determine the caller's address; anonymous access is refused until the proxy depth is configured" },
  internal: { status: 500, retryable: true, message: "internal error" },
  // markets / accounts
  market_not_found: { status: 404, retryable: false, message: "market not found" },
  market_unsupported: { status: 422, retryable: false, message: "this market is not supported by the API yet" },
  market_unreadable: { status: 503, retryable: true, message: "market state could not be read" },
  market_stale: { status: 409, retryable: true, message: "the market's oracle price is stale" },
  market_needs_crank: { status: 409, retryable: true, message: "the market's engine state needs a refresh crank; retry shortly" },
  no_portfolio: { status: 409, retryable: false, message: "the wallet has no trading account on this market" },
  bad_portfolio: { status: 400, retryable: false, message: "portfolio is not this wallet's trading account on this market" },
  no_lp: { status: 503, retryable: true, message: "this market has no usable LP right now" },
  // safety caps
  slippage_cap_exceeded: { status: 422, retryable: false, message: "slippage is above the allowed maximum" },
  notional_cap_exceeded: { status: 422, retryable: false, message: "order notional is above the cap" },
  size_cap_exceeded: { status: 422, retryable: false, message: "order size is above the market's per-side maximum" },
  leverage_cap_exceeded: { status: 422, retryable: false, message: "leverage after this order would be above the cap" },
  reduce_only_violation: { status: 422, retryable: false, message: "a reduce-only order would grow or flip the position" },
  no_position: { status: 409, retryable: false, message: "there is no open position to close" },
  insufficient_margin: { status: 422, retryable: false, message: "not enough margin for this order" },
  insufficient_funds: { status: 422, retryable: false, message: "not enough funds for this transfer" },
  fee_raise_required: { status: 409, retryable: false, message: "the market needs a higher fee cap; ask again with maxFeeBps" },
  fee_above_max: { status: 422, retryable: false, message: "the market's fee cap is above maxFeeBps" },
  fee_unreadable: { status: 503, retryable: true, message: "market fee terms unreadable" },
  too_large: { status: 503, retryable: true, message: "the transaction does not fit one packet" },
  simulation_failed: { status: 422, retryable: false, message: "the transaction failed simulation" },
  // tx status
  bad_signature: { status: 400, retryable: false, message: "signature must be a base58 transaction signature" },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface OnchainError {
  code: number;
  /** The wrapper's name for the code; null for any other program's code (a number alone does not say whose table it is from). */
  name: string | null;
  /** Program that returned the code (the innermost failing program); null when it could not be determined. */
  program?: string | null;
  /** Index of the failing top-level instruction. */
  instructionIndex?: number;
}

/** An error the handler wrapper turns into the envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly extra: { onchain?: OnchainError; logs?: string[]; headers?: Record<string, string>; details?: Record<string, unknown> } = {},
  ) {
    super(message ?? ERROR_CATALOG[code].message);
    this.name = "ApiError";
    this.status = ERROR_CATALOG[code].status;
    this.retryable = ERROR_CATALOG[code].retryable;
  }
  body() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.extra.onchain ? { onchain: this.extra.onchain } : {}),
        ...(this.extra.details ? { details: this.extra.details } : {}),
        ...(this.extra.logs && this.extra.logs.length > 0 ? { logs: this.extra.logs } : {}),
      },
    };
  }
}

/** Strips URLs (RPC endpoints can carry an api-key in the path or query) from a message that is about to be logged. */
export function redactUrls(msg: string): string {
  return msg.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<url>");
}

/** An upstream 429 / rate-limit message (web3.js: "Server responded with 429 Too Many Requests"). */
export function looksRateLimited(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /\b429\b|too many requests|rate.?limit/i.test(m);
}

const NAMES = new Map<number, string>();
for (const [n, c] of Object.entries(WRAPPER_ERR)) NAMES.set(c, n);
for (const [n, c] of Object.entries(WRAPPER_ERR_V21)) NAMES.set(c, n);
for (const [c, info] of Object.entries(PERCOLATOR_ERRORS_V22)) NAMES.set(Number(c), info.name);

/** Name of a wrapper Custom(n), or null when unknown. */
export function onchainErrorName(code: number): string | null {
  return NAMES.get(code) ?? null;
}

/** The API code for a wrapper error the caller can act on; everything else stays `simulation_failed`. */
const ONCHAIN_TO_API: Record<string, ErrorCode> = {
  EngineInsufficientInitialMargin: "insufficient_margin",
  OracleStale: "market_stale",
  // 121: the engine's loss accounting is behind; any crank fixes it, so a retry a few slots later succeeds.
  EngineLossStale: "market_needs_crank",
  GrowthUtilisationFeeNotCovered: "fee_raise_required",
  LevGuardRefused: "leverage_cap_exceeded",
  GrowthLeverageExceeded: "leverage_cap_exceeded",
  PositionCapReached: "size_cap_exceeded",
};

export function apiCodeForOnchain(code: number): ErrorCode {
  const name = onchainErrorName(code);
  return (name && ONCHAIN_TO_API[name]) || "simulation_failed";
}

/** Custom(n) out of a simulation error JSON / message (`{"InstructionError":[i,{"Custom":n}]}`). */
export function customCodeOf(errOrMessage: unknown): number | null {
  const s = typeof errOrMessage === "string" ? errOrMessage : JSON.stringify(errOrMessage ?? null);
  const m = /"Custom"\s*:\s*(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}
