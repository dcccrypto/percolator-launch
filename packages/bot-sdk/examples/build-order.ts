/**
 * Build an UNSIGNED order and print it. Nothing is signed or sent: sign the base64 transaction with your own wallet
 * and send it yourself, then poll client.waitForTx(signature, { lastValidBlockHeight }).
 *   BOT_API_URL=... BOT_API_KEY=pbk_... OWNER=<wallet> MARKET=<market> npx tsx examples/build-order.ts [buy|sell] [sizeQ]
 */
import { BotApiError, BotClient } from "../src/index";

const owner = process.env.OWNER;
const market = process.env.MARKET;
const apiKey = process.env.BOT_API_KEY;
if (!owner || !market || !apiKey) throw new Error("set OWNER, MARKET and BOT_API_KEY (a key with the build scope)");
const client = new BotClient({ baseUrl: process.env.BOT_API_URL ?? "http://localhost:3000", apiKey });

try {
  const res = await client.buildOrder({ owner, market, side: process.argv[2] === "sell" ? "sell" : "buy", size: process.argv[3] ?? "1000000", slippageBps: 100 });
  console.log("idempotency key", res.idempotencyKey);
  console.log("valid until block height", res.lastValidBlockHeight, "resubmitAfter", res.resubmitAfter);
  for (const tx of res.transactions) {
    console.log(`--- ${tx.purpose}: signers ${tx.signers.join(", ")}, cu ${tx.computeUnitLimit}, simulated cu ${tx.simulation.unitsConsumed}`);
    console.log("message hash", tx.messageHash);
    console.log("unsigned tx (base64)", tx.transaction);
  }
  console.log("summary", res.summary);
} catch (e) {
  if (e instanceof BotApiError) {
    console.error(`API error ${e.code} (retryable ${e.retryable}): ${e.message}`);
    if (e.onchain) console.error("on-chain:", e.onchain);
  } else throw e;
  process.exitCode = 1;
}
