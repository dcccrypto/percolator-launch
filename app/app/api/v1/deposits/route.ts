/** POST /api/v1/deposits: unsigned deposit; creates the trading account when the wallet has none (caller co-signs newPortfolio). */
import { botRoute } from "@/lib/bot-api/handler";
import { getBotConnection } from "@/lib/bot-api/rpc";
import { buildDeposit } from "@/lib/bot-api/builders/transfer";

export const dynamic = "force-dynamic";

export const POST = botRoute({ route: "/v1/deposits", scope: "build", weight: 8, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildDeposit(getBotConnection("confirmed"), body, meta),
}));
