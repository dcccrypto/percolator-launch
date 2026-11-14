/** POST /api/v1/withdrawals: unsigned withdrawal of free capital (no open position), simulated on its exact bytes. */
import { botRoute } from "@/lib/bot-api/handler";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { buildWithdraw } from "@/lib/bot-api/builders/transfer";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const POST = botRoute({ route: "/v1/withdrawals", scope: "build", weight: 8, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildWithdraw(getBotConnection("confirmed"), body, meta),
}));
