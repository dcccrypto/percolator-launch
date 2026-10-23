/**
 * Ordered RPC upstreams with fallback, shared by the browser proxy (`/api/rpc`) and the server-side Connection helper
 * (`lib/server-rpc.ts`).
 *
 * Why: with a single upstream (`DEVNET_RPC_URL`, a Helius key) an exhausted quota (HTTP 429 / "max usage reached") made every browser
 * call answer `{"code":-32603,"message":"Upstream RPC request failed"}` and the faucet say "Could not verify mint authority due to RPC
 * error": trade, Earn and Stake were unusable.
 *
 * Rules (security review of the proxy surface):
 *  - The fallback list comes from SERVER env only (`DEVNET_RPC_FALLBACK_URLS` / `MAINNET_RPC_FALLBACK_URLS`, comma-separated; never
 *    `NEXT_PUBLIC_*`, never request input). https only. Unset on devnet = the public devnet RPC; unset on mainnet = none.
 *  - A FALLBACK must be the same cluster as the deployment: its genesis hash is checked against the cluster's, once (cached). A
 *    mismatch is never used (and is re-checked only after a long delay). The primary is the operator's own setting and is not checked.
 *  - Switch on a transport error, a timeout, HTTP 401 / 403 / 408 / 429 / 5xx, a non-JSON 2xx body, or a quota JSON-RPC CODE (-32429 /
 *    -32005; never the message text, which a client can influence). Other 4xx answers are the request's own fault: no switch, no cooldown.
 *    A mutating request (sendTransaction) is moved on only after a DEFINITE pre-processing rejection and is never re-sent after an
 *    ambiguous failure. At most 3 upstream attempts and a 20 s budget per request; redirects are refused.
 *    A failed upstream is cooled down (30 s, doubling to 5 min); once its cooldown ends it is tried FIRST again (the primary re-probe), and
 *    one success resets it. When every upstream is cooling they are all tried anyway, soonest-ready first.
 *    A DEFINITE refusal (401/403/429, a quota code, a non-JSON 2xx) cools at once. An AMBIGUOUS one (timeout, network error, 408, 5xx)
 *    cools only on a second strike within {@link STRIKE_WINDOW_MS}, and never when the request was a heavy read (getProgramAccounts
 *    and friends): a client can make those slow on purpose, and must not be able to demote the primary for everyone that way.
 *    When every attempt was refused for RATE (429 / -32429 / -32005) the pool throws {@link UpstreamRateLimitedError}, so callers can
 *    answer HTTP 429 (web3.js's own back-off and `disableRetryOnRateLimit`, the app's "network busy" line) instead of a generic failure.
 *  - The method allowlist, batch limit and rate limit live in the route and apply before any upstream is chosen, so they are identical
 *    on every upstream.
 *  - Nothing that identifies an upstream (URL, host, key) is ever returned to a caller, put in a header, or logged: failures surface as
 *    one generic error, and any upstream body that is passed through is scrubbed of the configured URLs, hosts and keys.
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";

export type RpcNetwork = "devnet" | "mainnet";

/** Genesis hashes of the two clusters this app talks to. */
export const CLUSTER_GENESIS: Readonly<Record<RpcNetwork, string>> = Object.freeze({
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
});

/** The devnet default when `DEVNET_RPC_FALLBACK_URLS` is unset. */
export const DEFAULT_DEVNET_FALLBACK = "https://api.devnet.solana.com";

const MAX_FALLBACKS = 4;

export interface UpstreamSpec {
  /** Opaque id (hash of the URL); safe to keep in memory, never sent anywhere. */
  id: string;
  url: string;
  headers: Record<string, string>;
  primary: boolean;
}

const idOf = (url: string): string => createHash("sha256").update(url).digest("hex").slice(0, 16);

/** Parse a comma-separated URL list: https only, valid URL, deduplicated, at most {@link MAX_FALLBACKS}. Invalid entries are dropped silently. */
export function parseFallbackUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" || !u.hostname) continue;
      if (!out.includes(s)) out.push(s);
    } catch {
      /* not a URL */
    }
    if (out.length >= MAX_FALLBACKS) break;
  }
  return out;
}

