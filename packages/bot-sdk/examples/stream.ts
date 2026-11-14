/**
 * Print market snapshots for 30 s. The client reconnects with Last-Event-ID on its own.
 *   BOT_API_URL=... npx tsx examples/stream.ts <marketAddress> [marketAddress...]
 */
import { BotClient } from "../src/index";

const markets = process.argv.slice(2);
if (markets.length === 0) throw new Error("give at least one market address");
const client = new BotClient({ baseUrl: process.env.BOT_API_URL ?? "http://localhost:3000", apiKey: process.env.BOT_API_KEY });
const stop = new AbortController();
setTimeout(() => stop.abort(), 30_000);

for await (const ev of client.stream(markets, { signal: stop.signal })) {
  if (ev.type === "market") console.log(ev.id, ev.data.market, ev.data.effectivePriceE6 ?? ev.data.error);
  else if (ev.type === "error") console.warn("stream error", ev.data.code);
}
