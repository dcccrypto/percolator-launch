# Backend Architecture

The backend is split into three independent services, all deployed on Railway.

---

## Service Overview

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  API         │     │  Keeper         │     │  Indexer         │
│  packages/api│     │ packages/keeper │     │packages/indexer  │
│              │     │                 │     │                  │
│  Hono REST   │     │  CrankService   │     │  MarketDiscovery │
│  WebSocket   │     │  OracleService  │     │  StatsCollector  │
│  Swagger UI  │     │  Liquidation    │     │  TradeIndexer    │
│              │     │                 │     │  InsuranceLP     │
│  read-only   │     │  has keypair    │     │  Helius webhooks │
│  stateless   │     │  no HTTP API    │     │                  │
│  port: 3001  │     │  health: 8081   │     │  port: 3002      │
└──────┬───────┘     └──────┬──────────┘     └──────┬───────────┘
       │                    │                        │
       └────────────────────┴────────────────────────┘
                            │
              ┌─────────────┴──────────────┐
              ▼                            ▼
     ┌──────────────────┐      ┌─────────────────────┐
     │     Supabase      │      │   Solana Blockchain  │
     │   (PostgreSQL)    │      │   + Helius RPC       │
     └──────────────────┘      └─────────────────────┘
```

All three services import shared utilities from `@percolator/shared`:
- `config` — env-validated config object
- `getSupabase()` — Supabase client
- `getConnection()` — Solana RPC connection
- `createLogger()` — structured JSON logging
- `initSentry()` — error tracking
- DB queries, retry utilities, input sanitization

---

## API Service (`packages/api/`)

**Role:** Serve all public data. No keypair, no writes to chain, no background jobs.

**Framework:** Hono on Node.js

**Entry point:** `packages/api/src/index.ts`

### Middleware Stack

Applied in order on every request:

1. **CORS** — strict allowlist via `CORS_ORIGINS` env var. Rejects unknown origins with 403. Supports wildcard patterns (`*.vercel.app`).
2. **Compression** — gzip/brotli for JSON responses.
3. **Security headers** — X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, HSTS.
4. **Rate limiting** — per-IP, separate read (GET) and write (POST/DELETE) limits.
5. **Cache middleware** — in-memory TTL cache with per-route TTLs (10s–5min).

### Route Files

| File | Routes |
|------|--------|
| `routes/health.ts` | `GET /health` |
| `routes/markets.ts` | `GET /markets`, `GET /markets/:slab`, `GET /markets/stats`, `GET /markets/:slab/stats` |
| `routes/trades.ts` | `GET /markets/:slab/trades`, `GET /markets/:slab/volume`, `GET /trades/recent` |
| `routes/prices.ts` | `GET /prices/markets`, `GET /prices/:slab`, `GET /markets/:slab/prices` |
| `routes/funding.ts` | `GET /funding/global`, `GET /funding/:slab`, `GET /funding/:slab/history` |
| `routes/open-interest.ts` | `GET /open-interest/:slab` |
| `routes/insurance.ts` | `GET /insurance/:slab` |
| `routes/crank.ts` | `GET /crank/status` |
| `routes/oracle-router.ts` | `GET /oracle/resolve/:mint` |
| `routes/stats.ts` | `GET /stats` |
| `routes/ws.ts` | WebSocket `/ws` — price streaming |
| `routes/docs.ts` | `GET /docs` — Swagger UI |

### WebSocket Protocol

Clients connect and send subscription messages:

```json
{ "type": "subscribe", "slab": "SLAB_ADDRESS" }
{ "type": "unsubscribe", "slab": "SLAB_ADDRESS" }
```

Server pushes price updates:
```json
{ "type": "price", "slab": "SLAB_ADDRESS", "priceE6": 1500000, "timestamp": 1234567890 }
```

Limits: 500 global connections, 5 per IP, 50 subscriptions per client.

Optional token auth: `?token=slabAddress:timestamp:hmac-sha256-sig` (configurable via `WS_AUTH_REQUIRED`).

### Cache TTLs

| Route | TTL |
|-------|-----|
| `/markets/:slab` | 10s |
| `/markets` | 30s |
| `/funding/:slab` | 30s |
| `/open-interest/:slab` | 15s |
| `/funding/global` | 60s |
| `/stats` | 60s |
| `/oracle/resolve/:mint` | 5 min |

---

## Keeper Service (`packages/keeper/`)

**Role:** Run automated on-chain operations. Has a Solana keypair (`CRANK_KEYPAIR`). No public HTTP API — only a health endpoint.

**Entry point:** `packages/keeper/src/index.ts`

**Health endpoint:** port 8081 (configurable via `KEEPER_HEALTH_PORT`)

### Services

#### CrankService (`services/crank.ts`)

- On startup: discovers all markets across all configured program IDs via `getProgramAccounts`
- Runs two crank loops per market: active markets (shorter interval) and inactive markets
- Batches multiple markets per transaction where possible
- Tracks per-market crank state: last crank time, success/fail count, consecutive misses
- Removes markets from tracking after 3 consecutive discovery misses
- Default intervals: `CRANK_INTERVAL_MS` (active), `CRANK_INACTIVE_INTERVAL_MS` (inactive)

#### OracleService (`services/oracle.ts`)

- Fetches prices from DexScreener, with Jupiter as fallback
- Cross-validates between sources — rejects outliers beyond 30% deviation
- Pushes prices on-chain for markets where the keeper wallet IS the oracle authority
- Only runs for admin-oracle markets (Pyth-oracle markets are self-updating)

#### LiquidationService (`services/liquidation.ts`)

- Polls all markets on a configurable interval
- For each market: fetches all user accounts from the slab, computes mark-to-market PnL
- Executes atomic transactions: `PushOraclePrice` → `KeeperCrank` → `LiquidateAtOracle`
- Liquidation profit goes to the keeper wallet

### Graceful Shutdown

Handles SIGTERM and SIGINT — stops accepting new operations, waits for in-flight transactions, exits cleanly.

---

## Indexer Service (`packages/indexer/`)

**Role:** Background data collection. Writes market data to Supabase. Exposes only `/health` and `/webhook/trades` — no user-facing API.

**Entry point:** `packages/indexer/src/index.ts`

**Port:** 3002 (configurable via `INDEXER_PORT`)

### Services

#### MarketDiscovery (`services/MarketDiscovery.ts`)

- Polls `getProgramAccounts` across all configured program IDs every 5 minutes
- Detects new markets (by slab address)
- Fetches token metadata from Metaplex and Jupiter for each new market
- Upserts into Supabase `markets` table
- Provides `MarketProvider` interface consumed by other services

#### StatsCollector (`services/StatsCollector.ts`)

- Reads all slab accounts every 30 seconds
- Parses slab binary data via `@percolator/core`
- Writes to: `market_stats`, `oi_history`, `funding_history`, `oracle_prices`
- Uses `MarketProvider` for market list (no dependency on CrankService)

#### TradeIndexer (`services/TradeIndexer.ts`)

- Backup/backfill mode: polls recent transactions for each market every 5 minutes
- Primary path: Helius webhooks (via HeliusWebhookManager)
- Parses `TradeCpi` (tag 10) and `TradeNoCpi` (tag 6) instructions from transaction data
- Extracts: trader, side, size, price, timestamp
- Deduplicates by transaction signature
- Writes to `trades` table

#### InsuranceLPService (`services/InsuranceLPService.ts`)

- Monitors insurance vault token accounts across all markets
- Tracks LP token supply (for APY calculations)
- Writes to `insurance_history` table

#### HeliusWebhookManager (`services/HeliusWebhookManager.ts`)

- Auto-registers Helius enhanced webhooks for each market's program ID
- Validates incoming webhook payloads via `HELIUS_WEBHOOK_SECRET`
- Routes trade events to TradeIndexer for immediate processing
- Falls back to polling if webhooks are unavailable

---

## Database Schema

Managed via Supabase migrations (`supabase/migrations/`).

```sql
-- Market metadata (written by indexer on discovery)
markets (
  id               UUID PRIMARY KEY,
  slab_address     TEXT UNIQUE NOT NULL,
  symbol           TEXT,
  name             TEXT,
  mint_address     TEXT,
  deployer         TEXT,
  program_id       TEXT,
  created_at       TIMESTAMP
)