/** The configured fallbacks for a network (server env only). */
export function fallbackUrlsFor(network: RpcNetwork, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = network === "devnet" ? env.DEVNET_RPC_FALLBACK_URLS : env.MAINNET_RPC_FALLBACK_URLS;
  if (raw === undefined) return network === "devnet" ? [DEFAULT_DEVNET_FALLBACK] : [];
  return parseFallbackUrls(raw);
}

/** Primary first, then the fallbacks in order (a fallback equal to the primary is dropped). */
export function buildUpstreams(network: RpcNetwork, primary: { url: string; headers: Record<string, string> }, env: NodeJS.ProcessEnv = process.env): UpstreamSpec[] {
  const list: UpstreamSpec[] = [{ id: idOf(primary.url), url: primary.url, headers: primary.headers, primary: true }];
  for (const url of fallbackUrlsFor(network, env)) {
    if (url === primary.url) continue;
    list.push({ id: idOf(url), url, headers: { "Content-Type": "application/json" }, primary: false });
  }
  return list;
}

/** The only error the pool throws: generic on purpose. */
export class UpstreamUnavailableError extends Error {
  constructor() {
    super("RPC upstream unavailable");
    this.name = "UpstreamUnavailableError";
  }
}

/** Every attempt was refused for rate (HTTP 429 or a quota code). Still generic: no upstream detail. */
export class UpstreamRateLimitedError extends UpstreamUnavailableError {
  constructor() {
    super();
    this.name = "UpstreamRateLimitedError";
  }
}

/** An upstream that cannot serve us right now (counts toward its cooldown). Never carries upstream detail. */
class UpstreamFailure extends Error {
  /** The request may have been processed (timeout, dropped connection, 5xx after the body was sent). */
  readonly ambiguous: boolean;
  /** Refused for rate: HTTP 429 or a quota JSON-RPC code. */
  readonly rateLimited: boolean;
  constructor(ambiguous: boolean, rateLimited = false) {
    super("upstream failure");
    this.ambiguous = ambiguous;
    this.rateLimited = rateLimited;
  }
}

/** The request itself was refused (a 4xx that is not about us): not the upstream's fault, so no cooldown and no failover. */
class RequestRefused extends Error {}

/** HTTP statuses that mean "this upstream will not serve you" and that DEFINITELY happened before any processing. */
const DEFINITE_REJECT_STATUS = (s: number): boolean => s === 401 || s === 403 || s === 429;
/** HTTP statuses that count against an upstream (cooldown). 5xx and 408 may arrive after the body was processed. */
const COOLING_STATUS = (s: number): boolean => DEFINITE_REJECT_STATUS(s) || s === 408 || s >= 500;
/** JSON-RPC error CODES (never the message text, which a client can influence) for quota / unhealthy upstream. */
const QUOTA_CODES = new Set([-32429, -32005]);

function isQuotaItem(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const e = (x as { error?: { code?: unknown } }).error;
  return !!e && typeof e === "object" && typeof e.code === "number" && QUOTA_CODES.has(e.code);
}

/** The upstream answered, but only to say it will not serve us (quota / unhealthy), by CODE. A batch fails only if EVERY item does. */
export function isQuotaBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0 && body.every(isQuotaItem);
  return isQuotaItem(body);
}

/**
 * Allowlisted reads a client can make slow or heavy on purpose (large scans, history). Their timeouts / 5xx never cool an upstream:
 * the upstream may be fine and the request the problem (AUD-RAPP #3563 L2).
 */
export const HEAVY_RPC_METHODS: ReadonlySet<string> = new Set([
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getBlock",
  "getMultipleAccounts",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
]);

/** Two ambiguous failures within this window cool an upstream; one does not. */
export const STRIKE_WINDOW_MS = 60_000;

function isHeavyBody(body: unknown): boolean {
  const one = (x: unknown): boolean => !!x && typeof x === "object" && HEAVY_RPC_METHODS.has(String((x as { method?: unknown }).method));
  return Array.isArray(body) ? body.some(one) : one(body);
}

/** Methods that change state: never re-sent after an ambiguous failure (the client checks getSignatureStatuses instead). */
export const MUTATING_RPC_METHODS: ReadonlySet<string> = new Set(["sendTransaction", "requestAirdrop"]);

function isMutatingBody(body: unknown): boolean {
  const one = (x: unknown): boolean => !!x && typeof x === "object" && MUTATING_RPC_METHODS.has(String((x as { method?: unknown }).method));
  return Array.isArray(body) ? body.some(one) : one(body);
}

