# Bot-trading rails for v2.2 (design)

Status: design, 14 Nov 2026. Devnet and v2.2 builds only. Nothing here is merged or deployed.
Base: `feat/v22-app`, stacked on #3836 (`feat/v22-trade-api`, head 4b1713a90, held by Khubair for a Council review).

Owner asks (14 Nov): "HOLD #3836, run a Council review first". "But for that idea we need stuff done properly on api level no?" "We need the rails for it all properly". "Yh so these ideas need to be thought out properly".

Short version: #3836 is one useful endpoint, not an API. A bot needs to read markets and its own account, build every action, know its limits, retry safely, see what happened to its transaction, and trust that the service is up. None of that exists yet. This doc says who it is for, what exists, the whole system, what v1 is, what it costs to run, and the order to build it in.

## 1. Who uses it and why

| User | What they do | What they need from us |
|---|---|---|
| Market makers / LP bots | Quote, hedge, rebalance positions every few seconds | Fast market reads with a slot stamp, a quote at size, reduce/close builders, rate limits they can plan around |
| Directional and arb bots | Trade Percolator perps against CEX/DEX prices | Funding, mark vs oracle, freshness, open/close builders, slippage caps |
| AI agents (MCP / agent kits) | "Propose a trade, the wallet signs" | Unsigned, pre-simulated txs; read-only by default; clear error codes an LLM can act on |
| Our own tooling | e2e harness (`app/e2e-v22-live/*.mts`), bench (`app/scripts/trade-api/bench.ts`), Council seats, QA | The same builders without reproducing the browser hook |
| Market creators | Watch their market's health, OI, fees | Market and health reads |

