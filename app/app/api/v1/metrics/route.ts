/** GET /api/v1/metrics: this instance's request counters and latency histograms, Prometheus text. Needs the `ops` scope. */
import { botRoute } from "@/lib/bot-api/handler";
import { renderPrometheus } from "@/lib/bot-api/metrics";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

const inner = botRoute({ route: "/v1/metrics", scope: "ops", weight: 1 }, async () => ({ body: renderPrometheus() }));

export async function GET(req: import("next/server").NextRequest) {
  const res = await inner(req);
  if (res.status !== 200) return res;
  const text = (await res.json()) as string;
  return new Response(text, { status: 200, headers: { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store", "X-Request-Id": res.headers.get("X-Request-Id") ?? "" } });
}
