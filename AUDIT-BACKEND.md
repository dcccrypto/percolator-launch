# Backend Audit — Percolator Server

**Date:** 2026-02-10  
**Auditor:** Cobra  
**Branch:** `cobra/feat/faucet-metadata-guide`  
**Scope:** `packages/server/`, Next.js API routes (`app/app/api/`), frontend hooks

---

## 🔴 CRITICAL — Trade History Is Not Indexed

**This is THE bug Khubair reported: "you can't see recent trades."**

### Root Cause
There is **NO trade indexer anywhere in the codebase**. The data flow is completely broken:

1. `db/queries.ts` has `insertTrade()` and `getRecentTrades()` — the functions exist
2. `events.ts` defines a `"trade.executed"` event type — the event type exists
3. **Nobody calls `insertTrade()`. Nobody emits `"trade.executed"`.** Zero callers.
4. The crank service cranks markets but **never parses transaction logs for trade events**
5. The PriceEngine watches slab account changes but **only extracts price**, not trade data
6. There is no transaction parser, no Helius webhook handler, no log listener

### What happens now
- User opens a position → transaction lands on-chain → **nothing records it**
- Frontend `TradeHistory.tsx` polls `/api/markets/[slab]/trades` → Supabase `trades` table → **always empty**
- The trades POST endpoint exists but requires an `INDEXER_API_KEY` and an external caller that **doesn't exist**

### Fix Required
Build a trade indexer. Options:
1. **Helius webhooks** — subscribe to program transactions, parse instruction data, call `insertTrade()`
2. **Transaction log parsing in CrankService** — after each crank, check for position change events
3. **On-chain account diffing** — PriceEngine already gets full slab data on each update; diff account states to detect trades

**Severity: CRITICAL** — Core feature completely non-functional.

---

## 🔴 CRITICAL — Supabase DB Functions Exist But Are Never Called

The server has a full `db/queries.ts` module with:
- `getMarkets()` / `getMarketBySlabAddress()`
- `upsertMarketStats()`
- `insertTrade()`
- `insertOraclePrice()`
- `getRecentTrades()`
- `getPriceHistory()`

**None of these are imported or called by any service.** The crank service doesn't write stats. The oracle service doesn't write prices. The entire Supabase persistence layer is dead code in the Hono server.

Meanwhile, the **Next.js API routes** (`app/app/api/`) talk to Supabase directly via `getServiceClient()`. So there are **two parallel data layers** that don't talk to each other:
- Hono server: in-memory only, no persistence
- Next.js API: Supabase-backed, but no data flowing in

### Fix Required
Either:
1. Wire the Hono server services to call `db/queries.ts` (insert prices, trades, stats after each crank/oracle push)
2. Or build a separate indexer service that populates Supabase

---

## 🔴 CRITICAL — Two Competing Backend Architectures

There are **two backends** serving overlapping functionality:

| Endpoint | Hono Server (port 3001) | Next.js API Routes |
|----------|------------------------|-------------------|
| List markets | `GET /markets` (in-memory) | `GET /api/markets` (Supabase view) |
| Single market | `GET /markets/:slab` (on-chain fetch) | `GET /api/markets/[slab]` (Supabase) |
| Crank | `POST /crank/:slab` | `POST /api/crank` |
| Prices | `GET /prices/:slab` (in-memory) | `GET /api/markets/[slab]/prices` (Supabase) |
| Trades | ❌ No endpoint | `GET /api/markets/[slab]/trades` (Supabase, always empty) |

The frontend uses **both**: WebSocket to Hono for live prices, Next.js API routes for trades/market data. But the Hono server never writes to Supabase, so the Next.js routes return stale/empty data.

### Fix Required
Decide on one architecture. Recommendation: Hono server is the keeper/oracle/price engine. It should **write** to Supabase. Next.js API routes should **read** from Supabase. One writes, one reads.

---

## 🟡 HIGH — InsuranceLPService Always Writes Zero

In `InsuranceLPService.poll()`:
```ts
const insuranceBalance = 0;  // TODO comment in code
const lpSupply = 0;          // TODO comment in code
```

The service inserts a snapshot with `insurance_balance: 0` and `lp_supply: 0` every 30 seconds for every market. This:
- Pollutes `insurance_snapshots` table with useless rows
- APY calculations always return 0 or null
- `GET /api/markets/:slab/insurance` returns garbage data

---

## 🟡 HIGH — Rate Limiting Not Applied to Any Route

`middleware/rate-limit.ts` exports `readRateLimit()` and `writeRateLimit()` middleware, but **neither is used anywhere**. No route in the Hono server applies rate limiting. The crank and market creation endpoints are completely unprotected.

Similarly, `middleware/auth.ts` exports `requireApiKey()` but it's **not applied to any Hono route**. The `POST /crank/:slab` and `POST /crank/all` endpoints can be called by anyone.

---

## 🟡 HIGH — VammService Is Created But Never Started

