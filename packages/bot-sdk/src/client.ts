/**
 * Fetch client for /api/v1. It reads, quotes and BUILDS unsigned transactions. It never signs and never sends: it has
 * no code path that takes a private key, and the returned base64 transactions are for the caller's own wallet.
 */
import { BotApiError, isErrorEnvelope } from "./errors";
import { parseSse } from "./sse";
import type {
  Account, BuildResponse, BuildResult, CancelResponse, CloseRequest, DepositRequest, DepthResponse, Funding, Health, History, MarketList,
  MarketOne, OrderRequest, QuoteResponse, StreamEvent, TxState, TxStatus, WithdrawRequest, MarketEvent,
} from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Origin of the deployment, for example https://play.example. `/api/v1` is added. */
  baseUrl: string;
  /** pbk_<id>_<secret>. Optional for reads. Sent as a Bearer token and never logged. */
  apiKey?: string;
  fetch?: FetchLike;
  /** Retries after the first attempt, for retryable errors and 429. Default 3. */
  maxRetries?: number;
  /** First backoff step in ms; doubles each attempt with jitter. Default 250. */
  retryBaseMs?: number;
  /** Longest wait between attempts, and the longest Retry-After the client will sit through. Default 30000. */
  maxDelayMs?: number;
  /** Per-request timeout in ms. Default 20000. */
  timeoutMs?: number;
  /** Test hooks. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface BuildOptions extends CallOptions {
  /** Default: a fresh random key per call, reused on every retry of that call. */
  idempotencyKey?: string;
}

export interface WaitForTxOptions extends CallOptions {
  /** From the build response; lets the API tell `expired` from `unknown`. */
  lastValidBlockHeight?: number;
  /** Stop at `confirmed` (default) or wait for `finalized`. */
  until?: "confirmed" | "finalized";
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (s: TxStatus) => void;
}

export interface StreamOptions extends CallOptions {
  /** Slot of the last event you already have. */
  lastEventId?: string;
  /** Reconnects before giving up (default unlimited). */
  maxReconnects?: number;
  /** Reconnect if nothing arrives for this long. Heartbeats come every 10 s. Default 30000. */
  idleTimeoutMs?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export const newIdempotencyKey = (): string => `pbs-${globalThis.crypto.randomUUID()}`;

type Query = Record<string, string | number | undefined>;

export class BotClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly f: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(o: ClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.apiKey = o.apiKey;
    this.f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = o.maxRetries ?? 3;
    this.retryBaseMs = o.retryBaseMs ?? 250;
    this.maxDelayMs = o.maxDelayMs ?? 30_000;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.sleep = o.sleep ?? defaultSleep;
    this.random = o.random ?? Math.random;
  }

  // reads

  health(o?: CallOptions) {
    return this.get<Health>("/health", undefined, o);
  }
  openapi(o?: CallOptions) {
    return this.get<Record<string, unknown>>("/openapi.json", undefined, o);
  }
  markets(o?: CallOptions) {
    return this.get<MarketList>("/markets", undefined, o);
  }
  market(market: string, o?: CallOptions) {
    return this.get<MarketOne>(`/markets/${seg(market)}`, undefined, o);
  }
  funding(market: string, o?: CallOptions) {
    return this.get<Funding>(`/markets/${seg(market)}/funding`, undefined, o);
  }
  /** `size` is signed engine q as a decimal string: above 0 buy, below 0 sell. */
  quote(market: string, q: { size: string | bigint; slippageBps?: number }, o?: CallOptions) {
    return this.get<QuoteResponse>(`/markets/${seg(market)}/quote`, { size: String(q.size), slippageBps: q.slippageBps }, o);
  }
  depth(market: string, o?: CallOptions) {
    return this.get<DepthResponse>(`/markets/${seg(market)}/depth`, undefined, o);
  }
  account(wallet: string, q: { market?: string } = {}, o?: CallOptions) {
    return this.get<Account>(`/accounts/${seg(wallet)}`, { market: q.market }, o);
  }
  history(wallet: string, q: { limit?: number; before?: string } = {}, o?: CallOptions) {
    return this.get<History>(`/accounts/${seg(wallet)}/history`, q, o);
  }
  txStatus(signature: string, q: { lastValidBlockHeight?: number } = {}, o?: CallOptions) {
    return this.get<TxStatus>(`/tx/${seg(signature)}`, q, o);
  }

