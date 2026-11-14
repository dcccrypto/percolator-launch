import type { ClientErrorCode, ErrorCode, ErrorEnvelope, OnchainError } from "./types";

/** Every failure the client raises. Branch on `code` and `retryable`, not on `message`. */
export class BotApiError extends Error {
  readonly code: ErrorCode | ClientErrorCode;
  /** HTTP status; 0 when there was no response. */
  readonly status: number;
  readonly retryable: boolean;
  readonly onchain?: OnchainError;
  readonly details?: Record<string, unknown>;
  readonly logs?: string[];
  readonly requestId?: string;
  /** Server hint from Retry-After, in ms. */
  readonly retryAfterMs?: number;

  constructor(init: {
    code: ErrorCode | ClientErrorCode;
    message: string;
    status: number;
    retryable: boolean;
    onchain?: OnchainError;
    details?: Record<string, unknown>;
    logs?: string[];
    requestId?: string;
    retryAfterMs?: number;
  }) {
    super(init.message);
    this.name = "BotApiError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.onchain = init.onchain;
    this.details = init.details;
    this.logs = init.logs;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  static fromEnvelope(env: ErrorEnvelope, status: number, headers: Headers): BotApiError {
    const e = env.error;
    const ra = Number(headers.get("retry-after"));
    return new BotApiError({
      code: e.code,
      message: e.message,
      status,
      retryable: e.retryable,
      onchain: e.onchain,
      details: e.details,
      logs: e.logs,
      requestId: headers.get("x-request-id") ?? undefined,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
    });
  }
}

export function isErrorEnvelope(v: unknown): v is ErrorEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const e = (v as { error?: unknown }).error;
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" && typeof (e as { retryable?: unknown }).retryable === "boolean";
}