-- Real-time aggregated stats (updated every 30s by StatsCollector)
market_stats (
  slab_address     TEXT PRIMARY KEY REFERENCES markets,
  total_open_interest  TEXT,
  funding_rate     TEXT,
  last_price       TEXT,
  volume_24h       TEXT,
  updated_at       TIMESTAMP
)

-- Trade records (written by TradeIndexer, primary via webhooks)
trades (
  id               UUID PRIMARY KEY,
  slab_address     TEXT,
  side             TEXT,        -- 'long' | 'short'
  price_e6         TEXT,
  size             TEXT,
  trader           TEXT,
  timestamp        TIMESTAMP,
  signature        TEXT UNIQUE  -- deduplication
)

-- Oracle price history
oracle_prices (
  slab_address     TEXT,
  price_e6         TEXT,
  source           TEXT,
  timestamp        TIMESTAMP
)

-- Funding rate snapshots
funding_history (
  market_slab      TEXT,
  slot             TEXT,
  rate_bps_per_slot INT,
  net_lp_pos       TEXT,
  timestamp        TIMESTAMP
)

-- Open interest snapshots
oi_history (
  market_slab      TEXT,
  total_oi         TEXT,
  net_lp_pos       TEXT,
  timestamp        TIMESTAMP
)

-- Insurance fund snapshots
insurance_history (
  market_slab      TEXT,
  balance          TEXT,
  lp_supply        TEXT,
  fee_revenue      TEXT,
  timestamp        TIMESTAMP
)

