/** POST /api/v1/withdrawals: unsigned withdrawal of free capital (no open position), simulated on its exact bytes. */
import { botRoute } from "@/lib/bot-api/handler";
import { getServerConnection } from "@/lib/server-rpc";
import { buildWithdraw } from "@/lib/bot-api/builders/transfer";

export const dynamic = "force-dynamic";

export const POST = botRoute({ route: "/v1/withdrawals", scope: "build", weight: 8, build: true, body: true, idempotent: true }, async ({ body, meta }) => ({
  body: await buildWithdraw(getServerConnection("confirmed"), body, meta),
}));