Proof of demand, honestly stated:
- Outside: perp venues are bot-heavy. On Hyperliquid's trade.xyz HIP-3 markets, market makers were about 63% of volume from under 0.5% of wallets, and 522 high-frequency bots did $3.5B (6.7%) (Arrakis, Apr 2026, vendor analysis: https://arrakis.finance/blog/trade-xyz). HIP-3 builder markets did about $62B/month (theblock.co/post/403384, cited in the #3836 plan).
- Solana peers built exactly this shape: Phoenix's perps API has `POST /v1/ix/place-isolated-limit-order` returning unsigned instructions behind a wallet-login JWT (https://docs.phoenix.trade/api/trader/build-isolated-limit-order-transaction.md). Drift/Velocity ships a TS SDK that returns raw instructions, a self-hosted Gateway, and signed-message Swift orders (https://docs.velocity.exchange/developers/ecosystem-builders/sending-actions.md). Every venue ships agent/MCP tooling (sources in `~/ambitious-perc/ideas/1-trade-tx-api/plan.md`).
- The pitch that sells to agent builders is "agent proposes, wallet signs, agent never holds the key" (X research A1 in the #3836 plan).
- Inside: today a v2.2 trade outside the browser means reproducing `hooks/useTrade.ts`'s import closure, 123 files / 30,160 lines (#3836 plan). Our own e2e harness and bench already pay that cost.
- Against: nobody has asked to trade Percolator from a script yet (pre-launch, devnet; A3 in the #3836 plan). No venue publishes a verified share of volume from its API. So v1 is sized to be cheap to run and safe to leave off, and the success metrics below include adoption, not only correctness.

## 2. What exists

### Ours (file:line, at 4b1713a90)

Write path:
- `POST /api/v22/trade` (#3836): `app/app/api/v22/trade/route.ts:130`. Market order only, owner must already have a portfolio (`app/lib/v22/trade-build.ts:246`), single-asset only (`:205`), lots refused (`:213`). Every tx simulated before return (`:156-160`, `:374`); 98 fee rise needs consent (`:379-382`); 121 peer refresh (`:392`); self-heal (`:404`).
- Close / reduce / deposit / withdraw are built inside React hooks: `hooks/useClosePosition.ts:232`, `hooks/useDeposit.ts:222,252`, `hooks/useWithdraw.ts:394`. Not callable server-side.
- Reusable lib builders that no route uses: first trade `lib/first-trade.ts:326,348`, close account `lib/close-trading-account.ts:184`.
- No resting, limit, trigger or TP/SL orders on chain. Every v2.2 order is an immediate fill against the LP/matcher, bounded by `limitPriceE6`. So "cancel" has nothing on chain to cancel (see 3.3).

Read path:
- `/api/markets` (Supabase registry + chain, `app/app/api/markets/route.ts:440`), `/api/markets/[slab]`, `/api/open-interest/[slab]`, `/api/insurance/[slab]`, `/api/markets/health`, `/api/stats`, `/api/health` (`app/app/api/health/route.ts:29`).
- Funding: `/api/funding/[slab]` returns 404 whenever funding is on (`app/app/api/funding/[slab]/route.ts:36-38`); the v2.2 decoder `lib/v22/funding.ts:61` is used only by the client bar.
- Price history: `/api/markets/[slab]/prices` always 404 (`:17-25`). `/api/prices` reads Supabase last price, index always null.
- Trades, candles, trader stats/trades: indexer Postgres; the v2.2 preview has no lot-aware indexer (`lib/v22/indexer.ts:1-11`, indexer draft #218 not deployed).
- Account/positions: `fetchPortfolioSnapshot` (`hooks/usePortfolio.ts:728`) is in a `"use client"` module. Server-usable pieces: `lib/owner-portfolio.ts:93-136`, `lib/v22/layout.ts:176` (`parsePortfolio`), `lib/limits/decode.ts:85,261,297,315`, `lib/position-pnl.ts:233`, `lib/liquidation-risk.ts:39,83`.
- Quote/depth: no CLOB. Price impact is in the matcher context, decoded only in client hooks (`lib/limits/matcher-quote.ts:154,270`, `lib/v22/spread-estimate.ts:41`, `lib/limits/risk-limits.ts:277`).
- Streaming: only the price-ws WebSocket (`app/scripts/local-price-ws-server.ts`, prod is a separate Railway service). Its `price` is the mainnet DEX pool price, not the on-chain mark. No SSE anywhere.

Platform:
- Playground gate: with `PLAYGROUND_GATE_ENABLED=true` every `/api/*` without a `pg_access` cookie is 401 (`app/middleware.ts:436-452`); exemptions in `lib/playground-gate.ts:80-87`. `/api/v22/trade` is not exempt, so a bot cannot reach it on a gated preview.
- Rate limits: middleware 120/min per IP on `/api/*` (`app/middleware.ts:36`); Upstash with per-instance in-memory fallback (`lib/upstash-rate-limit.ts:62-83`); IP from `x-forwarded-for` with trusted depth (`lib/get-client-ip.ts:18`).
- Auth: no public API keys. `lib/api-auth.ts:13` is one internal shared key (`INDEXER_API_KEY`).
- Idempotency: none. Webhooks: none. Tx status: none (`lib/tx.ts:673` `pollConfirmation` is browser-side).
- Observability: Sentry off (`app/instrumentation.ts:15-17`), plain `console.*`, only RPC proxy counters (`lib/rpc-metrics.ts:4-8`). No load tests, no OpenAPI, no SDK package, no scheduled uptime check.
- Error codes: wrapper map `lib/wrapper-errors.ts`, v2.1 `lib/v21/wrapper-errors.ts`, v2.2 `lib/v22/sdk/errors-v22.ts:8-130`; #3836 returns `simulation_failed` with raw text and logs, not the numeric code or its name (`trade-build.ts:420`).
- Safety: default slippage 500 bps both sides (`lib/slippage.ts:44,67`); #3836 accepts 0..10000 (`route.ts:103`) and has no size or leverage cap of its own (size only non-zero and < 2^127, `route.ts:99-100`); the chain's margin (49) and lev guard (132/133) are the only limits.
- Simulation detail: `simulateForGate` (`lib/tx.ts:190-207`) simulates the instruction list under a 1.4M CU limit and a replaced blockhash. The returned tx is a different message (own CU limit, priority fee, real blockhash from `trade-build.ts:325`), and `lastValidBlockHeight` is not returned, so a bot cannot tell when its tx expires.

### Competitors (sources: docs fetched 14 Nov 2026)

| | Hyperliquid | Drift / Velocity | Phoenix (Rise perps) | Us today |
|---|---|---|---|---|
| Market data | `POST /info` (`l2Book`, `allMids`, `fundingHistory`, candles); WS `l2Book`/`bbo`/`trades`/`activeAssetCtx` | DLOB REST `/l2`,`/l3`; WS orderbook/trades; every response has `slot`, 5 s heartbeat | REST markets/candles/trader state/fills; WS `/v1/ws` | Cookie-gated app routes, funding 404, no stream |
| Account | `clearinghouseState`, `openOrders`, `userFills`, `userFunding` + WS | Data API (OpenAPI) for history; live state from SDK/RPC | trader state + fills | none server-side |
| Orders | EIP-712 signed actions to `/exchange`; agent wallets | SDK signs locally; Gateway holds key; Swift signed messages | Server returns unsigned instruction arrays | One unsigned market-order route |
| Auth | Agent wallet approval; no API keys | Wallet; delegates trade but cannot withdraw | Wallet-signature login -> JWT | none (IP limit) |
| Limits | 1200 weight/min/IP, per-address budget, WS caps, all documented | DLOB undocumented; Data API "no limits" | 429 only, numbers undocumented | 20/min/IP + 120/min global |
| Idempotency | `cloid` 128-bit, nonce window, `expiresAfter` | `userOrderId`, Swift uuid | none documented | none |
| Safety | reduce-only, ALO/IOC/GTC, TP/SL, `scheduleCancel` dead-man | reduce-only, post-only, IOC, auction bounds | post-only, slide, reduce-only, TP/SL | limit price, fee consent |
| Spec / SDK | Python SDK, no OpenAPI | TS SDK, Data API OpenAPI | TS + Rust SDK, OpenAPI | none |

Sources: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits , .../websocket/subscriptions , .../exchange-endpoint , .../nonces-and-api-wallets ; https://docs.velocity.exchange/developers/ecosystem-builders/orderbook-and-ws.md , https://docs.velocity.exchange/developers/data-api.md , https://github.com/drift-labs/gateway ; https://docs.phoenix.trade/api/index.md , https://docs.phoenix.trade/llms.txt . Drift relaunched as Velocity in Jul 2026 (cryptopolitan.com/drift-protocol-relaunches-as-velocity-dex).

What we take from them:
1. Phoenix is the closest precedent: unsigned build on the server, wallet signs. Return the full tx and its `lastValidBlockHeight`.
2. Stamp every read with the slot it reflects; heartbeat on streams (Velocity).
3. Publish exact, weighted rate limits with 429 + Retry-After (Hyperliquid).
4. Stable named error codes, including decoded on-chain codes (Hyperliquid error list).
5. Client-supplied id for idempotency (HL `cloid`), plus a request deadline (`expiresAfter`).
6. Reduce-only as a server-checked flag; slippage and leverage caps as fields.
7. OpenAPI + versioned prefix + devnet host (Phoenix, Velocity Data API).
8. Agent tooling read-only by default (Phoenix Vulcan pattern).
Not taken in v1: resting orders, post-only, TP/SL, dead-man switch, delegated trade-only keys. They need program support (no resting order state exists on chain) and are out of scope for an app-layer API.

## 3. The system end to end

### 3.1 Shape

One versioned HTTP API inside the existing Next.js app at `/api/v1/*`, deployed with the v2.2 preview like every other route. No new service, no new paid dependency (Upstash and the server RPC are already used). It reuses the app's own lib code, so the API and the browser build the same bytes. It never signs and never sends.

```
bot / agent / SDK
   |  HTTPS, Authorization: Bearer pbk_<id>_<secret>, Idempotency-Key
   v
middleware (gate exemption for /api/v1 only when BOT_API_ENABLED=1; the route authenticates itself)
   v
/api/v1 handler wrapper: request id -> kill switch -> auth (key, scopes) -> weighted rate limit (key, ip, global)
   -> body size + schema validation -> idempotency lookup -> handler -> envelope + metrics + JSON log line
   v
handlers: reads (chain via server RPC, Supabase registry) | quotes | builders (lib/v22/*) | tx status
   v
simulate the exact returned message (sigVerify off, real blockhash) -> return
```

Kill switch: `BOT_API_ENABLED` unset means every `/api/v1` route answers 503 `disabled` and the gate is not relaxed. Merging the code changes nothing until someone turns it on for the v2.2 preview. This is the main safe default.

### 3.2 Data (reads)

| Endpoint | Source | Freshness |
|---|---|---|
| `GET /v1/markets` | v2.2 markets from on-chain discovery (`lib/v22/discovery.ts`) filtered to the allowlisted program; one `getMultipleAccounts` for engine views | `slot`, `observedAt` on the response; per market `oracle.ageSlots`, `stale` when the oracle push is older than the market's stale bound |
| `GET /v1/markets/{m}` | slab account: config, engine view, risk params, fee, max leverage, lotExp | same |
| `GET /v1/markets/{m}/funding` | `decodeFundingV22` (fixes the 404 for funding-on markets) | same |
| `GET /v1/markets/{m}/quote?size=` | matcher context + engine view: effective price, limit at the caller's slippage, fee bps, price impact, max size per side | same; this is our "orderbook": there is no book, the LP's curve is the depth |
| `GET /v1/markets/{m}/depth` | the quote curve at a ladder of sizes per side | same |
| `GET /v1/accounts/{wallet}` | owner scan (`lib/owner-portfolio.ts`) + `parsePortfolio` + decode: capital, equity, positions (size, entry, mark, uPnL, liq price, leverage), margin | same |
| `GET /v1/accounts/{wallet}/history` | v2.2 has no indexer: signatures of the wallet's portfolios (`getSignaturesForAddress`), paginated by `before`; full fills wait for the lot-aware indexer | `slot` per row |
| `GET /v1/stream?markets=` | SSE: market snapshots every 2 s, `event: heartbeat` every 10 s, `id:` = slot, `retry:` hint; connection closes after 55 s (serverless), client resumes | each event carries `slot` |

Freshness guarantee, stated in the spec: every read carries `slot` and `observedAt`; `Cache-Control: max-age<=2`; a market is `stale: true` (and builders refuse with `market_stale`) when its oracle is older than the bound. We do not promise latency numbers we cannot keep on a free devnet RPC; we publish the measured ones (section 6).

### 3.3 Builders (writes, unsigned)

All `POST`, all return `{transactions:[{purpose, transaction(base64), messageHash, computeUnitLimit, simulation:{unitsConsumed, logsTail}}], blockhash, lastValidBlockHeight, resubmitAfter, summary, warnings}`.

| Action | Endpoint | Built from |
|---|---|---|
| open / increase | `POST /v1/orders` `{market, side, size, reduceOnly:false}` | #3836 `buildV22Trade` |
| reduce / close | `POST /v1/orders` with `reduceOnly:true`, or `POST /v1/positions/close {market}` (exact current size) | same builder; server checks reduce-only against the live position |
| modify | `POST /v1/orders` with a signed delta (there are no resting orders to amend; a position is modified by trading the difference) | same |
| deposit (and first-time account) | `POST /v1/deposits {market, amount}`; creates the portfolio when missing | `lib/first-trade.ts` init + deposit builders, hook logic moved to lib |
| withdraw | `POST /v1/withdrawals {market, amount}` | `useWithdraw` logic moved to lib, incl. its crank |
| cancel | `POST /v1/orders/cancel {idempotencyKey}` | v2.2 has no resting orders. Cancel means: drop the cached build so the same key cannot be replayed, and report `lastValidBlockHeight` after which the unsigned tx can never land. No on-chain call. Documented as such so nobody expects a book cancel. |

Every builder: validates, applies caps (3.5), builds, sets blockhash/CU/priority fee, then simulates **the exact message it returns** (real blockhash, sigVerify off) and refuses if that fails. #3836 simulates a different message (1.4M CU, placeholder blockhash); v1 keeps those sims for sizing and adds the final one on the returned bytes.

### 3.4 Permissions

- API key: `pbk_<keyId>_<secret>`. Stored as HMAC-SHA256(secret, `BOT_API_KEY_PEPPER`) under `keyId` in Upstash (in-memory store in tests/local). Fields: scopes (`read`, `build`), tier (limits), label, createdAt, revoked. Shown once at issue; logs show `keyId` only.
- Anonymous: read-only at a low per-IP limit. Builders require a key with `build` (they cost RPC scans and simulations).
- Issue/revoke in v1: an ops script (`app/scripts/bot-api/keys.ts`). Self-serve keys via a wallet-signed message (SIWS) are later.
- A key never grants wallet authority. Anyone can build an unsigned tx for any public wallet; only that wallet's signature makes it land. The server holds no keys.
- Gate: `/api/v1` is exempt from the playground cookie only while `BOT_API_ENABLED=1`, and then each route requires its own auth (same rule as the existing exemptions in `lib/playground-gate.ts:79`). Whether the preview should let bots past the waitlist gate at all is Khubair's call (section 8).
- Not in v1: on-chain delegated trade-only keys (Velocity's model). Needs program work.

### 3.5 Safety

| Cap | Default | Caller can | Error |
|---|---|---|---|
| Slippage | 100 bps around the engine effective price (the app uses 500, `lib/slippage.ts:44`; a bot default should be tighter; a refusal is safe, an overfill is not) | set 0..1000 | `slippage_cap_exceeded` above 1000 |
| Order notional | 5,000 USD-equivalent per order (devnet) | lower via `maxNotional` | `notional_cap_exceeded` |
| Size | market `maxTradeSizePerSide` (`lib/limits/risk-limits.ts:277`) | — | `size_cap_exceeded` |
| Leverage after the trade | min(market max, 10x) | lower via `maxLeverage` | `leverage_cap_exceeded` |
| Reduce-only | off | `reduceOnly:true` | `reduce_only_violation` if the order would grow or flip |
| Fee | the market's current cap; a rise needs `maxFeeBps` (#3836) | `maxFeeBps` | `fee_raise_required`, `fee_above_max` |
| Oracle staleness | refuse when stale | — | `market_stale` |
| Request deadline | none | `expiresAfter` (unix ms) | `request_expired` |

Error envelope: `{"error":{"code","message","retryable","onchain":{"code","name"}?,"logs"?}}`. On-chain codes are decoded to names from the existing maps (e.g. 49 `EngineInsufficientInitialMargin` -> `insufficient_margin`, 27 `OracleStale` -> `market_stale`, 21 `EngineLockActive`, 121 `EngineLossStale`). Full catalog in the OpenAPI spec.

### 3.6 Idempotency, blockhash, retries, status

- `Idempotency-Key` header on every POST (SDK always sets one). Stored per (keyId, Idempotency-Key) with the body hash for 120 s (longer than a blockhash lives). Same key + same body returns the same bytes, so a retried sign produces the same signature and the cluster dedupes it. Same key + different body: 409 `idempotency_conflict`. Concurrent duplicate: 409 `idempotency_in_progress`.
- Stale blockhash: responses carry `lastValidBlockHeight`. The SDK checks block height before sending and rebuilds with a new key when close to expiry. Durable nonces are later (one nonce account per user, more rent and setup).
- Retries: the server retries reads it owns (bounded, back-off on 429) and never sends. 5xx and `rpc_unavailable` are `retryable:true`; on-chain refusals are not.
- Status: `GET /v1/tx/{signature}?lastValidBlockHeight=` returns `pending | processed | confirmed | finalized | failed (decoded code) | expired | unknown`. `expired` = not found and current block height > lastValidBlockHeight: safe to rebuild.
- Webhooks are later: they need a durable worker and outbound signing secrets; v1 is polling (and SSE for market data).

### 3.7 Monitoring

- One JSON log line per request: request id, route, keyId, status, error code, latency ms, RPC calls, simulations. No secrets, no raw key.
- Metrics: in-process counters and latency histograms per route/code at `GET /v1/metrics` (Prometheus text, needs an `ops` scope). Per serverless instance; a shared store is later.
- Health: `GET /v1/health` with RPC slot, slot lag, per-market oracle age, kill switch state. Uptime: `app/scripts/bot-api/uptime.ts` (runs anywhere, exits non-zero on failure); scheduling it is an ops decision, not done here.
- Load tests: `app/scripts/bot-api/loadtest.ts` (no new dependency) against a local `next start`, (a) with a recorded-fixture RPC to measure our own overhead and throughput, and (b) against public devnet at a low rate for real end-to-end latency. Report p50/p95/p99, requests/s, error rate.

### 3.8 Docs and SDK

- `GET /v1/openapi.json` (OpenAPI 3.1, hand-written, checked by a test that every route is in the spec and the spec has no route that does not exist).
- `packages/bot-sdk`: small TypeScript client (fetch only). Reads, builders, status, idempotency keys, typed errors. Signing is a callback the caller provides; the SDK never asks for a private key.
- Examples: read markets and account, quote, build + inspect simulation, sign and send on devnet with the caller's own keypair (we do not run the send).

### 3.9 Failure and recovery

| Failure | What the API does | Caller does |
|---|---|---|
| RPC down / 429 | 503 `rpc_unavailable`, `retryable:true`, Retry-After | back off |
| Upstash down | API key lookups fail fast (Upstash client: 1 retry, 1.5 s timeout) as 503 `kv_unavailable`, `retryable:true`, Retry-After 2; they are never answered from a per-instance map and never count toward the auth lockout; a 30 s circuit breaker skips Upstash while it is failing; rate limits and idempotency fall back per instance (existing behaviour, `lib/upstash-rate-limit.ts:83`); `/v1/health` reports `degraded` (503); logged `kv_degraded` | retry after a couple of seconds; replay protection is weaker across instances meanwhile, the chain still dedupes identical signed bytes |
| Oracle stale / keeper down | builders refuse `market_stale`; reads show `stale:true` | wait |
| Owner needs a maintenance crank first | returns only the crank, `resubmitAfter:true` (#3836) | send crank, build again |
| Blockhash expired | status `expired` | rebuild with a new key |
| Fee rose between build and sign | simulation would fail; on chain 98 | build again with `maxFeeBps` |
| Layout / program change | `not_v22` / `market_unreadable` | wait for release |
| Maintenance flag | 503 `maintenance` (`lib/maintenance`) | wait |
| Abuse | weighted limits per key and per address (anonymous IPv6 by /64); global build ceiling (3000/min) with at most 25% (750) per principal; global read/stream ceiling (6000/min); at most 2 open streams per anonymous caller and 5 per key, each stream tick charged; 4 KB body cap enforced while reading; failed-key throttle per address (a valid key is verified first and never refused for others' failures) | — |
| Client address unknown (`TRUSTED_PROXY_DEPTH` does not match the deployment) | on a deployed build anonymous callers get 503 `client_ip_unknown`; keyed callers are limited per key only and no per-address state is kept; `/v1/health` shows `clientIp.resolved:false` and status `degraded` | operator fixes `TRUSTED_PROXY_DEPTH` |
| Upstream RPC 429 | bot routes do not retry 429 (`disableRetryOnRateLimit`): 503 `rpc_unavailable`, Retry-After 2; handler deadline 20 s | back off |
| Deployed build without the shared KV | the API refuses to enable (503 `disabled`, reason names the missing Upstash variables); `/v1/health` flags a memory backend on a deployed build | operator sets `UPSTASH_REDIS_REST_URL` and `_TOKEN` |
| Bad release | `BOT_API_ENABLED` off -> 503 everywhere, gate back to normal | — |

## 4. v1 vs later

v1 (this stack, devnet only, behind `BOT_API_ENABLED`):
- `/api/v1` wrapper: keys, scopes, weighted limits, idempotency, envelope, error catalog, JSON logs, metrics, health, kill switch.
- Reads: markets, market, funding, quote, depth, account, history (signatures), SSE stream.
- Builders: orders (open/modify/reduce/close via reduceOnly), positions/close, deposits (incl. first account), withdrawals, cancel (semantic), all simulated on the returned bytes, with caps.
- Tx status polling.
- OpenAPI, TS SDK, examples, uptime script, load test numbers.
- #3836 stays as is; `/api/v22/trade` keeps working until the owner decides alias vs fold: open (section 8.4).

Later:
- Self-serve keys (SIWS), per-wallet budgets like Hyperliquid's volume-based address limits.
- Webhooks; a durable status worker.
- Fills/history from the lot-aware indexer (#218) once deployed.
- Multi-asset markets, splits over the per-fill cap, lot markets.
- Durable nonces; versioned v0 txs with address lookup tables.
- On-chain features that need the program: resting/limit orders, TP/SL, dead-man cancel, delegated trade-only keys.
- MCP server over the SDK, read-only by default.
- Mainnet: only after launch, its own review, and Khubair's go.

## 5. Risks

| Risk | Mitigation |
|---|---|
| The API builds a tx that trades worse than asked | Limit price always set (0 refused), slippage capped, reduce-only checked server-side, exact-bytes simulation, parity tests against the app builder |
| Two copies of the money path drift | Builders move out of hooks into lib and the hooks call them (as #3836 did for `resolveLpTradeAccounts`) |
| RPC cost / abuse: simulations are expensive | Builds need a key; weighted limits; global build ceiling; LP cache; kill switch |
| Key leak | Hashed with pepper, shown once, revocable, keyId in logs only; a key cannot move funds |
| Opening the gate to bots on the preview | Exemption only for `/api/v1` and only with the flag on; Khubair decides |
| Serverless limits (no long-lived WebSocket) | SSE with bounded lifetime + resume; polling is first-class |
| Per-instance metrics/idempotency on Vercel | Upstash for idempotency; metrics per instance documented; shared metrics later |
| Freshness claims on free devnet RPC | Publish measured numbers, stamp slots, mark stale; no SLA in v1 |
| Demand not there yet | Small, flag-off by default, reuses existing code; adoption metrics decide whether to keep going |

## 6. Success metrics

Correctness:
- Simulation pass rate of builds for eligible intents on live v2.2 markets >= 90% (#3836 measured 10/10).
- 0 returned transactions that fail simulation on their own bytes at return time.
- Instruction parity with the app builders for orders, deposits and withdrawals (tests).
- Every cap and every error code covered by a test that fails when the check is removed.

Service:
- Reads p95 < 500 ms and builds p95 < 3 s on public devnet RPC at bot-realistic rates; fixture-RPC throughput and p50/p95/p99 published from the load test; 5xx rate < 1% excluding upstream RPC 429s (reported separately).

Adoption (after the flag is on):
- A new developer goes from key to a simulated order with the SDK example in under 15 minutes.
- Count of keys issued, weekly active keys, builds per day, and share of builds that are later seen landed (status endpoint).

## 7. Gap list and build plan

The full gap list with file and line is `out/gap-list.md` in the session folder and is repeated here in short.

| # | Gap | Where (today) | Stage |
|---|---|---|---|
| G1 | No public API surface: cookie gate 401s bots | `app/middleware.ts:436-452`, `lib/playground-gate.ts:80-87` | A |
| G2 | No API keys or scopes | only `lib/api-auth.ts:13` (one internal key) | A |
| G3 | Limits are per IP only, no weights, no per-key budget | `app/app/api/v22/trade/route.ts:30-33`, `app/middleware.ts:36` | A |
| G4 | No idempotency | none | A |
| G5 | No error envelope / on-chain code names returned | `route.ts:57-59`, `trade-build.ts:420` | A |
| G6 | No logs/metrics/health for the API | `app/instrumentation.ts:15-17`, `lib/rpc-metrics.ts:4-8` | A |
| G7 | No versioned prefix | `/api/v22/trade` only | A |
| G8 | No v2.2 funding read when funding is on | `app/app/api/funding/[slab]/route.ts:36-38` | B |
| G9 | No quote/depth server-side | `lib/limits/matcher-quote.ts:154,270` client-only | B |
| G10 | No server account/positions read | `hooks/usePortfolio.ts:728` is `"use client"` | B |
| G11 | No v2.2 history | `lib/v22/indexer.ts:9-11`, no lot-aware indexer | B (signatures), later (fills) |
| G12 | No stream / slot stamps | price-ws is DEX price (`scripts/local-price-ws-server.ts:16-23`), no SSE | B |
| G13 | Close/deposit/withdraw only in hooks | `hooks/useClosePosition.ts:232`, `hooks/useDeposit.ts:222,252`, `hooks/useWithdraw.ts:394` | C |
| G14 | First trade (no portfolio) refused | `trade-build.ts:246` | C (deposit creates it) |
| G15 | No size/notional/leverage cap, slippage up to 100% | `route.ts:99-103`, `lib/slippage.ts:44,67` | C |
| G16 | No reduce-only | `trade-build.ts:313` computes it but does not enforce | C |
| G17 | Returned bytes not simulated; no `lastValidBlockHeight` | `lib/tx.ts:190-207`, `trade-build.ts:325` | C |
| G18 | No tx status | browser-only `lib/tx.ts:673` | C |
| G19 | No cancel semantics | no resting orders on chain | C |
| G20 | No OpenAPI | `route.ts:38-51` USAGE only | D |
| G21 | No SDK / examples | no `packages/` | D |
| G22 | No load tests / uptime check | none | D |

Staged plan, each a draft PR stacked on the one before, none merged:
- A `feat/v22-botrails-a` -> `feat/v22-trade-api` (#3836): this doc; `/api/v1` wrapper (kill switch, gate exemption behind flag, keys, scopes, weighted limits, idempotency store, envelope + error catalog, JSON logs, metrics, health). Tests.
- B `feat/v22-botrails-b` -> A: reads: markets, market, funding, quote, depth, account, history, SSE. Tests over recorded devnet fixtures.
- C `feat/v22-botrails-c` -> B: builders: orders (+reduceOnly, caps), positions/close, deposits (+first account), withdrawals, cancel, exact-bytes simulation, `lastValidBlockHeight`, tx status. Unit tests + read-only devnet simulation script.
- D `feat/v22-botrails-d` -> C: OpenAPI + spec test, `packages/bot-sdk`, examples, uptime script, load test and numbers.
Then a full Council on A-D.

## 8. Open decisions for Khubair (not decided; values are provisional devnet test defaults)

None of these has been decided. The code ships with the defaults below only so it can be tested on devnet; changing any of them is a one-line edit.

1. Whether `/api/v1` may bypass the playground waitlist gate on the v2.2 preview when `BOT_API_ENABLED=1` (default: off, so no change).
2. Default caps for devnet: 100 bps slippage, 5,000 USD notional per order, 10x leverage.
3. Who issues keys in v1 (ops script) and whether anonymous reads are allowed (code default today: allowed, `BOT_API_ANON_READS=0` turns them off).
4. Whether #3836's `/api/v22/trade` stays as a public alias or is folded into `/v1/orders`.

### What the equity, fee and error figures do and do not count

Written to match the code (council round 2, `fc04abcd0`), not to claim more.

- **Cap equity and `GET /v1/accounts` equity** = capital + min(0, stored `pnl` + the K/F each open leg has accrued since its snapshot) + min(0, fee credits). The pending part is the engine's own settle arithmetic (`floor(|basis| x (K_now - k_snap) / (a_basis x 1e6))`, plus the same for F; `app/lib/bot-api/reads/pending-pnl.ts`, engine `leg_kf_delta_components_for_settlement_from_targets`), so a loss that accrued after the leg was last touched is counted, and a stored `pnl` of 0 is a valid value. It is exact to within 2 atoms, on the safe side: the sub-atom carries `k_rem_num` / `f_rem_num` are not decoded. **Not counted:** holding rent (`rent_snap` against the rent index) and the social-loss share (`b_snap`); unrealized profit is deliberately not margin. A leg whose pending cannot be computed (older ADL epoch, stale leg) makes an order that adds risk `market_unreadable` rather than guess. The on-chain initial-margin check at trade time is the hard backstop.
- **`expectedFeeBps`** is base fee plus, on a fee-channel market, the matcher's requested fee (the quoted spread, `ceil(|estExec - mark| x 1e4 / mark)`, the program's formula and the one the app's ticket signs). **`allInCostBps`** = base fee + that spread, once. Growth-market utilisation fees are not counted in either.
- A `Custom(n)` is named, and mapped to an API code, only when the Percolator wrapper returned it (the innermost failing program in the logs, else the program of instruction `index`). Any other program's code is `simulation_failed` with the program and number, unnamed.
- **Slippage** is measured from the mark. An order whose limit is tighter than the matcher's estimated fill is refused up front (`slippage_cap_exceeded` with `minSlippageBps`); the estimate is not applied to reducing orders (it does not model the close exemption). The estimate is at the read slot and can differ slightly from the fill.

### Rollback runbook

The kill switch is an env var, and on Vercel an env change only applies to a new deployment, so it is a redeploy (minutes), not instant.

1. Unset `BOT_API_ENABLED` on the project (Vercel dashboard or `vercel env rm BOT_API_ENABLED <environment>`), then redeploy; or, faster, promote the previous good deployment (`vercel promote <deployment-url>` or the dashboard's Instant Rollback).
2. Verify: `curl -i https://<deployment>/api/v1/health` returns 503 with `error.code` `disabled`, and `/api/v22/trade` and the waitlist gate behave as before.
3. One bad or leaked key, no redeploy needed: `npx tsx scripts/bot-api/keys.ts revoke <keyId>` (needs the Upstash variables in the shell); the next request with it gets 401. `show <keyId>` confirms `revoked: true`.
4. KV outage is not a rollback case: key calls answer 503 `kv_unavailable` (retryable) and `/v1/health` reports `degraded`; wait for Upstash or fix the credentials.
