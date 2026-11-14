/**
 * GET /api/v1/markets/{market}/funding: the funding rate the wrapper would apply now (lib/v22/funding.ts decodeFundingV22).
 * Works for funding-on markets (the older /api/funding/{slab} answers 404 for those).
 * Sign: rate > 0 means longs pay shorts. The rate is per slot (e9 of notional); `pctPer8h` is what is actually applied
 * (0 unless both sides hold exposure and the oracle mode is price-managed), `impliedPctPer8h` is the rate before that gate.
 */
import { getServerConnection } from "@/lib/server-rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { MARKET_CACHE, observedAt, parsePubkey } from "@/lib/bot-api/reads/common";
import { loadMarket } from "@/lib/bot-api/reads/market-source";
import { decodeMarket } from "@/lib/bot-api/reads/market";
import { decodeFundingV22, FUNDING_DEN_E9, SLOTS_PER_8H } from "@/lib/v22/funding";

export const dynamic = "force-dynamic";

export const GET = botRoute<{ market: string }>({ route: "/v1/markets/{market}/funding", scope: "read", weight: 1 }, async ({ params, meta }) => {
  const market = parsePubkey(params.market, "market");
  const m = await loadMarket(getServerConnection("confirmed"), meta, market);
  decodeMarket(m.raw, { market, programId: m.programId, slot: m.slot }); // market_unsupported / market_unreadable
  const f = decodeFundingV22(m.raw, 0);
  if (!f) throw new ApiError("market_unreadable");
  const enabled = f.managed && f.maxAbsE9 > 0n;
  return {
    body: {
      slot: m.slot,
      observedAt: observedAt(),
      market: market.toBase58(),
      enabled,
      active: enabled && f.bothSides && f.rateE9PerSlot !== 0n,
      direction: f.direction,
      rateE9PerSlot: f.rateE9PerSlot,
      ratePerSlot: Number(f.rateE9PerSlot) / Number(FUNDING_DEN_E9),
      pctPer8h: f.pctPer8h,
      impliedPctPer8h: (Number(f.rateE9PerSlot) * SLOTS_PER_8H) / Number(FUNDING_DEN_E9) * 100,
      premiumE9PerSlot: f.premiumE9,
      skewE9PerSlot: f.skewE9,
      maxAbsE9PerSlot: f.maxAbsE9,
      bothSidesOpen: f.bothSides,
      priceManaged: f.managed,
      slotsPer8h: SLOTS_PER_8H,
    },
    headers: MARKET_CACHE,
  };
});
