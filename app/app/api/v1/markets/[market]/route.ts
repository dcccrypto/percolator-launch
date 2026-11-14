/** GET /api/v1/markets/{market}: one market with its risk parameters. */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { MARKET_CACHE, observedAt, parsePubkey } from "@/lib/bot-api/reads/common";
import { loadMarket } from "@/lib/bot-api/reads/market-source";
import { decodeMarketDetail } from "@/lib/bot-api/reads/market";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute<{ market: string }>({ route: "/v1/markets/{market}", scope: "read", weight: 1 }, async ({ params, meta }) => {
  const market = parsePubkey(params.market, "market");
  const m = await loadMarket(getBotConnection("confirmed"), meta, market);
  const view = decodeMarketDetail(m.raw, { market, programId: m.programId, slot: m.slot });
  return { body: { slot: m.slot, observedAt: observedAt(), market: view }, headers: MARKET_CACHE };
});
