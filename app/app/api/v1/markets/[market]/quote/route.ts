/**
 * GET /api/v1/markets/{market}/quote?size=<signed integer engine q>&slippageBps=<1..1000, default 100>
 * Pre-trade quote from the LP's matcher context. `size` is the same signed engine q the POST builder takes (> 0 buy,
 * < 0 sell), as a decimal string. See lib/bot-api/reads/quote.ts for what is and is not modelled.
 */
import { getBotConnection } from "@/lib/bot-api/rpc";
import { botRoute } from "@/lib/bot-api/handler";
import { ApiError } from "@/lib/bot-api/errors";
import { MARKET_CACHE, observedAt, parsePubkey, queryParam } from "@/lib/bot-api/reads/common";
import { DEFAULT_QUOTE_SLIPPAGE_BPS, MAX_QUOTE_SLIPPAGE_BPS, loadQuoteSource, quoteView } from "@/lib/bot-api/reads/quote";

export const dynamic = "force-dynamic";
/** Above the 20 s handler deadline (RPC_DEADLINE_MS), so a hung RPC answers JSON rpc_unavailable, not a platform 504. */
export const maxDuration = 30;
const MAX_ABS_Q = (1n << 127n) - 1n;

export const GET = botRoute<{ market: string }>({ route: "/v1/markets/{market}/quote", scope: "read", weight: 2 }, async ({ req, params, meta }) => {
  const market = parsePubkey(params.market, "market");
  const url = new URL(req.url);
  const rawSize = queryParam(url, "size");
  if (rawSize === undefined || !/^-?\d{1,39}$/.test(rawSize)) throw new ApiError("bad_request", "size must be a signed integer string of engine q (> 0 buy, < 0 sell)");
  const size = BigInt(rawSize);
  if (size === 0n || size > MAX_ABS_Q || size < -MAX_ABS_Q) throw new ApiError("bad_request", "size must be non-zero and within range");
  const rawSlip = queryParam(url, "slippageBps");
  let slippageBps = DEFAULT_QUOTE_SLIPPAGE_BPS;
  if (rawSlip !== undefined) {
    if (!/^\d{1,9}$/.test(rawSlip)) throw new ApiError("bad_request", "slippageBps must be a whole number of basis points");
    slippageBps = Number(rawSlip);
    if (slippageBps < 1) throw new ApiError("bad_request", "slippageBps must be at least 1: 0 builds a limit at the effective price, which the program refuses (InvalidInstruction)");
    if (slippageBps > MAX_QUOTE_SLIPPAGE_BPS) throw new ApiError("slippage_cap_exceeded", `slippageBps is above the maximum of ${MAX_QUOTE_SLIPPAGE_BPS}`);
  }
  const src = await loadQuoteSource(getBotConnection("confirmed"), meta, market);
  return { body: { slot: src.slot, observedAt: observedAt(), quote: quoteView(src, size, slippageBps) }, headers: MARKET_CACHE };
});
