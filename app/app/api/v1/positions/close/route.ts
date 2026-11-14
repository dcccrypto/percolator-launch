/** POST /api/v1/positions/close: reduce-only order for the whole position (or `size` of it), unsigned and simulated. */
import { botRoute } from "@/lib/bot-api/handler";
import { getServerConnection } from "@/lib/server-rpc";
import { buildClose } from "@/lib/bot-api/builders/order";

export const dynamic = "force-dynamic";

export const POST = botRoute({ route: "/v1/positions/close", scope: "build", weight: 10, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildClose(getServerConnection("confirmed"), body, meta),
}));
