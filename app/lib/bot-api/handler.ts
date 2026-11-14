/**
 * The one wrapper every /api/v1 route goes through, in this order:
 *   request id -> kill switch -> auth (key or anonymous read) -> scope -> weighted rate limit -> body (size cap, JSON,
 *   expiresAfter) -> idempotency -> handler -> envelope + headers -> log line + metrics.
 * Handlers return plain data or throw ApiError; they never build their own error bodies.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/get-client-ip";
import { ApiError, looksRateLimited, redactUrls } from "./errors";
import { botApiDisabledReason, anonReadsAllowed, MAX_BODY_BYTES } from "./config";
import { keyFromHeaders, verifyKey, type Principal, type Scope } from "./keys";
import { checkLimit, noteAuthFailure, authLocked, type LimitResult } from "./limits";
import { beginIdempotent, finishIdempotent, bodyHash, validIdempotencyKey } from "./idempotency";
import { record } from "./metrics";

export interface RouteSpec {
  /** Template for logs/metrics, e.g. "/v1/markets/{market}". */
  route: string;
  scope: Scope;
  weight: number;
  /** Draws on the global build budget. */
  build?: boolean;
  /** Reads a JSON body. */
  body?: boolean;
  /** Honours Idempotency-Key. */
  idempotent?: boolean;
  /** Per-request deadline for the handler (RPC reads/simulations), ms. Default RPC_DEADLINE_MS. */
  deadlineMs?: number;
}

/** A handler that has not answered by now is a failed upstream: retryable rpc_unavailable, not a hung function. */
export const RPC_DEADLINE_MS = 20_000;

/** The handler's own promise, or rpc_unavailable at the deadline (the timer is always cleared). */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ApiError("rpc_unavailable", "the upstream RPC did not answer in time, try again")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** Unexpected throws that are really an upstream 429 become retryable rpc_unavailable, not a 500. */
function classify(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return looksRateLimited(e) ? new ApiError("rpc_unavailable", "the Solana RPC is rate limiting, try again shortly") : new ApiError("internal");
}

export interface Ctx<P> {
  req: NextRequest;
  reqId: string;
  principal: Principal;
  params: P;
  body: Record<string, unknown>;
  /** Handlers count what they spend; it goes in the log line. */
  meta: { rpcCalls: number; sims: number };
}

export interface HandlerResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** JSON with bigint as decimal strings (amounts can exceed 2^53). */
export function toJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