-- View: markets joined with latest stats (used by GET /markets)
VIEW markets_with_stats AS
  SELECT m.*, ms.*
  FROM markets m
  LEFT JOIN market_stats ms ON m.slab_address = ms.slab_address;
```

---

## Shared Package (`packages/shared/`)

All three services import from `@percolator/shared`. Nothing is duplicated across services.

| Export | Purpose |
|--------|---------|
| `config` | Validated env config object |
| `getSupabase()` | Supabase client with connection pooling |
| `getConnection()` | Solana RPC connection |
| `createLogger(name)` | Structured JSON logger |
| `initSentry(service)` | Sentry initialization |
| `captureException(err)` | Sentry error capture |
| `sendInfoAlert()` / `sendCriticalAlert()` | Ops alerting |
| DB queries | Typed Supabase query helpers |
| `sanitizeString()` / `sanitizeSlabAddress()` | Input sanitization |
| `validateEnv()` | Zod env validation at startup |
| `retry()` | Transaction retry with backoff |
| `EventBus` | In-process pub/sub between services |
| `RpcClient` | Rate-limited RPC with fallback |

---

## Sentry Integration

All three services initialize Sentry at startup with `initSentry(serviceName)`. Errors are captured automatically via the Sentry Node SDK, with service name as a tag for filtering in the Sentry dashboard.

Frontend also has Sentry via `@sentry/nextjs`.

Configure via `SENTRY_DSN` environment variable (shared across all services).

---

## Local Development

```bash
# Terminal 1
pnpm --filter=@percolator/api dev

# Terminal 2
pnpm --filter=@percolator/keeper dev

# Terminal 3
pnpm --filter=@percolator/indexer dev

# Terminal 4
cd app && pnpm dev
```

Or with Docker Compose:
```bash
docker-compose up -d
docker-compose logs -f api
```

---

## Production (Railway)

Each service has its own Dockerfile:
- `Dockerfile.api`
- `Dockerfile.keeper`
- `Dockerfile.indexer`

Services share environment variables. Required for all three: `RPC_URL`, `HELIUS_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`. Keeper additionally requires `CRANK_KEYPAIR`.

See `.env.example` for the full variable reference.
