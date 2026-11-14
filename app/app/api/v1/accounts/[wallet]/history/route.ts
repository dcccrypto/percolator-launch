/** GET /api/v1/accounts/{wallet}/history?limit=<1..100>&before=<signature>: chain signatures of the wallet's portfolios (no fills yet). */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { ACCOUNT_CACHE, observedAt, parsePubkey, queryParam } from "@/lib/bot-api/reads/common";
import { historyView, parseBefore, parseLimit } from "@/lib/bot-api/reads/history";

export const dynamic = "force-dynamic";

export const GET = botRoute<{ wallet: string }>({ route: "/v1/accounts/{wallet}/history", scope: "read", weight: 3 }, async ({ req, params, meta }) => {
  const wallet = parsePubkey(params.wallet, "wallet");
  const url = new URL(req.url);
  const limit = parseLimit(queryParam(url, "limit"));
  const before = parseBefore(queryParam(url, "before"));
  const v = await historyView(getBotConnection("confirmed"), meta, wallet, limit, before);
  return { body: { observedAt: observedAt(), ...v }, headers: ACCOUNT_CACHE };
});