  // builders (unsigned)

  buildOrder(req: OrderRequest, o?: BuildOptions) {
    return this.build("/orders", req, o);
  }
  buildClose(req: CloseRequest, o?: BuildOptions) {
    return this.build("/positions/close", req, o);
  }
  buildDeposit(req: DepositRequest, o?: BuildOptions) {
    return this.build("/deposits", req, o);
  }
  buildWithdraw(req: WithdrawRequest, o?: BuildOptions) {
    return this.build("/withdrawals", req, o);
  }
  /** Stops the API handing out that build again. Nothing is cancelled on chain (v2.2 has no resting orders). */
  cancelOrder(idempotencyKey: string, o?: CallOptions) {
    return this.request<CancelResponse>("POST", "/orders/cancel", { body: { idempotencyKey }, signal: o?.signal });
  }

  /** Polls until the tx is confirmed (or finalized), failed or expired. Throws `timeout` if none happens in time. */
  async waitForTx(signature: string, o: WaitForTxOptions = {}): Promise<TxStatus> {
    const interval = o.intervalMs ?? 1_000;
    const deadline = Date.now() + (o.timeoutMs ?? 90_000);
    const done = new Set<TxState>(o.until === "finalized" ? ["finalized", "failed", "expired"] : ["confirmed", "finalized", "failed", "expired"]);
    for (;;) {
      const s = await this.txStatus(signature, { lastValidBlockHeight: o.lastValidBlockHeight }, { signal: o.signal });
      o.onUpdate?.(s);
      if (done.has(s.status)) return s;
      if (Date.now() + interval > deadline) {
        throw new BotApiError({ code: "timeout", message: `transaction still ${s.status} after the wait limit`, status: 0, retryable: false });
      }
      await this.sleep(interval, o.signal);
    }
  }

