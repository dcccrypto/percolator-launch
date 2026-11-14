/**
 * Bot API request log + in-process metrics.
 *
 * One JSON line per request on stdout (Vercel / any log drain picks it up): request id, route, keyId (never the key),
 * status, error code, latency, RPC calls and simulations. Counters and latency histograms per route are kept in this
 * process and rendered as Prometheus text at GET /api/v1/metrics (ops scope). On serverless every instance has its own
 * numbers; a shared store is later (docs/ideas/bot-trading-rails.md 3.7).
 */

export const BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

interface RouteStats {
  count: Map<string, number>; // `${status}|${code}` -> n
  buckets: number[];
  sumMs: number;
  n: number;
}

const routes = new Map<string, RouteStats>();
const startedAt = Date.now();

export interface RequestLog {
  reqId: string;
  route: string;
  method: string;
  principal: string;
  status: number;
  code: string | null;
  ms: number;
  rpcCalls?: number;
  sims?: number;
  idem?: "new" | "replay" | null;
}

export function record(l: RequestLog): void {
  let s = routes.get(l.route);
  if (!s) {
    s = { count: new Map(), buckets: BUCKETS_MS.map(() => 0), sumMs: 0, n: 0 };
    routes.set(l.route, s);
  }
  const k = `${l.status}|${l.code ?? ""}`;
  s.count.set(k, (s.count.get(k) ?? 0) + 1);
  BUCKETS_MS.forEach((b, i) => {
    if (l.ms <= b) s.buckets[i]++;
  });
  s.sumMs += l.ms;
  s.n++;
  if (process.env.BOT_API_LOG !== "0") console.log(JSON.stringify({ svc: "bot-api", ...l }));
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderPrometheus(): string {
  const out: string[] = [];
  out.push("# HELP botapi_requests_total Bot API requests by route, status and error code.");
  out.push("# TYPE botapi_requests_total counter");
  for (const [r, s] of routes) {
    for (const [k, n] of s.count) {
      const [status, code] = k.split("|");
      out.push(`botapi_requests_total{route="${esc(r)}",status="${status}",code="${esc(code)}"} ${n}`);
    }
  }
  out.push("# HELP botapi_request_duration_ms Bot API latency.");
  out.push("# TYPE botapi_request_duration_ms histogram");
  for (const [r, s] of routes) {
    BUCKETS_MS.forEach((b, i) => out.push(`botapi_request_duration_ms_bucket{route="${esc(r)}",le="${b}"} ${s.buckets[i]}`));
    out.push(`botapi_request_duration_ms_bucket{route="${esc(r)}",le="+Inf"} ${s.n}`);
    out.push(`botapi_request_duration_ms_sum{route="${esc(r)}"} ${s.sumMs}`);
    out.push(`botapi_request_duration_ms_count{route="${esc(r)}"} ${s.n}`);
  }
  out.push("# TYPE botapi_process_uptime_seconds gauge");
  out.push(`botapi_process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  return out.join("\n") + "\n";
}

/** Test seam. */
export function __resetMetricsForTest(): void {
  routes.clear();
}
