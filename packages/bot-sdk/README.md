# @percolator/bot-sdk

Typed fetch client for the Percolator v2.2 bot API (`/api/v1`, devnet). No runtime dependencies. Node 20+ or any runtime with `fetch`.

**The SDK never signs and never sends.** Builder calls return unsigned base64 transactions that the API has already simulated. Signing and sending is yours: sign with your own wallet, send with your own RPC connection. The SDK has no code path that takes a private key.

```ts
import { BotClient, BotApiError, sizeFromUsd } from "@percolator/bot-sdk";

const client = new BotClient({ baseUrl: "https://<deployment>", apiKey: process.env.BOT_API_KEY });

const { market: m } = await client.market(market);
const { sizeQ } = sizeFromUsd(m, 25); // 25 USD of exposure, as engine q
const { quote } = await client.quote(market, { size: sizeQ }); // signed: negative = sell
const built = await client.buildOrder({ owner: wallet, market, side: "buy", size: String(sizeQ) }); // unsigned: side sets the direction
// sign built.transactions[0].transaction (base64) with the wallet, send it, then:
const status = await client.waitForTx(signature, { lastValidBlockHeight: built.lastValidBlockHeight });
// status.status is confirmed, finalized, failed or expired (expired: safe to rebuild)
```

## Install and base URL

The package is private to the Percolator monorepo (not on npm). Use it from the workspace: add `"@percolator/bot-sdk": "workspace:*"` to a package in the monorepo and `pnpm install`, or copy `packages/bot-sdk/src` into your project (it has no dependencies). Run the examples from `packages/bot-sdk` with `npx tsx examples/<file>.ts`.

The **base URL** is the origin of a deployment that has the bot API switched on (`BOT_API_ENABLED=1`, devnet v2.2 build only; otherwise every route answers `disabled`). The Percolator team tells you the preview URL. To run one yourself from the monorepo: `cd app && BOT_API_ENABLED=1 NEXT_PUBLIC_DEFAULT_NETWORK=devnet NEXT_PUBLIC_V22=1 pnpm dev`, and the base URL is `http://localhost:3000`. (The examples use `BOT_API_URL`, default `http://localhost:3000`.)

## Getting a key

Reads work without a key at a small anonymous budget. Building transactions needs a key with the `build` scope. **Devnet keys are issued by the Percolator team** (ask them; there is no self-serve sign-up yet). A key looks like `pbk_<id>_<secret>`, is shown once, and only lets you ask for transactions: it never gives anyone control of a wallet. Keep it in an environment variable (`BOT_API_KEY`), never in code.

Keys live in the deployment's key store. The team issues them with `app/scripts/bot-api/keys.ts` against that store. That means:

- A key for the shared preview works on the preview only.
- A **local** `pnpm dev` server uses an in-memory store when no `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` is set, so a key from the script does not survive (the script and the server are different processes). Either point both the server and the script at the same Upstash Redis for development (a separate dev database; set the variables in your own shell, never on a command line or in a file you commit), or skip HTTP and drive the route handlers in-process, as `app/__tests__/lib/bot-api/sdk-local.test.ts` does (it issues a key in memory and runs the SDK against the real handlers).
- Reads need no key at all, so `examples/read-market.ts` works against a local server as is.

## Units

Everything the API takes or returns is an integer in one of these units. Get them wrong and you trade the wrong size.