  /**
   * Market snapshots over SSE. Reconnects on its own (the server ends each stream after about 55 s) with Last-Event-ID, and
   * after network errors or an idle stream. Ends when `signal` aborts or `maxReconnects` runs out. A non-retryable API
   * error (bad market, bad key) throws.
   */
  async *stream(markets: string[], o: StreamOptions = {}): AsyncGenerator<StreamEvent> {
    const url = this.url("/stream", { markets: markets.join(",") });
    const idleMs = o.idleTimeoutMs ?? 30_000;
    const maxRe = o.maxReconnects ?? Number.POSITIVE_INFINITY;
    let lastId = o.lastEventId;
    let retryMs = 2_000;
    let reconnects = 0;
    for (;;) {
      if (o.signal?.aborted) return;
      const conn = new AbortController();
      const onAbort = () => conn.abort();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => conn.abort(), idleMs);
      };
      let ended = false;
      try {
        arm();
        const res = await this.f(url, { headers: this.headers({ Accept: "text/event-stream", ...(lastId ? { "Last-Event-ID": lastId } : {}) }), signal: conn.signal });
        if (!res.ok || !res.body) {
          throw await this.toError(res);
        }
        for await (const ev of parseSse(res.body, conn.signal)) {
          arm();
          if (ev.retry !== null) retryMs = ev.retry;
          if (ev.id !== null) lastId = ev.id;
          if (ev.event === "end") {
            ended = true;
            break;
          }
          const data = safeJson(ev.data);
          if (data === undefined) continue;
          if (ev.event === "market") yield { type: "market", id: ev.id, data: data as MarketEvent };
          else if (ev.event === "heartbeat") yield { type: "heartbeat", id: ev.id, data: data as { slot: number; observedAt: string } };
          else if (ev.event === "error") yield { type: "error", id: ev.id, data: data as { code: string; retryable: boolean } };
        }
      } catch (e) {
        if (o.signal?.aborted) return;
        if (e instanceof BotApiError && !e.retryable) throw e;
        if (!(e instanceof BotApiError) && !(e instanceof Error)) throw e;
        if (reconnects >= maxRe) throw e instanceof BotApiError ? e : new BotApiError({ code: "network_error", message: "stream connection failed", status: 0, retryable: true });
        retryMs = e instanceof BotApiError && e.retryAfterMs ? e.retryAfterMs : retryMs;
      } finally {
        clearTimeout(idle);
        o.signal?.removeEventListener("abort", onAbort);
        conn.abort();
      }
      if (o.signal?.aborted) return;
      if (reconnects >= maxRe) return;
      reconnects++;
      if (!ended) {
        try {
          await this.sleep(retryMs, o.signal);
        } catch {
          return;
        }
      }
    }
  }

  // plumbing

  private async build(path: string, body: object, o: BuildOptions = {}): Promise<BuildResult> {
    const idempotencyKey = o.idempotencyKey ?? newIdempotencyKey();
    const res = await this.request<BuildResponse>("POST", path, { body, idempotencyKey, signal: o.signal });
    return { ...res, idempotencyKey };
  }

  private get<T>(path: string, query?: Query, o?: CallOptions) {
    return this.request<T>("GET", path, { query, signal: o?.signal });
  }

  private url(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return `${this.base}/api/v1${path}${s ? `?${s}` : ""}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), ...extra };
  }

  private async toError(res: Response): Promise<BotApiError> {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    if (isErrorEnvelope(parsed)) return BotApiError.fromEnvelope(parsed, res.status, res.headers);
    return new BotApiError({ code: "bad_response", message: `unexpected HTTP ${res.status} without an API error body`, status: res.status, retryable: res.status >= 500 || res.status === 429, requestId: res.headers.get("x-request-id") ?? undefined });
  }

  private async request<T>(method: "GET" | "POST", path: string, o: { query?: Query; body?: object; idempotencyKey?: string; signal?: AbortSignal }): Promise<T> {
    const url = this.url(path, o.query);
    for (let attempt = 0; ; attempt++) {
      let err: BotApiError;
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, this.timeoutMs);
      try {
        const res = await this.f(url, {
          method,
          headers: this.headers({
            Accept: "application/json",
            ...(o.body ? { "Content-Type": "application/json" } : {}),
            ...(o.idempotencyKey ? { "Idempotency-Key": o.idempotencyKey } : {}),
          }),
          ...(o.body ? { body: JSON.stringify(o.body) } : {}),
          signal: ctl.signal,
        });
        if (res.ok) {
          try {
            return (await res.json()) as T;
          } catch {
            throw new BotApiError({ code: "bad_response", message: "response was not JSON", status: res.status, retryable: false });
          }
        }
        err = await this.toError(res);
      } catch (e) {
        if (e instanceof BotApiError) throw e;
        if (o.signal?.aborted) throw e;
        err = new BotApiError({ code: timedOut ? "timeout" : "network_error", message: timedOut ? "request timed out" : "network error", status: 0, retryable: true });
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
      if (!err.retryable || attempt >= this.maxRetries) throw err;
      if (err.retryAfterMs !== undefined && err.retryAfterMs > this.maxDelayMs) throw err;
      await this.sleep(err.retryAfterMs ?? this.backoff(attempt), o.signal);
    }
  }

  private backoff(attempt: number): number {
    const step = Math.min(this.maxDelayMs, this.retryBaseMs * 2 ** attempt);
    return Math.round(step * (0.5 + this.random() / 2));
  }
}

function seg(s: string): string {
  return encodeURIComponent(s);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
