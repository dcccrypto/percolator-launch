/** POST /api/v1/deposits: unsigned deposit; creates the trading account when the wallet has none (caller co-signs newPortfolio). */
import { botRoute } from "@/lib/bot-api/handler";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { buildDeposit } from "@/lib/bot-api/builders/transfer";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const POST = botRoute({ route: "/v1/deposits", scope: "build", weight: 8, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildDeposit(getBotConnection("confirmed"), body, meta),
}));
