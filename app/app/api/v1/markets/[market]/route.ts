/** GET /api/v1/markets/{market}: one market with its risk parameters. */
import { getServerConnection } from "@/lib/server-rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { MARKET_CACHE, observedAt, parsePubkey } from "@/lib/bot-api/reads/common";
import { loadMarket } from "@/lib/bot-api/reads/market-source";
import { decodeMarketDetail } from "@/lib/bot-api/reads/market";

export const dynamic = "force-dynamic";

export const GET = botRoute<{ market: string }>({ route: "/v1/markets/{market}", scope: "read", weight: 1 }, async ({ params, meta }) => {
  const market = parsePubkey(params.market, "market");
  const m = await loadMarket(getServerConnection("confirmed"), meta, market);
  const view = decodeMarketDetail(m.raw, { market, programId: m.programId, slot: m.slot });
  return { body: { slot: m.slot, observedAt: observedAt(), market: view }, headers: MARKET_CACHE };
});