/** The first signature of a sendTransaction's raw tx (base64 encoding, as the app sends), or null when it cannot be read. */
export function sendTransactionSignature(body: unknown): string | null {
  try {
    const params = (body as { params?: unknown[] }).params;
    const raw = params?.[0];
    const enc = (params?.[1] as { encoding?: string } | undefined)?.encoding ?? "base58";
    if (typeof raw !== "string") return null;
    const bytes = enc === "base64" ? Uint8Array.from(Buffer.from(raw, "base64")) : bs58.decode(raw);
    const count = bytes[0];
    if (count === undefined || count === 0 || count >= 128 || bytes.length < 1 + 64) return null;
    return bs58.encode(bytes.subarray(1, 65));
  } catch {
    return null;
  }
}

/** The runtime's exact answer to a duplicate: JSON-RPC code -32002 with this phrase. Anything looser (custom messages) is not a success. */
const ALREADY_PROCESSED_CODE = -32002;
const ALREADY_PROCESSED_PHRASE = "This transaction has already been processed";

export interface PoolDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per attempt. */
  timeoutMs?: number;
  /** Across all attempts of one request. */
  deadlineMs?: number;
  /** Most upstream attempts one request may make (the genesis probe is shared and not counted). */
  maxAttempts?: number;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  /** How long a wrong-cluster verdict is kept before the fallback is checked again. */
  mismatchRecheckMs?: number;
  /** Receives a short, URL-free line. */
  warn?: (line: string) => void;
}

interface Health {
  fails: number;
  coolUntil: number;
  /** Time of an ambiguous failure not yet acted on (the first strike), or 0. */
  strikeAt: number;
}

export interface PoolResult {
  json: unknown;
  /** The HTTP status the answering upstream returned. */
  status: number;
}

export class UpstreamPool {
  private readonly health = new Map<string, Health>();
  private readonly cluster = new Map<string, { ok: boolean; until: number }>();
  private readonly probing = new Map<string, Promise<boolean>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly deadlineMs: number;
  private readonly maxAttempts: number;
  private readonly base: number;
  private readonly max: number;
  private readonly recheck: number;
  private readonly warn: (line: string) => void;

  constructor(d: PoolDeps = {}) {
    this.fetchImpl = d.fetchImpl ?? ((...a) => fetch(...a));
    this.now = d.now ?? Date.now;
    this.timeoutMs = d.timeoutMs ?? 10_000;
    this.deadlineMs = d.deadlineMs ?? 20_000;
    this.maxAttempts = d.maxAttempts ?? 3;
    this.base = d.cooldownBaseMs ?? 30_000;
    this.max = d.cooldownMaxMs ?? 300_000;
    this.recheck = d.mismatchRecheckMs ?? 600_000;
    this.warn = d.warn ?? ((l) => console.warn(l));
  }

  private coolUntil(u: UpstreamSpec): number {
    return this.health.get(u.id)?.coolUntil ?? 0;
  }

  /**
   * Count a failure against `u`. A definite refusal cools at once. An ambiguous one is a first strike (no cooldown), and cools only if
   * another ambiguous failure lands within STRIKE_WINDOW_MS; for a heavy read it is ignored entirely.
   */
  private markFail(u: UpstreamSpec, how: { ambiguous: boolean; heavy?: boolean } = { ambiguous: false }): void {
    const h = this.health.get(u.id) ?? { fails: 0, coolUntil: 0, strikeAt: 0 };
    if (how.ambiguous) {
      if (how.heavy) return;
      const now = this.now();
      if (h.strikeAt === 0 || now - h.strikeAt > STRIKE_WINDOW_MS) {
        h.strikeAt = now;
        this.health.set(u.id, h);
        return;
      }
    }
    h.strikeAt = 0;
    h.fails += 1;
    h.coolUntil = this.now() + Math.min(this.base * 2 ** (h.fails - 1), this.max);
    this.health.set(u.id, h);
  }

  private markOk(u: UpstreamSpec): void {
    this.health.delete(u.id);
  }

  /** Is this upstream cooling down right now? (exposed for tests and health output; carries no URL) */
  isCooling(u: UpstreamSpec): boolean {
    return this.coolUntil(u) > this.now();
  }

