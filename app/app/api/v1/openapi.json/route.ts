/** GET /api/v1/openapi.json: the OpenAPI 3.1 description of /api/v1 (lib/bot-api/openapi.ts). */
import { botRoute } from "@/lib/bot-api/handler";
import { buildOpenApi } from "@/lib/bot-api/openapi";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute({ route: "/v1/openapi.json", scope: "read", weight: 1 }, async () => ({
  body: buildOpenApi(),
  headers: { "Cache-Control": "public, max-age=300" },
}));
