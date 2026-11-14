/**
 * POST /api/v1/orders: an UNSIGNED v2.2 market order (open, increase, reduce) for `owner`, simulated on its exact bytes
 * before it is returned. Never signs or sends. Body and caps: lib/bot-api/builders/order.ts, ./caps.ts; spec:
 * GET /api/v1/openapi.json. Send Idempotency-Key: a retry with the same key and body gets the same bytes back.
 */
import { botRoute } from "@/lib/bot-api/handler";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { buildOrder, parseOrderBody } from "@/lib/bot-api/builders/order";

export const dynamic = "force-dynamic";

export const POST = botRoute({ route: "/v1/orders", scope: "build", weight: 10, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildOrder(getBotConnection("confirmed"), parseOrderBody(body), meta),
}));
