# Percolator Architecture

Percolator is a permissionless perpetual futures platform built on Solana. The backend runs as three independent services that work together to provide a complete trading experience.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        PERCOLATOR PLATFORM                      │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│                  │         │                  │         │                  │
│    Frontend      │◀───────▶│     API Service  │◀───────▶│     Indexer      │
│   (Next.js)      │         │      (Hono)      │         │     Service      │
│     app/         │         │   packages/api/  │         │ packages/indexer/│
│                  │         │                  │         │                  │
│  - User Interface│         │  - REST Endpoints│         │  - Event Indexing│
│  - Trading UI    │         │  - WebSocket     │         │  - Market Scan   │
│  - Charts        │         │  - Rate Limiting │         │  - Position Track│
│  - Wallet Connect│         │  - Swagger UI    │         │  - Trade Parsing │
│                  │         │                  │         │                  │
└────────┬─────────┘         └────────┬─────────┘         └────────┬─────────┘
         │                            │                            │
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         SUPABASE (PostgreSQL)                   │
│                                                                  │
│  Tables:                                                         │
│  - markets              Market metadata and configuration        │
│  - market_stats         Aggregated market statistics             │
│  - trades               Historical trade records                 │
│  - oracle_prices        Oracle price updates                     │
│  - funding_history      Funding rate snapshots                   │
│  - oi_history           Open interest snapshots                  │
│  - insurance_history    Insurance fund snapshots                 │
│                                                                  │
│  Views:                                                          │
│  - markets_with_stats   Markets joined with latest stats         │
│                                                                  │
│  Functions:                                                      │
│  - RPC endpoints for complex queries                             │
│                                                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────────────────────┐
            │       SOLANA BLOCKCHAIN                │
            │                           ┌──────────┐ │
            │  - Percolator Program     │ Keeper   │ │
            │  - Slab Accounts    ◀─────┤ Service  │ │
            │  - User Accounts          │ (Crank,  │ │
            │  - Token Vaults           │  Liq,    │ │
            │  - Oracle Feeds           │  Oracle) │ │
            │                           └──────────┘ │
            │                       packages/keeper/ │
            └────────────────────────────────────────┘
