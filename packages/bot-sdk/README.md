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
| Position size, `size` / `sizeQ` | engine **q**: 1,000,000 q = one **lot** of the base asset. A lot is `10^lotExp` tokens (`lotExp` is on every market; most have 0) | order `size`, quote `size`, `Position.sizeQ` |
| Price, `...PriceE6` | the price of **one lot**, times 1e6 | `effectivePriceE6`, `limitPriceE6` |
| Collateral amount | **atoms** of the market's collateral token: tokens x 10^decimals. `Market.collateralMint` and `Market.collateralDecimals` say which token (the devnet Sim-USDC has 6 decimals) | deposit `amount`, `capital`, `equity`, `notionalAtoms` |
| Notional | `notionalAtoms = |q| x effectivePriceE6 / 1e6`. For a 6-decimal USD stable, USD = atoms / 1e6 | `Quote.notionalAtoms`, `Position.notional` |
| Fees and spreads | **bps** = 1/100 of a percent. `expectedFeeBps` is what a fill pays; `feeCapBps` is the most it may pay (what the transaction signs) | quote, build summary |
| Types on the wire | q, E6 prices, atoms and config bps are decimal **strings** (use `BigInt`); computed bps, leverage and ages are JSON **numbers** | |

**Worked example.** A market has `effectivePriceE6 = "980974"` (0.980974 per lot), 6 collateral decimals, `lotExp` 0. You want 25 USD of exposure:

1. atoms = 25 x 10^6 = 25,000,000
2. q = atoms x 1e6 / effectivePriceE6 = 25,000,000 x 1,000,000 / 980,974 = **25,484,875**
3. check: notionalAtoms = 25,484,875 x 980,974 / 1e6 = 24,999,999 (about 25 USD, rounded down)

`sizeFromUsd(market, 25)` does exactly this with BigInt and returns `{ sizeQ, notionalAtoms, lots, baseTokens }`; `usdToAtoms("25", 6)` gives the deposit amount. A size that is worth less than one atom (`size = 1` on most markets) is accepted by the quote with `notionalAtoms` 0: size what you mean in USD, not in raw q.

**Order size versus quote size.** The quote takes a *signed* `size` (negative = sell). `POST /orders` takes an *unsigned* `size` and a `side`: `size: "1000000", side: "sell"` is the quote's `size=-1000000`. A negative order size is refused.

**Collateral the API can price.** The notional cap is in USD, so the API only builds risk-adding orders on markets whose collateral it knows to be a USD stable (the devnet Sim-USDC). Any other collateral is refused with `market_unsupported`; reducing orders and closes are never blocked by that.

## Getting devnet collateral

The app has a faucet page at `/faucet` (on the app's own address, not the API's): connect a wallet and it mints 10,000 Sim-USDC to it once per wallet per day, plus a little SOL for fees. The token is the mint in `Market.collateralMint`. For SOL beyond that, use a devnet faucet or ask the team.

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
- Errors: every failure is a `BotApiError` with `code`, `status`, `retryable`, `onchain` (`{ code, name }` for a failed simulation), `details`, `logs`, `requestId`, `retryAfterMs`. Branch on `code`, not on `message`.
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
- **Oracle modes**: `keeper` (a keeper pushes the price) or Pyth-pinned. `oracle.stale` is true when the last price is older than `staleBoundSecs`; orders that add risk are refused then.
- **Lot**: `10^lotExp` base tokens, the unit q and prices are in.
- **Fee cap vs expected fee**: a fill pays `expectedFeeBps` (base fee plus the matcher's current fee). The transaction signs a higher `feeCapBps` so the fee can move a little before it lands; you are never charged the cap unless the market's fee really is that high.

## Examples

`examples/read-market.ts`, `examples/first-deposit.ts` (builds the account-creating deposit, prints it, signs nothing), `examples/build-order.ts` (prints the unsigned tx, signs nothing), `examples/stream.ts`. Run with `npx tsx examples/<file>.ts`; set `BOT_API_URL` and, for builders, `BOT_API_KEY`.

## Tests

`pnpm --filter @percolator/bot-sdk test` (mocked fetch). The app's test suite also drives this client against the real route handlers.
