/**
 * Read the first market and quote a buy of 1 lot (1,000,000 q). Reads only, no key needed.
 *   BOT_API_URL=http://localhost:3000 npx tsx examples/read-market.ts [marketAddress]
 */
import { BotApiError, BotClient } from "../src/index";

const client = new BotClient({ baseUrl: process.env.BOT_API_URL ?? "http://localhost:3000", apiKey: process.env.BOT_API_KEY });

try {
  const { markets, slot } = await client.markets();
  console.log(`slot ${slot}, ${markets.length} markets`);
  const m = process.argv[2] ?? markets[0]?.market;
  if (!m) throw new Error("no markets");
  const { market } = await client.market(m);
  console.log(market.symbol ?? market.market, "price E6", market.effectivePriceE6, "oracle stale", market.oracle.stale);
  // size is engine q: 1_000_000 q is ONE LOT of the market's base asset (a lot is 10^lotExp tokens; lotExp varies by market)
  const { quote } = await client.quote(m, { size: 1_000_000n, slippageBps: 100 });
  console.log("est exec price E6", quote.estExecPriceE6, "impact bps", quote.priceImpactBps, "limit E6", quote.limitPriceE6);
} catch (e) {
  if (e instanceof BotApiError) console.error(`API error ${e.code} (retryable ${e.retryable}): ${e.message}`);
  else throw e;
  process.exitCode = 1;
}