```

## Service Breakdown

### 1. Frontend (`app/`)

**Technology**: Next.js 14 (App Router), React, TailwindCSS, GSAP

**Purpose**: User-facing web application for trading and market monitoring.

**Key Features**:
- Trading interface with order placement
- Real-time market data visualization
- Interactive price charts (TradingView style)
- Wallet integration (Phantom, Solflare, etc.)
- Position management and portfolio tracking
- Quick Launch wizard for market creation
- Admin dashboard for market management

**Communication**:
- Consumes REST API from the API service
- Subscribes to WebSocket for real-time price updates
- Directly interacts with Solana blockchain for wallet transactions

**Entry Point**: `app/page.tsx`

---

### 2. API Service (`packages/api/`)

**Technology**: Hono (lightweight web framework), TypeScript

**Purpose**: REST API server providing read access to market data and platform statistics.

**Key Features**:
- **RESTful Endpoints**: 20+ endpoints for markets, trades, prices, funding, insurance, stats
- **WebSocket Server**: Real-time price streaming via Helius Geyser
- **Response Caching**: Intelligent caching with varying TTLs (10-60s)
- **Rate Limiting**: Token-bucket rate limiter (10 req/s per client)
- **CORS Handling**: Configurable allowlist of trusted origins
- **Health Monitoring**: Service health checks for DB and RPC connectivity
- **API Documentation**: Interactive Swagger UI at `/docs`
- **CSP Headers**: Content-Security-Policy for Swagger UI resources

**Data Sources**:
- **Supabase**: Primary data source for historical and aggregated data
- **Solana RPC**: On-chain data for real-time market details
- **Helius Geyser**: WebSocket streaming for live price updates

**Entry Point**: `packages/api/src/index.ts`

**Port**: 3001 (default)

---

### 3. Keeper Service (`packages/keeper/`)

**Technology**: TypeScript, Node.js

**Purpose**: Automated cron jobs for market maintenance and keeper operations.

**Key Responsibilities**:

1. **Crank Bot** (`crank.ts`):
   - Discovers all markets across 3 program tiers via `getProgramAccounts`
   - Cranks every market every 10 seconds (batched, rate-limited)
   - Updates funding rates, mark prices, and risk metrics
   - Handles 43+ markets concurrently with 0 failures

2. **Liquidation Scanner** (`liquidation.ts`):
   - Scans all markets every 15 seconds for undercollateralized positions
   - Auto-executes liquidations with atomic crank → liquidate transactions
   - Profit from liquidation rewards

3. **Oracle Pusher** (`oracle-push.ts`):
   - Pushes oracle prices for admin-oracle markets where keeper wallet is authority
   - Only pushes when the keeper wallet IS the oracle authority
   - Circuit breaker enforcement for price sanity checks

**Entry Point**: `packages/keeper/src/index.ts`

**Runs**: As a long-running background process (systemd, PM2, Railway, or Docker)

---

### 4. Indexer Service (`packages/indexer/`)

**Technology**: TypeScript, Node.js

**Purpose**: Background service that continuously monitors the Solana blockchain and indexes data into Supabase.

**Key Responsibilities**:

1. **Trade Indexer** (`TradeIndexer.ts`):
   - Listens for successful crank events
   - Parses on-chain transactions for TradeCpi (tag 10) and TradeNoCpi (tag 6)
   - Extracts trader, size, side, price from instruction data
   - Writes to Supabase `trades` table with deduplication

2. **Market Discovery** (`MarketDiscovery.ts`):
   - Scans all program tiers for new markets
   - Auto-registers discovered markets in Supabase
   - Fetches token metadata from Metaplex and Jupiter

3. **Position Tracker** (`PositionTracker.ts`):
   - Monitors slab accounts for position changes
   - Updates aggregated position stats
   - Tracks insurance fund balances

4. **Data Pipeline**:
   - Validates and sanitizes on-chain data
   - Transforms data into queryable formats
   - Ensures data consistency via transaction signature deduplication

**Entry Point**: `packages/indexer/src/index.ts`

**Runs**: As a long-running background process (systemd, PM2, Railway, or Docker)

---

## Core Package (`packages/core/`)

**Purpose**: Shared TypeScript SDK for on-chain data parsing and instruction encoding.

**Contents**:
- **Slab Parser** (`solana/slab.ts`): Parse binary slab account data
- **Instruction Encoders** (`abi/instructions.ts`): Encode all 29 program instructions
- **Event Decoder**: Decode program logs and events
- **Oracle Router** (`oracle/price-router.ts`): Multi-source price resolution (DexScreener, Jupiter, Pyth)
- **Trading Math** (`math/`): PnL, liquidation price, margin calculations
- **Market Discovery** (`solana/discovery.ts`): On-chain market scanning
- **Error Codes** (`abi/errors.ts`): All 34 error codes with human-readable messages

**Used By**: All services (app, api, keeper, indexer)

---

## Data Flow

### User Trades a Position

```
1. User (Frontend)
   │
   │ Sign transaction with wallet
   ▼
2. Solana Blockchain
   │
   │ Execute Percolator program
   │ Emit trade event logs
   ▼
3. Indexer
   │
   │ Listen to program logs
   │ Parse trade event
   │ Insert into trades table
   ▼
4. Supabase (Database)
   │
   │ Store trade record
   │ Update market_stats
   ▼
5. API Service
   │
   │ WebSocket push to connected clients
   │ Cache invalidation
   ▼
6. Frontend
   │
   │ Update UI with new trade
   │ Refresh positions
   └─▶ User sees confirmation
```

### User Views Market Data

```
1. User (Frontend)
   │
   │ Request market data
   ▼
2. API Service
   │
   │ Check cache (30s TTL)
   │ If miss, query Supabase
   ▼
3. Supabase (Database)
   │
   │ Return markets_with_stats view
   ▼
4. API Service
   │
   │ Cache response
   │ Return JSON
   ▼
5. Frontend
   │
   │ Render market list
   └─▶ User sees markets
```

### Indexer Updates Market Stats

```
1. Indexer (Cron Job - every 10s)
   │
   │ Fetch all market slab accounts
   ▼
2. Solana RPC
   │
   │ Return account data
   ▼
3. Indexer
   │
   │ Parse slab data (packages/core)
   │ Extract: OI, funding, price, insurance
   ▼
4. Supabase (Database)
   │
   │ Upsert market_stats
   │ Insert funding_history
   │ Insert oi_history
   │
   │ (cached data now stale)
   ▼