`services/vamm.ts` defines a `VammService` class with `start()`/`stop()`, but:
- It's never imported in `index.ts`
- Never instantiated or started
- Listens for `"market:created"` events (note the colon), but `events.ts` emits `"market.created"` (with a dot) — **event name mismatch**

Dead code. If it's needed, fix the event name and wire it into the server startup.

---

## 🟡 HIGH — PriceEngine History Is In-Memory Only

`PriceEngine` stores price ticks in a `Map<string, PriceTick[]>` with `maxHistory = 100`. On server restart, all price history is lost. The 24h stats, price charts, and history endpoints all return empty data after a restart.

The `insertOraclePrice()` DB function exists but is never called by PriceEngine or OracleService.

---

## 🟡 HIGH — Next.js Crank Route Uses Wrong Program ID

`app/app/api/crank/route.ts`:
```ts
function getProgramId(): PublicKey {
  return new PublicKey(
    process.env.PROGRAM_ID || "EXsr2Tfz8ntWYP3vgCStdknFBoafvJQugJKAh4nFdo8f",
  );
}
```

The Hono server config defaults to `"8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL"`. These are **different program IDs**. If `PROGRAM_ID` env var isn't set, the two backends discover different markets.

Also, the Next.js crank route only scans one program, while the Hono server scans 3 programs (`allProgramIds`).

---

## 🟡 MEDIUM — WebSocket Reconnect Doesn't Re-subscribe on Re-connect

`PriceEngine.connect()` on "open" calls `this.sendSubscribe()` for existing slabs, but also clears `slabToSubId` implicitly (the new subscription responses overwrite). There's a race condition: if the WebSocket reconnects, it re-sends subscribe messages for keys in `slabToSubId`, but these are stale subscription IDs from the old connection. The `_pendingSubResponses` map correctly handles this, but the old `subscriptionIds` entries (mapping old subIds → slab addresses) are never cleaned up, causing a slow memory leak.

---

## 🟡 MEDIUM — No Heartbeat/Ping on WebSocket Connections

Neither the client-facing WebSocket (`ws.ts`) nor the Helius-facing WebSocket (`PriceEngine.ts`) implement ping/pong keepalive. Connections may silently die behind load balancers/proxies without detection.

---

## 🟡 MEDIUM — Frontend Fetches 24h Stats from Wrong URL

`useLivePrice.ts`:
```ts
fetch(`${WS_URL.replace("ws://", "http://").replace("wss://", "https://")}/prices/${slabAddr}`)
```

This constructs the HTTP URL from the WebSocket URL. If `NEXT_PUBLIC_WS_URL` is something like `wss://api.percolator.xyz`, this works. But if it's the default `ws://localhost:3001`, it fetches from `http://localhost:3001/prices/...` — which won't work in production (different origin, CORS issues with non-whitelisted origins).

---

## 🟡 MEDIUM — Crank Service Discovers Markets Every Cycle

Every `crankIntervalMs` (default 10s), `CrankService` calls `discover()` which does `discoverMarkets()` across 3 programs. Each `discoverMarkets()` call fetches **all program accounts** via `getProgramAccounts`. At 10s intervals across 3 programs, this is 18 RPC calls/minute just for discovery — wasteful and may hit rate limits.

Should: discover on startup + after market creation, not every crank cycle.

---

## 🟡 MEDIUM — No Error Recovery for Supabase

`InsuranceLPService` calls Supabase every 30s. If Supabase is down or credentials are wrong, it logs errors but keeps hammering. No circuit breaker, no backoff. Same issue if Supabase tables don't exist — it'll error-spam the logs indefinitely.

---

## 🟢 LOW — Unused Exports

- `db/queries.ts`: All functions are dead code in the Hono server
- `services/vamm.ts`: Entire module unused
- `utils/rpc-client.ts`: `getCachedAccountInfo()` / `setCachedAccountInfo()` never called
- `middleware/rate-limit.ts` and `middleware/auth.ts`: Never applied

---

## 🟢 LOW — Config Inconsistencies

- `config.ts` has `fallbackRpcUrl` defaulting to `https://api.devnet.solana.com` — fine for devnet but will break on mainnet
- `SOLANA_RPC_URL` vs `RPC_URL` — Next.js crank route uses `SOLANA_RPC_URL`, Hono uses `RPC_URL`
- `HELIUS_API_KEY` vs `NEXT_PUBLIC_HELIUS_API_KEY` — Next.js crank route checks both

---

## Summary: Priority Fix Order

1. **Build a trade indexer** — nothing else matters until trades are visible
2. **Wire Hono services → Supabase** — prices, stats, trades must persist
3. **Fix InsuranceLPService** — either implement properly or disable (stop writing zeros)
4. **Apply rate limiting + auth** to Hono routes
5. **Unify program IDs** across both backends
6. **Add WebSocket keepalive** (ping/pong)
7. **Reduce discovery frequency** in CrankService
8. **Clean up dead code** (VammService, unused DB queries)
