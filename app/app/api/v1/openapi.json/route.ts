/** GET /api/v1/openapi.json: the OpenAPI 3.1 description of /api/v1 (lib/bot-api/openapi.ts). */
import { botRoute } from "@/lib/bot-api/handler";
import { buildOpenApi } from "@/lib/bot-api/openapi";

export const dynamic = "force-dynamic";

export const GET = botRoute({ route: "/v1/openapi.json", scope: "read", weight: 1 }, async () => ({
  body: buildOpenApi(),
  headers: { "Cache-Control": "public, max-age=300" },
}));
