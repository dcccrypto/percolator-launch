/** GET /api/v1/accounts/{wallet}[?market=]: the wallet's v2.2 portfolios, positions and margin (lib/bot-api/reads/account.ts). */
import { getServerConnection } from "@/lib/server-rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { ACCOUNT_CACHE, observedAt, parsePubkey, queryParam } from "@/lib/bot-api/reads/common";
import { accountView } from "@/lib/bot-api/reads/account";

export const dynamic = "force-dynamic";

export const GET = botRoute<{ wallet: string }>({ route: "/v1/accounts/{wallet}", scope: "read", weight: 5 }, async ({ req, params, meta }) => {
  const wallet = parsePubkey(params.wallet, "wallet");
  const m = queryParam(new URL(req.url), "market");
  const market = m === undefined ? null : parsePubkey(m, "market");
  const v = await accountView(getServerConnection("confirmed"), meta, wallet, market);
  return { body: { slot: v.slot, observedAt: observedAt(), wallet: v.wallet, count: v.portfolios.length, portfolios: v.portfolios }, headers: ACCOUNT_CACHE };
});
