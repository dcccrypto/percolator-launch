/** POST /api/v1/positions/close: reduce-only order for the whole position (or `size` of it), unsigned and simulated. */
import { botRoute } from "@/lib/bot-api/handler";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { buildClose } from "@/lib/bot-api/builders/order";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const POST = botRoute({ route: "/v1/positions/close", scope: "build", weight: 10, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildClose(getBotConnection("confirmed"), body, meta),
}));