  /**
   * One JSON-RPC POST to one upstream. Throws {@link UpstreamFailure} when the upstream cannot serve us (transport error, 401/403/408/
   * 429/5xx, a quota CODE, a non-JSON 2xx body) and {@link RequestRefused} for any other non-JSON / error status (the request's own fault).
   * Never reads JSON-RPC message text.
   */
  private async attempt(u: UpstreamSpec, body: unknown, budgetMs: number, signal?: AbortSignal): Promise<PoolResult> {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, budgetMs)));
    let res: Response;
    try {
      res = await this.fetchImpl(u.url, {
        method: "POST",
        headers: u.headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new UpstreamFailure(true); // timeout, reset, DNS, redirect: the body may or may not have been processed
    }
    const status = typeof res.status === "number" ? res.status : 200;
    if (COOLING_STATUS(status)) throw new UpstreamFailure(!DEFINITE_REJECT_STATUS(status), status === 429);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (status >= 200 && status < 300) throw new UpstreamFailure(true); // a 2xx that is not JSON: a broken upstream
      throw new RequestRefused(); // a plain-text 4xx: the request's own fault
    }
    if (isQuotaBody(json)) throw new UpstreamFailure(false, true); // refused before processing (quota / unhealthy)
    return { json, status };
  }

  /** getSignatureStatuses on one upstream: the signature exists and did not fail. */
  private async signatureKnown(u: UpstreamSpec, sig: string, budgetMs: number, signal?: AbortSignal): Promise<boolean> {
    try {
      const r = (await this.attempt(u, { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[sig], { searchTransactionHistory: true }] }, budgetMs, signal)).json as {
        result?: { value?: ({ err?: unknown } | null)[] };
      };
      const st = r?.result?.value?.[0];
      return !!st && (st.err === null || st.err === undefined);
    } catch {
      return false;
    }
  }

  /** A fallback may serve only if it is on the deployment's cluster (genesis hash, cached; one probe at a time per upstream). */
  private clusterOk(u: UpstreamSpec, network: RpcNetwork, budgetMs: number): Promise<boolean> {
    const c = this.cluster.get(u.id);
    if (c && (c.ok || c.until > this.now())) return Promise.resolve(c.ok);
    const running = this.probing.get(u.id);
    if (running) return running;
    const p = (async () => {
      try {
        const r = (await this.attempt(u, { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }, budgetMs)).json as { result?: unknown };
        const ok = typeof r?.result === "string" && r.result === CLUSTER_GENESIS[network];
        this.cluster.set(u.id, { ok, until: ok ? Infinity : this.now() + this.recheck });
        if (!ok) this.warn(`[rpc-upstreams] a ${network} fallback answered from a different cluster: ignored`);
        return ok;
      } catch (e) {
        if (e instanceof UpstreamFailure) this.markFail(u, { ambiguous: e.ambiguous }); // could not tell: not cached, tried again later
        return false;
      } finally {
        this.probing.delete(u.id);
      }
    })();
    this.probing.set(u.id, p);
    return p;
  }

  /**
   * POST `body` to the first healthy upstream; returns the parsed JSON and the answering upstream's status. Throws
   * {@link UpstreamUnavailableError} (generic) when none could answer.
   *
   * A MUTATING request (sendTransaction) is moved to the next upstream only after a DEFINITE pre-processing rejection (401/403/429 or
   * a quota code). After an ambiguous failure (timeout, network error, 5xx) it is NOT re-sent: the generic error goes back and the
   * client checks getSignatureStatuses. An "already processed" answer to a re-sent tx is a success.
   */
  async postRaw(upstreams: readonly UpstreamSpec[], body: unknown, network: RpcNetwork, opts: { signal?: AbortSignal } = {}): Promise<PoolResult> {
    const started = this.now();
    const mutating = isMutatingBody(body);
    const heavy = isHeavyBody(body);
    // All-429: true while every attempt so far was refused for rate.
    let failures = 0;
    let rateLimited = 0;
    const ready = upstreams.filter((u) => !this.isCooling(u));
    const order = ready.length > 0 ? ready : [...upstreams].sort((a, b) => this.coolUntil(a) - this.coolUntil(b));
    let attempts = 0;
    let resent = false;
    for (const u of order) {
      if (opts.signal?.aborted) break;
      const left = this.deadlineMs - (this.now() - started);
      if (left <= 0 || attempts >= this.maxAttempts) break;
      if (!u.primary && !(await this.clusterOk(u, network, left))) continue;
      attempts += 1;
      try {
        const r = await this.attempt(u, body, this.deadlineMs - (this.now() - started), opts.signal);
        this.markOk(u);
        if (mutating && resent && !Array.isArray(body)) {
          const err = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
          if (err && err.code === ALREADY_PROCESSED_CODE && typeof err.message === "string" && err.message.includes(ALREADY_PROCESSED_PHRASE)) {
            const sig = sendTransactionSignature(body);
            // Confirm with the same upstream that the signature really is known to the cluster before calling it a success.
            if (sig && (await this.signatureKnown(u, sig, this.deadlineMs - (this.now() - started), opts.signal))) {
              return { json: { jsonrpc: "2.0", id: (body as { id?: unknown }).id ?? null, result: sig }, status: 200 };
            }
          }
        }
        return r;
      } catch (e) {
        if (e instanceof RequestRefused) break; // the request's own fault: no cooldown, no other upstream
        const ambiguous = e instanceof UpstreamFailure ? e.ambiguous : true;
        this.markFail(u, { ambiguous, heavy });
        failures += 1;
        if (e instanceof UpstreamFailure && e.rateLimited) rateLimited += 1;
        if (mutating) {
          if (e instanceof UpstreamFailure && e.ambiguous) break; // may have been processed: never re-send
          resent = true;
        }
      }
    }
    if (failures > 0 && rateLimited === failures) throw new UpstreamRateLimitedError();
    throw new UpstreamUnavailableError();
  }

  /** {@link postRaw} returning only the parsed JSON. */
  async post(upstreams: readonly UpstreamSpec[], body: unknown, network: RpcNetwork, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
    return (await this.postRaw(upstreams, body, network, opts)).json;
  }
}