function respond(status: number, body: unknown, headers: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function limitHeaders(l: LimitResult | null): Record<string, string> {
  if (!l) return {};
  return { "X-RateLimit-Limit": String(l.limit), "X-RateLimit-Remaining": String(l.remaining), "X-RateLimit-Reset": String(l.resetSec) };
}

async function authenticate(req: NextRequest, spec: RouteSpec, ip: string): Promise<Principal> {
  const raw = keyFromHeaders(req.headers);
  if (raw) {
    if (await authLocked(ip)) throw new ApiError("rate_limited", "too many invalid API keys from this address", { headers: { "Retry-After": "60" } });
    const rec = await verifyKey(raw);
    if (!rec) {
      await noteAuthFailure(ip);
      throw new ApiError("unauthorized");
    }
    return { kind: "key", id: rec.id, scopes: rec.scopes, tier: rec.tier };
  }
  if (spec.scope === "read" && anonReadsAllowed()) return { kind: "anon", id: `ip:${ip}`, scopes: ["read"], tier: "anon" };
  throw new ApiError("unauthorized", spec.scope === "read" ? "an API key is required" : `an API key with the "${spec.scope}" scope is required`);
}

export function botRoute<P = Record<string, string>>(spec: RouteSpec, fn: (ctx: Ctx<P>) => Promise<HandlerResult>) {
  return async (req: NextRequest, routeCtx?: { params?: Promise<P> | P }): Promise<NextResponse> => {
    const t0 = Date.now();
    const reqId = randomUUID();
    const meta = { rpcCalls: 0, sims: 0 };
    let principal: Principal | null = null;
    let limit: LimitResult | null = null;
    let idem: "new" | "replay" | null = null;
    let status = 200;
    let code: string | null = null;
    let res: NextResponse;
    const base = () => ({ "X-Request-Id": reqId, ...limitHeaders(limit) });
    try {
      const off = botApiDisabledReason();
      if (off) throw new ApiError("disabled", off);
      const ip = getClientIp(req);
      principal = await authenticate(req, spec, ip);
      if (!principal.scopes.includes(spec.scope)) throw new ApiError("forbidden_scope");
      limit = await checkLimit(principal, spec.weight, { build: spec.build });
      if (!limit.allowed) throw new ApiError("rate_limited", undefined, { headers: { "Retry-After": String(limit.resetSec) } });

      let body: Record<string, unknown> = {};
      let rawBody = "";
      if (spec.body) {
        const len = Number(req.headers.get("content-length") ?? "0");
        if (len > MAX_BODY_BYTES) throw new ApiError("payload_too_large");
        rawBody = await req.text();
        if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) throw new ApiError("payload_too_large");
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          throw new ApiError("bad_request", "body must be JSON");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ApiError("bad_request", "body must be a JSON object");
        body = parsed as Record<string, unknown>;
        if (body.expiresAfter !== undefined) {
          const e = body.expiresAfter;
          if (typeof e !== "number" || !Number.isSafeInteger(e) || e <= 0) throw new ApiError("bad_request", "expiresAfter must be unix milliseconds");
          if (e < Date.now()) throw new ApiError("request_expired");
        }
      }

      const idemKey = spec.idempotent ? req.headers.get("idempotency-key") : null;
      const hash = idemKey ? bodyHash(`${spec.route}\n${req.nextUrl.pathname}\n${rawBody}`) : "";
      if (idemKey !== null && spec.idempotent) {
        if (!validIdempotencyKey(idemKey)) throw new ApiError("bad_request", "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]");
        const b = await beginIdempotent(principal.id, idemKey, hash);
        if (b.kind === "conflict") throw new ApiError("idempotency_conflict");
        if (b.kind === "in_progress") throw new ApiError("idempotency_in_progress", undefined, { headers: { "Retry-After": "1" } });
        if (b.kind === "cancelled") throw new ApiError("order_cancelled");
        if (b.kind === "replay") {
          idem = "replay";
          status = b.res.status;
          res = respond(status, b.res.body, { ...base(), "Idempotent-Replayed": "true" });
          return res;
        }
        idem = "new";
      }

      const params = ((await routeCtx?.params) ?? {}) as P;
      let out: HandlerResult;
      try {
        out = await withDeadline(fn({ req, reqId, principal, params, body, meta }), spec.deadlineMs ?? RPC_DEADLINE_MS);
      } catch (e) {
        if (idemKey && idem === "new") {
          const err = classify(e);
          await finishIdempotent(principal.id, idemKey, hash, { status: err.status, body: null });
        }
        throw e;
      }
      status = out.status ?? 200;
      const json = toJson(out.body);
      if (idemKey && idem === "new") await finishIdempotent(principal.id, idemKey, hash, { status, body: json });
      res = respond(status, json, { ...base(), ...(out.headers ?? {}) });
      return res;
    } catch (e) {
      const err = classify(e);
      if (!(e instanceof ApiError)) {
        // Server-side only, short, no request body: the message of an unexpected throw.
        console.error(JSON.stringify({ svc: "bot-api", event: "unhandled", reqId, route: spec.route, err: redactUrls(e instanceof Error ? e.message : String(e)).slice(0, 200) }));
      }
      status = err.status;
      code = err.code;
      // A retryable upstream failure always tells the client when to come back.
      const retryAfter = err.code === "rpc_unavailable" || err.code === "kv_unavailable" ? { "Retry-After": "2" } : {};
      res = respond(err.status, err.body(), { ...base(), ...retryAfter, ...(err.extra.headers ?? {}) });
      return res;
    } finally {
      record({
        reqId,
        route: spec.route,
        method: req.method,
        principal: principal?.kind === "key" ? principal.id : principal ? "anon" : "-",
        status,
        code,
        ms: Date.now() - t0,
        rpcCalls: meta.rpcCalls,
        sims: meta.sims,
        idem,
      });
    }
  };
}