5. API Service
   │
   │ Cache expires naturally (TTL)
   │ Next request gets fresh data
   └─▶ Frontend sees updated data
```

---

## Database Schema (Simplified)

```sql
-- Core market metadata
markets (
  slab_address TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  mint_address TEXT,
  deployer TEXT,
  created_at TIMESTAMP,
  ...
)

-- Real-time aggregated stats (updated by indexer)
market_stats (
  slab_address TEXT PRIMARY KEY,
  total_open_interest TEXT,
  funding_rate TEXT,
  last_price TEXT,
  volume_24h TEXT,
  updated_at TIMESTAMP,
  ...
)

-- Historical trades
trades (
  id UUID PRIMARY KEY,
  slab_address TEXT,
  side TEXT,
  price_e6 TEXT,
  size TEXT,
  timestamp TIMESTAMP,
  signature TEXT
)

-- Oracle price updates
oracle_prices (
  slab_address TEXT,
  price_e6 TEXT,
  timestamp TIMESTAMP,
  source TEXT
)

-- Funding rate history
funding_history (
  market_slab TEXT,
  slot TEXT,
  rate_bps_per_slot INT,
  net_lp_pos TEXT,
  timestamp TIMESTAMP,
  ...
)

-- Open interest snapshots
oi_history (
  market_slab TEXT,
  total_oi TEXT,
  net_lp_pos TEXT,
  timestamp TIMESTAMP
)

-- Insurance fund snapshots
insurance_history (
  market_slab TEXT,
  balance TEXT,
  fee_revenue TEXT,
  timestamp TIMESTAMP
)

-- Optimized view for market listing
VIEW markets_with_stats AS
  SELECT m.*, ms.*
  FROM markets m
  LEFT JOIN market_stats ms ON m.slab_address = ms.slab_address;
```

---

## Environment Configuration

### Shared Config (all backend services)

```bash
# Solana RPC (Helius recommended)
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
FALLBACK_RPC_URL=https://api.devnet.solana.com
HELIUS_API_KEY=your-helius-api-key

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=xxx

# Program IDs
ALL_PROGRAM_IDS=FxfD37s1...,FwfBKZXb...,g9msRSV3...

# Error tracking
SENTRY_DSN=https://xxx@sentry.io/xxx

# Node Environment
NODE_ENV=production
```

### API Service

```bash
API_PORT=3001
CORS_ORIGINS=https://percolatorlaunch.com
API_AUTH_KEY=your-api-key
WS_AUTH_REQUIRED=false
```

### Keeper Service

```bash
CRANK_KEYPAIR=your-base58-keypair
CRANK_INTERVAL_MS=30000
KEEPER_HEALTH_PORT=8081
```

### Indexer Service

```bash
INDEXER_PORT=3002
WEBHOOK_URL=https://your-indexer.railway.app
HELIUS_WEBHOOK_SECRET=your-webhook-secret
```

### Frontend

```bash
NEXT_PUBLIC_API_URL=https://your-api.railway.app
NEXT_PUBLIC_WS_URL=wss://your-api.railway.app
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxx
```

---

## Running Locally

### Prerequisites

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials
```

### Development Mode (All Services)

```bash
# Terminal 1: API Service
cd packages/api
pnpm dev

# Terminal 2: Keeper Service
cd packages/keeper
pnpm dev

# Terminal 3: Indexer Service
cd packages/indexer
pnpm dev

# Terminal 4: Frontend
cd app
pnpm dev
```

Access:
- Frontend: http://localhost:3000
- API: http://localhost:3001
- API Docs: http://localhost:3001/docs

### Docker Compose (Recommended)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

The `docker-compose.yml` file orchestrates all three services with proper networking and dependencies.

---

## Deployment

### Production Architecture

```
                        ┌─────────────┐
                        │   Cloudflare│
                        │   (CDN/WAF) │
                        └──────┬──────┘
                               │
                   ┌───────────┴───────────┐
                   │                       │
              HTTPS│                       │HTTPS
                   ▼                       ▼
         ┌──────────────┐         ┌──────────────┐
         │   Frontend   │         │   API Server │
         │  (Vercel)    │         │  (Railway)   │
         └──────────────┘         └──────┬───────┘
                                         │
                          ┌──────────────┴──────────────┐
                          │                             │
                          ▼                             ▼
                   ┌─────────────┐         ┌───────────────────────┐
                   │  Supabase   │         │  Backend Workers      │
                   │ (Postgres)  │◀───────▶│  (Railway)            │
                   └─────────────┘         │                       │
                          ▲                │  - Keeper (crank/liq) │
                          │                │  - Indexer (events)   │
                          │                └───────────┬───────────┘
                          │                            │
                          └────────────────────────────┘
                                                       ▼
                                          ┌─────────────────────┐
                                          │  Solana Blockchain  │
                                          │  (Helius RPC)       │
                                          └─────────────────────┘
```