/** Process-wide pool: cooldowns and cluster verdicts are shared by the proxy route and the server Connection helper. */
let shared: UpstreamPool | null = null;
export function sharedUpstreamPool(): UpstreamPool {
  return (shared ??= new UpstreamPool());
}
/** Test seam. */
export function __setSharedUpstreamPoolForTest(p: UpstreamPool | null): void {
  shared = p;
}

// ── Redaction ──────────────────────────────────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const KEY_PARAM_RE = /(api[-_]?key|token|secret|auth)=([^&\s"'<>]+)/gi;

/** The strings that identify the configured upstreams: full URL, host, and each query value (keys). */
export function secretsOf(upstreams: readonly UpstreamSpec[]): string[] {
  const out = new Set<string>();
  for (const u of upstreams) {
    out.add(u.url);
    try {
      const p = new URL(u.url);
      out.add(p.host);
      out.add(p.hostname);
      for (const v of p.searchParams.values()) if (v.length >= 6) out.add(v);
      for (const seg of p.pathname.split("/")) if (seg.length >= 12) out.add(seg);
      if (p.password) out.add(p.password);
      if (p.username) out.add(p.username);
    } catch {
      /* ignore */
    }
  }
  return [...out].filter((s) => s.length >= 4);
}

/** Free text (log lines, error messages): every URL and key-looking parameter replaced. */
export function redactText(text: string, upstreams: readonly UpstreamSpec[] = []): string {
  let t = text;
  for (const s of secretsOf(upstreams)) t = t.split(s).join("[redacted]");
  return t.replace(URL_RE, "[redacted-url]").replace(KEY_PARAM_RE, "$1=[redacted]");
}

/** A parsed upstream response about to go to the browser: scrubbed only if it mentions an upstream (no cost otherwise). */
export function redactJson<T>(data: T, upstreams: readonly UpstreamSpec[]): T {
  const secrets = secretsOf(upstreams);
  let s: string;
  try {
    s = JSON.stringify(data);
  } catch {
    return data;
  }
  if (s === undefined || !secrets.some((x) => s.includes(x))) return data;
  return JSON.parse(redactText(s, upstreams)) as T;
}

/** An error as a short URL-free log line. */
export function safeErrorText(e: unknown, upstreams: readonly UpstreamSpec[] = []): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redactText(msg, upstreams).slice(0, 200);
}
