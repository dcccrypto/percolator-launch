/**
 * GET /api/v1/markets/{market}/depth: the quote at a ladder of notionals per side. There is no order book on v2.2; this is the
 * LP's matcher curve, our "orderbook" (see lib/bot-api/reads/quote.ts).
 */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { MARKET_CACHE, observedAt, parsePubkey } from "@/lib/bot-api/reads/common";
import { depthView, loadQuoteSource } from "@/lib/bot-api/reads/quote";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute<{ market: string }>({ route: "/v1/markets/{market}/depth", scope: "read", weight: 4 }, async ({ params, meta }) => {
  const market = parsePubkey(params.market, "market");
  const src = await loadQuoteSource(getBotConnection("confirmed"), meta, market);
  return { body: { slot: src.slot, observedAt: observedAt(), depth: depthView(src) }, headers: MARKET_CACHE };
});