| What | Unit | Where |
| --- | --- | --- |
| Position size, `size` / `sizeQ` | engine **q**: 1,000,000 q = one **lot** of the base asset. A lot is `10^lotExp` tokens (`lotExp` is on every market and varies: the live Sim-USDC markets have 0, 3 and 4, so read it per market and size with `sizeFromUsd`) | order `size`, quote `size`, `Position.sizeQ` |
| Price, `...PriceE6` | the price of **one lot**, times 1e6 | `effectivePriceE6`, `limitPriceE6` |
| Collateral amount | **atoms** of the market's collateral token: tokens x 10^decimals. `Market.collateralMint` and `Market.collateralDecimals` say which token (the devnet Sim-USDC has 6 decimals) | deposit `amount`, `capital`, `equity`, `notionalAtoms` |
| Notional | `notionalAtoms = |q| x effectivePriceE6 / 1e6`. For a 6-decimal USD stable, USD = atoms / 1e6 | `Quote.notionalAtoms`, `Position.notional` |
| Fees and spreads | **bps** = 1/100 of a percent. `allInCostBps` is the whole expected cost of a fill against the mark; `expectedFeeBps` is the fee part of it; `feeCapBps` is the most the fee may be (what the transaction signs). See Fees and slippage below | quote, build summary |
| Types on the wire | q, E6 prices, atoms and config bps are decimal **strings** (use `BigInt`); computed bps, leverage (4 decimals) and ages are JSON **numbers** | |

**Worked example.** A market has `effectivePriceE6 = "980974"` (0.980974 per lot), 6 collateral decimals, `lotExp` 0. You want 25 USD of exposure:

1. atoms = 25 x 10^6 = 25,000,000
2. q = atoms x 1e6 / effectivePriceE6 = 25,000,000 x 1,000,000 / 980,974 = **25,484,875**
3. check: notionalAtoms = 25,484,875 x 980,974 / 1e6 = 24,999,999 (about 25 USD, rounded down)

`sizeFromUsd(market, 25)` does exactly this with BigInt and returns `{ sizeQ, notionalAtoms, lots, baseTokens }`; `usdToAtoms("25", 6)` gives the deposit amount. A size that is worth less than one atom (`size = 1` on most markets) is accepted by the quote with `notionalAtoms` 0: size what you mean in USD, not in raw q.

**Order size versus quote size.** The quote takes a *signed* `size` (negative = sell). `POST /orders` takes an *unsigned* `size` and a `side`: `size: "1000000", side: "sell"` is the quote's `size=-1000000`. A negative order size is refused.

**Collateral the API can price.** The notional cap is in USD, so the API only builds risk-adding orders on markets whose collateral it knows to be a USD stable (the devnet Sim-USDC). Any other collateral is refused with `market_unsupported`; reducing orders and closes are never blocked by that.

## Fees and slippage

