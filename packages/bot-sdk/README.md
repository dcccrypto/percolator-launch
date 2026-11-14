# @percolator/bot-sdk

Typed fetch client for the Percolator v2.2 bot API (`/api/v1`, devnet). No runtime dependencies. Node 20+ or any runtime with `fetch`.

**The SDK never signs and never sends.** Builder calls return unsigned base64 transactions that the API has already simulated. Signing and sending is yours: sign with your own wallet, send with your own RPC connection. The SDK has no code path that takes a private key.

```ts
import { BotClient, BotApiError } from "@percolator/bot-sdk";

const client = new BotClient({ baseUrl: "https://<deployment>", apiKey: process.env.BOT_API_KEY });

const { quote } = await client.quote(market, { size: 1_000_000n });
const built = await client.buildOrder({ owner: wallet, market, side: "buy", size: "1000000" });
// sign built.transactions[0].transaction (base64) with the wallet, send it, then:
const status = await client.waitForTx(signature, { lastValidBlockHeight: built.lastValidBlockHeight });
// status.status is confirmed, finalized, failed or expired (expired: safe to rebuild)
```

## What it does

- Reads: `health`, `openapi`, `markets`, `market`, `funding`, `quote`, `depth`, `account`, `history`, `txStatus`.
- Builders: `buildOrder`, `buildClose`, `buildDeposit`, `buildWithdraw`, `cancelOrder`. Each sets an `Idempotency-Key` for you, reuses it on every retry, and returns it as `idempotencyKey`. Pass `{ idempotencyKey }` to choose your own.
- Errors: every failure is a `BotApiError` with `code`, `status`, `retryable`, `onchain` (`{ code, name }` for a failed simulation), `details`, `logs`, `requestId`, `retryAfterMs`. Branch on `code`, not on `message`.
- Retries: retryable codes, network errors and 429 are retried with exponential backoff and jitter (`maxRetries` 3, `retryBaseMs` 250, `maxDelayMs` 30000). A `Retry-After` is honored; one longer than `maxDelayMs` is thrown instead of waited out.
- `waitForTx(signature, { lastValidBlockHeight, until })` polls until `confirmed` (or `finalized` with `until: "finalized"`), `failed` or `expired`. It throws `timeout` if none happens in time.
- `stream(markets, { signal })` is an async iterator of `market`, `heartbeat` and `error` events. The server ends each stream after about 55 s; the client reconnects with `Last-Event-ID` and also after drops and idle streams (30 s). Abort the signal to stop.

Amounts, engine q and E6 prices are decimal strings; use `BigInt`.

## Examples

`examples/read-market.ts`, `examples/build-order.ts` (prints the unsigned tx, signs nothing), `examples/stream.ts`. Run with `npx tsx examples/<file>.ts`; set `BOT_API_URL` and, for builders, `BOT_API_KEY`.

## Tests

`pnpm --filter @percolator/bot-sdk test` (mocked fetch). The app's test suite also drives this client against the real route handlers.
