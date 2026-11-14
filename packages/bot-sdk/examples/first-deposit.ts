/**
 * First deposit from an empty wallet: build the transaction that CREATES your trading account on a market and funds it.
 * It builds and prints. It never signs and never sends (the SDK has no code path that takes a key).
 *
 * Before you run it:
 *   1. Get devnet collateral in the wallet (the app's /faucet gives Sim-USDC) and a little SOL for fees and rent.
 *   2. Make a FRESH keypair for the new account and keep its file safe, for example:
 *        solana-keygen new --no-bip39-passphrase -o new-portfolio.json && solana address -k new-portfolio.json
 *      That public key is NEW_PORTFOLIO. The returned transaction must be signed by BOTH your wallet and that keypair.
 *
 *   BOT_API_URL=... BOT_API_KEY=pbk_... OWNER=<wallet> MARKET=<market> NEW_PORTFOLIO=<fresh pubkey> \
 *     npx tsx examples/first-deposit.ts [usd, default 25]
 */
import { BotApiError, BotClient, usdToAtoms } from "../src/index";

const owner = process.env.OWNER;
const market = process.env.MARKET;
const newPortfolio = process.env.NEW_PORTFOLIO;
const apiKey = process.env.BOT_API_KEY;
if (!owner || !market || !newPortfolio || !apiKey) throw new Error("set OWNER, MARKET, NEW_PORTFOLIO and BOT_API_KEY (a key with the build scope)");
const client = new BotClient({ baseUrl: process.env.BOT_API_URL ?? "http://localhost:3000", apiKey });

try {
  const { market: m } = await client.market(market);
  if (m.collateralDecimals === null) throw new Error(`market collateral ${m.collateralMint} cannot be valued in USD; give the amount in atoms yourself`);
  const usd = process.argv[2] ?? "25";
  const amount = usdToAtoms(usd, m.collateralDecimals).toString();
  console.log(`depositing ${usd} USD = ${amount} atoms of ${m.collateralMint} (${m.collateralDecimals} decimals)`);

  const res = await client.buildDeposit({ owner, market, amount, newPortfolio });
  console.log("idempotency key", res.idempotencyKey, "| valid until block height", res.lastValidBlockHeight);
  for (const tx of res.transactions) {
    console.log(`--- ${tx.purpose}: must be signed by ${tx.signers.join(" AND ")}`);
    console.log("message hash", tx.messageHash);
    console.log("unsigned tx (base64)", tx.transaction);
  }
  console.log("summary", res.summary);
  console.log("next: sign with the wallet and the new-portfolio keypair, send, then client.waitForTx(signature, { lastValidBlockHeight }); after that POST /orders works.");
} catch (e) {
  if (e instanceof BotApiError) {
    console.error(`API error ${e.code} (retryable ${e.retryable}): ${e.message}`);
    if (e.details) console.error("details:", e.details);
    process.exitCode = 1;
  } else {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
