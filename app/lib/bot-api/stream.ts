/**
 * Server-Sent Events for /api/v1/stream, and the wrapper that lets a stream route reuse botRoute's checks.
 *
 * botRoute answers JSON, so `sseRoute` runs it with a handler that does the route's own validation, stashes the stream plan
 * under the request id and answers a tiny marker; the wrapper then swaps that response for the raw SSE Response, keeping
 * the request id and rate-limit headers botRoute set. Kill switch, auth, scope and the weighted limit therefore run exactly
 * once, in botRoute; handler.ts is untouched.
 *
 * Wire format (each block ends with a blank line):
 *   retry: 2000
 *   event: market     id: <slot>   data: {...snapshot...}        every SNAPSHOT_MS, one per market
 *   event: heartbeat  id: <slot>   data: {"slot","observedAt"}   every HEARTBEAT_MS
 *   event: error      data: {"code","retryable"}                 a tick failed; the stream stays open
 *   event: end        data: {"reason":"max-duration","reconnect":true,"lastEventId":"<slot>"}   then the stream closes
 * `id` is the cluster slot of the read, so Last-Event-ID is a slot: the server does not replay (each event is a full
 * snapshot) but never sends a snapshot older than the Last-Event-ID the client reconnects with.
 */
import type { NextRequest, NextResponse } from "next/server";
import { botRoute, type Ctx, type RouteSpec } from "./handler";
import { ApiError } from "./errors";
import { toJson } from "./handler";

export const RETRY_MS = 2_000;
export const SNAPSHOT_MS = 2_000;
export const HEARTBEAT_MS = 10_000;
/** Serverless limit with headroom: the client reconnects with Last-Event-ID. */
export const MAX_STREAM_MS = 55_000;

export interface StreamTick {
  slot: number;
  /** One entry per market: a snapshot, or the error code for that market. */
  items: Array<{ market: string; snapshot: Record<string, unknown> } | { market: string; error: { code: string; retryable: boolean } }>;
}

export interface StreamPlan {
  /** One read of every market in the stream; throws ApiError (its code goes in an `error` event). */
  read: () => Promise<StreamTick>;
  lastEventId?: number | null;
  snapshotMs?: number;
  heartbeatMs?: number;
  maxMs?: number;
  /** The request's abort signal: the client went away. */
  signal?: AbortSignal;
}

const enc = new TextEncoder();
const block = (lines: string[]) => enc.encode(`${lines.join("\n")}\n\n`);
const data = (v: unknown) => `data: ${JSON.stringify(toJson(v))}`;

export const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Parse Last-Event-ID (a slot). Anything else is ignored. */
export function parseLastEventId(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/** The event stream. Uses the global timers at call time, so fake timers drive it in tests. */
export function marketEventStream(plan: StreamPlan, now: () => number = Date.now): ReadableStream<Uint8Array> {
  const snapshotMs = plan.snapshotMs ?? SNAPSHOT_MS;
  const heartbeatMs = plan.heartbeatMs ?? HEARTBEAT_MS;
  const maxMs = plan.maxMs ?? MAX_STREAM_MS;
  let tick: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let stop: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastSlot = plan.lastEventId ?? 0;
  const clear = () => {
    closed = true;
    if (tick) clearInterval(tick);
    if (beat) clearInterval(beat);
    if (stop) clearTimeout(stop);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (lines: string[]) => {
        if (closed) return;
        try {
          controller.enqueue(block(lines));
        } catch {
          clear();
        }
      };
      let reading = false;
      const poll = async () => {
        if (closed || reading) return;
        reading = true;
        try {
          const t = await plan.read();
          if (closed) return;
          // Ids never go backwards: a read older than what the client already has is skipped.
          if (t.slot < lastSlot) return;
          lastSlot = t.slot;
          const at = new Date(now()).toISOString();
          for (const it of t.items) {
            if ("snapshot" in it) send(["event: market", `id: ${t.slot}`, data({ ...it.snapshot, slot: t.slot, observedAt: at })]);
            else send(["event: market", `id: ${t.slot}`, data({ market: it.market, slot: t.slot, observedAt: at, error: it.error })]);
          }
        } catch (e) {
          const code = e instanceof ApiError ? e.code : "internal";
          send(["event: error", data({ code, retryable: e instanceof ApiError ? e.retryable : true })]);
        } finally {
          reading = false;
        }
      };
      plan.signal?.addEventListener(
        "abort",
        () => {
          clear();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );
      send([`retry: ${RETRY_MS}`]);
      void poll();
      tick = setInterval(() => void poll(), snapshotMs);
      beat = setInterval(() => send(["event: heartbeat", `id: ${lastSlot}`, data({ slot: lastSlot, observedAt: new Date(now()).toISOString() })]), heartbeatMs);
      stop = setTimeout(() => {
        send(["event: end", data({ reason: "max-duration", reconnect: true, lastEventId: String(lastSlot) })]);
        clear();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, maxMs);
    },
    cancel() {
      clear();
    },
  });
}

const plans = new Map<string, StreamPlan>();
const MARKER = "X-Bot-Stream";

/**
 * A GET route that streams. `prepare` runs inside botRoute (after auth and the limit) and returns the plan; it may throw
 * ApiError, which is answered as the usual JSON envelope before any stream opens.
 */
export function sseRoute<P = Record<string, string>>(spec: RouteSpec, prepare: (ctx: Ctx<P>) => Promise<StreamPlan>) {
  const inner = botRoute<P>(spec, async (ctx) => {
    const plan = await prepare(ctx);
    plans.set(ctx.reqId, {
      ...plan,
      lastEventId: plan.lastEventId ?? parseLastEventId(ctx.req.headers.get("last-event-id")),
    });
    return { body: { stream: true }, headers: { [MARKER]: ctx.reqId } };
  });
  return async (req: NextRequest, routeCtx?: { params?: Promise<P> | P }): Promise<NextResponse | Response> => {
    const res = await inner(req, routeCtx);
    const id = res.headers.get(MARKER);
    if (!id) return res;
    const plan = plans.get(id);
    plans.delete(id);
    if (!plan) return res;
    const headers = new Headers(sseHeaders);
    for (const [k, v] of res.headers) if (k.toLowerCase().startsWith("x-ratelimit-") || k.toLowerCase() === "x-request-id") headers.set(k, v);
    const body = marketEventStream({ ...plan, signal: req.signal });
    return new Response(body, { status: 200, headers });
  };
}
