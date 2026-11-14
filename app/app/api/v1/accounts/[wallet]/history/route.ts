/** GET /api/v1/accounts/{wallet}/history?limit=<1..100>&before=<signature>: chain signatures of the wallet's portfolios (no fills yet). Weight 3 + 1 per portfolio scanned. */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { chargeExtra } from "@/lib/bot-api/limits";
import { ACCOUNT_CACHE, observedAt, parsePubkey, queryParam } from "@/lib/bot-api/reads/common";
import { historyView, parseBefore, parseLimit } from "@/lib/bot-api/reads/history";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute<{ wallet: string }>({ route: "/v1/accounts/{wallet}/history", scope: "read", weight: 3 }, async ({ req, params, meta, principal }) => {
  const wallet = parsePubkey(params.wallet, "wallet");
  const url = new URL(req.url);
  const limit = parseLimit(queryParam(url, "limit"));
  const before = parseBefore(queryParam(url, "before"));
  const v = await historyView(getBotConnection("confirmed"), meta, wallet, limit, before);
  // The flat weight (3) covers the portfolio scan; each portfolio read is one more getSignaturesForAddress (up to 10).
  await chargeExtra(principal, v.portfolios.length);
  return { body: { observedAt: observedAt(), ...v }, headers: ACCOUNT_CACHE };
});
