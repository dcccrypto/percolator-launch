/**
 * GET /api/v1/markets: the v2.2 markets on the allowlisted wrapper program(s), one batched read.
 * Each market: price, oracle freshness (`oracle.stale` against the market's own bound), fee, max leverage, open interest.
 * Multi-asset and non-v2.2 accounts are left out and counted in `skipped`.
 */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { MARKET_CACHE, observedAt } from "@/lib/bot-api/reads/common";
import { loadAllMarkets } from "@/lib/bot-api/reads/market-source";
import { decodeMarket, type MarketView } from "@/lib/bot-api/reads/market";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;

export const GET = botRoute({ route: "/v1/markets", scope: "read", weight: 2 }, async ({ meta }) => {
  const { markets, slot } = await loadAllMarkets(getBotConnection("confirmed"), meta);
  const out: MarketView[] = [];
  let skipped = 0;
  for (const m of markets) {
    try {
      out.push(decodeMarket(m.raw, { market: m.market, programId: m.programId, slot }));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      skipped++;
    }
  }
  out.sort((a, b) => a.market.localeCompare(b.market));
  return { body: { slot, observedAt: observedAt(), count: out.length, skipped, markets: out }, headers: MARKET_CACHE };
});