### Deployment Checklist

- [ ] **Frontend**: Deploy to Vercel
  - Set environment variables for API URLs
  - Configure custom domain
  - Enable preview deployments

- [ ] **API Service**: Deploy to Railway
  - Set production environment variables (see `packages/api/.env.example`)
  - Configure health check endpoint (`/health`)
  - Enable HTTPS and CORS allowlist
  - Set up rate limiting and caching

- [ ] **Keeper Service**: Deploy to Railway as background worker
  - Set production environment variables (see `packages/keeper/.env.example`)
  - Configure crank wallet keypair (CRANK_KEYPAIR env var)
  - Set crank/liquidation intervals
  - Configure restart policy (auto-restart on failure)
  - Set up logging and monitoring
  - Enable alerts for crank failures

- [ ] **Indexer Service**: Deploy to Railway as background worker
  - Set production environment variables (see `packages/indexer/.env.example`)
  - Configure Supabase service role key
  - Set indexing interval (default 5s)
  - Configure restart policy
  - Set up logging and monitoring
  - Enable alerts for indexing failures

- [ ] **Database**: Supabase
  - Configure connection pooling
  - Set up backups
  - Enable row-level security (if needed)
  - Monitor query performance

- [ ] **Monitoring**:
  - Configure Sentry DSN (all services have Sentry built in)
  - Set up uptime monitoring
  - Monitor database performance

---

## Security Considerations

1. **API Rate Limiting**: Prevents abuse and DoS attacks
2. **CORS Configuration**: Restricts API access to trusted origins
3. **Input Validation**: All user inputs sanitized and validated
4. **Database Access**: Read-only access for API, write access for indexer
5. **Secrets Management**: Environment variables, never hardcoded
6. **HTTPS Only**: Production API must use HTTPS
7. **Wallet Security**: Never store private keys, use client-side signing

---

## Performance Optimizations

1. **Response Caching**: Reduces database load (30-60s TTLs)
2. **Database Indexing**: Indexes on frequently queried columns
3. **Connection Pooling**: Reuse database connections
4. **Batch Processing**: Indexer processes events in batches
5. **WebSocket**: Reduces polling overhead for real-time data
6. **Compression**: gzip/brotli for API responses
7. **CDN**: Frontend assets served via CDN

---

## Monitoring & Observability

### Key Metrics to Track

**API Service**:
- Request rate (req/min)
- Response time (p50, p95, p99)
- Error rate (4xx, 5xx)
- Cache hit rate

**Keeper Service**:
- Crank success rate
- Liquidations executed
- Oracle push frequency
- Error rate

**Indexer Service**:
- Events indexed per minute
- Processing lag (blockchain vs database)
- Error rate
- Database write throughput

**Database**:
- Query performance (slow query log)
- Connection pool usage
- Table sizes
- Index efficiency

### Logging

All services use structured logging with the `createLogger` utility from `@percolator/shared`:

```typescript
import { createLogger } from "@percolator/shared";
const logger = createLogger("api:markets");

logger.info("Market fetched", { slab, cached: true });
logger.error("Failed to fetch market", { slab, error: err.message });
```

---

## Troubleshooting

### API Service Not Responding

1. Check health endpoint: `GET /health`
2. Verify RPC connectivity (check RPC endpoint status)
3. Verify Supabase connectivity (check credentials)
4. Review logs for errors

### Indexer Not Updating Data

1. Check indexer process is running
2. Verify RPC endpoint is accessible
3. Check Supabase write permissions
4. Review logs for parsing errors

### Stale Data in Frontend

1. Check cache TTL settings in API
2. Verify indexer is running and updating stats
3. Clear browser cache
4. Check WebSocket connection status

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on:
- Code style and conventions
- Adding new endpoints
- Database migrations
- Testing requirements

---

## License

MIT