A fill costs the **base fee** (`baseFeeBps`, the market's configured fee) plus the **spread** the matcher quotes (`totalSpreadBps`: its base spread, an adaptive fee, inventory skew and size impact, all inside that one number).

- **`allInCostBps` / `allInCostAtoms`** (quote and build summary) is that whole cost against the mark: `baseFeeBps` + the quoted spread, each counted once. Use this one to compare markets or size a trade.
- **`expectedFeeBps` / `expectedFeeAtoms`** is only the *fee* the wrapper charges. When `feeChargedInPrice` is **true** (the market's fee channel is on) the trade settles at the mark and the wrapper charges the quoted spread as a fee on top of the base fee, so `expectedFeeBps` equals `allInCostBps` and the spread is **not** also paid in `estExecPriceE6`. When it is **false** the fee is the base fee alone and the spread is paid in the price. **Never add `expectedFeeBps` to `totalSpreadBps`**: on a fee-channel market that counts the spread twice.
- **`feeCapBps`** is the most the fee may be, and is what the transaction signs. The program takes a fill only if the signed cap covers base + the matcher's request, and that request can move between your quote and landing, so the API signs the worst case: base fee + the matcher's worst-case request (the smaller of the market's `maxRequestedFeeBps`, the matcher's max total + 1, and 1023) + 5 bps, within the market's max trading fee. On the live devnet markets that is 30 + 100 + 5 = **135 bps**. You pay the fee in `expectedFeeBps`, not the cap.
- **`maxFeeBps`** (on orders) is a ceiling on that cap. Below the floor above (135 on those markets) the order is refused with `fee_above_max`: the API cannot sign a cap the program would reject. It exists to stop you signing a cap *higher* than you accept, e.g. after a utilisation-fee raise (`fee_raise_required`).
- **Slippage is measured from the mark** (`effectivePriceE6`), not from the expected fill. A `slippageBps` smaller than the quote's spread cannot fill: the order is refused before simulating with `slippage_cap_exceeded` and `details {limitPriceE6, estExecPriceE6, minSlippageBps}`; use at least `minSlippageBps`. (`quote` shows the same with `withinLimit: false`.) Reducing orders are not pre-checked.
- A quote for a size beyond `maxSizePerSide` is priced on the **fillable** size (`fillableQ`), with `exceedsMaxSize: true`; a build refuses such an order (`size_cap_exceeded`).

## Getting devnet collateral

The app has a faucet page at `/faucet` (on the app's own address, not the API's): connect a wallet and it mints 10,000 Sim-USDC to it once per wallet per day, plus a little SOL for fees. The token is the mint in `Market.collateralMint`. For SOL beyond that, use a devnet faucet or ask the team.

**SOL for the first deposit.** Creating a trading account pays rent for the account in SOL, on top of the signatures and the priority fee, and the wallet must stay above the 0.00089088 SOL minimum of a system account. The rent depends on the deployed account layout (about 0.055 to 0.075 SOL), so a wallet with **about 0.1 SOL** is comfortable and **0.05 SOL is not enough**. The build checks this before simulating and answers `insufficient_funds` with `details {needLamports, haveLamports, rentLamports}` (lamports: 1 SOL = 1,000,000,000); fund the wallet to `needLamports` and retry. Orders, closes, deposits into an existing account and withdrawals need only the transaction fee.

## First trade from an empty wallet

1. Get a key (above) and a wallet with devnet SOL and Sim-USDC (the faucet).
2. Pick a market: `client.markets()`. Skip markets with `oracle.stale` true: they refuse orders that add risk. `symbol` is null on many markets; identify one by its address.
3. Make a **fresh keypair** for the new trading account (`solana-keygen new -o new-portfolio.json`; keep the file). Its public key is `newPortfolio`.
4. Build the first deposit: `client.buildDeposit({ owner, market, amount, newPortfolio })` (`examples/first-deposit.ts`). The returned transaction creates the account and funds it atomically; it must be signed by your wallet **and** the `newPortfolio` keypair (`transactions[0].signers` lists both). Sign, send, `waitForTx`.
5. Size and quote: `sizeFromUsd(market, 25)`, `client.quote(market, { size })`. Look at `expectedFeeBps`, `priceImpactBps`, `oracle.stale`.
6. Build the order: `client.buildOrder(...)` (`examples/build-order.ts`), sign with the wallet, send, `waitForTx`.
7. Later: `client.account(wallet)` for positions, `client.buildClose(...)` to close, `client.buildWithdraw(...)` to take collateral out (only with no open position).

Without step 4 an order answers `no_portfolio` with `details.next` pointing at `POST /api/v1/deposits`.

## What it does

- Reads: `health`, `openapi`, `markets`, `market`, `funding`, `quote`, `depth`, `account`, `history`, `txStatus`.
- Builders: `buildOrder`, `buildClose`, `buildDeposit`, `buildWithdraw`, `cancelOrder`. Each sets an `Idempotency-Key` for you, reuses it on every retry, and returns it as `idempotencyKey`. Pass `{ idempotencyKey }` to choose your own.
- Errors: every failure is a `BotApiError` with `code`, `status`, `retryable`, `onchain` (`{ code, name, program }` for a failed simulation; `name` is set only when the Percolator wrapper returned the code, so a System or SPL Token error comes back as `simulation_failed` with its program and number, unnamed), `details`, `logs`, `requestId`, `retryAfterMs`. Branch on `code`, not on `message`.
- Retries: retryable codes, network errors and 429 are retried with exponential backoff and jitter (`maxRetries` 3, `retryBaseMs` 250, `maxDelayMs` 30000). A `Retry-After` is honored; one longer than `maxDelayMs` is thrown instead of waited out. **One call has a time budget** (`maxTotalMs`, default 15000): when the next wait would run past it, the last error is thrown instead. Set `maxTotalMs: 0` to turn the budget off.
- `waitForTx(signature, { lastValidBlockHeight, until })` polls until `confirmed` (or `finalized` with `until: "finalized"`), `failed` or `expired`. It throws `timeout` if none happens in time.
- `stream(markets, { signal })` is an async iterator of `market`, `heartbeat` and `error` events. The server ends each stream after about 55 s; the client reconnects with `Last-Event-ID` and also after drops and idle streams (30 s). Abort the signal to stop.
- Helpers: `sizeFromUsd`, `usdToAtoms`, `isExpiring`.

**Latency.** A build reads the market and the LP and simulates on a Solana RPC. On the public devnet RPC expect several seconds, and an occasional `rpc_unavailable` (retryable) when it rate-limits; a dedicated RPC behind the deployment is much faster. Reads are cached for about a second. Plan for a build to take seconds, not milliseconds, and let the retry budget above bound the worst case.

## Stale blockhash: rebuild with a new key

A built transaction can land only until `lastValidBlockHeight`. The SDK never sends, so check before you do:

```ts
import { isExpiring, newIdempotencyKey } from "@percolator/bot-sdk";

let built = await client.buildOrder(req);
// ... sign (takes a moment) ...
const { blockHeight } = await client.health();
if (isExpiring(built.lastValidBlockHeight, blockHeight, 20)) {
  // Do NOT reuse the old key: the API replays a key for 120 s and would hand back the same bytes with the same dead blockhash.
  built = await client.buildOrder(req, { idempotencyKey: newIdempotencyKey() });
  // ... sign again ...
}
```

If `waitForTx` returns `expired`, the transaction can never land: build again with a new key. If you are unsure whether it landed, check `txStatus` first.

When a build comes back with `resubmitAfter: true`, the only transaction is a maintenance crank: send it, then build the order again (new key).

## Glossary

- **Trading account** (also called portfolio in some field names): your collateral and positions on one market. Create it with a first deposit and `newPortfolio`.
- **LP**: the liquidity provider's account that takes the other side of every trade. There is no order book.
- **Matcher**: the program that prices a fill against the LP: spread, size impact, inventory skew and a fee.
- **Crank**: a maintenance transaction that refreshes an account or the market's state. The API tells you when you need one (`resubmitAfter`).
- **ADL** (auto-deleveraging): the market can scale a position down. `Position.sizeQ` is the size after ADL, `rawBasisQ` before; closes and reduce-only checks use `sizeQ`.
- **Oracle modes** (`Market.oracleMode`): `keeper` (a keeper service pushes the price), `pyth-pinned` (a pinned Pyth feed), `hyperp` (no external index feed: the price is the market's own mark) or `admin` (an authority pushes it). `oracle.stale` is true when the last price is older than `staleBoundSecs`; orders that add risk are refused then.
- **Lot**: `10^lotExp` base tokens, the unit q and prices are in.
- **Fee cap vs expected fee vs all-in cost**: see Fees and slippage. A fill pays `expectedFeeBps`; its whole cost is `allInCostBps`; the transaction signs the higher `feeCapBps` so the fee can move before it lands, and you are never charged the cap unless the market's fee really is that high.

## Examples

`examples/read-market.ts`, `examples/first-deposit.ts` (builds the account-creating deposit, prints it, signs nothing), `examples/build-order.ts` (prints the unsigned tx, signs nothing), `examples/stream.ts`. Run with `npx tsx examples/<file>.ts`; set `BOT_API_URL` and, for builders, `BOT_API_KEY`.

## Tests

`pnpm --filter @percolator/bot-sdk test` (mocked fetch). The app's test suite also drives this client against the real route handlers.
