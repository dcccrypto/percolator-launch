# Percolator Launch

**Pump.fun for Perps** — Launch perpetual futures markets for any Solana token in one click.

Built on [Percolator](https://github.com/aeyakovenko/percolator) by Anatoly Yakovenko. Permissionless, coin-margined, fully on-chain.

[![Live on Devnet](https://img.shields.io/badge/Devnet-Live-14F195?style=flat&logo=solana)](https://percolatorlaunch.com)
[![Tests](https://img.shields.io/badge/Tests-381%20passing-14F195?style=flat)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat&logo=typescript)](/)

---

## What is Percolator?

Percolator is a **permissionless perpetual futures protocol** on Solana. Anyone can deploy a leveraged trading market for any SPL token — no listing fees, no governance votes, no middlemen.

**How it works in 30 seconds:**
1. Pick any Solana token (if it has a DEX pool, it works)
2. Set leverage (up to 20x) and trading fees
3. Click deploy — market goes live on-chain in ~30 seconds
4. Share the link — anyone with a wallet can trade long/short
5. vAMM provides automatic initial liquidity
6. Insurance fund collects fees and protects against bad debt

**Coin-margined** — Traders deposit the same token they're trading. Trading a BONK perp? You deposit BONK as collateral. PnL is in BONK.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Backend Services](#backend-services)
- [Frontend](#frontend)
- [On-Chain Program](#on-chain-program)
- [Testing](#testing)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

### Prerequisites

- **Node.js** 20+ and **pnpm** 8+
- **Solana CLI** v2.x (for program builds)
- **Rust** + `cargo-build-sbf` (for program builds)
- A **Phantom** or **Solflare** wallet (for testing)

### 1. Clone & Install

```bash
git clone https://github.com/dcccrypto/percolator-launch.git
cd percolator-launch
pnpm install
```

### 2. Configure Environment

```bash
# Copy root env (shared config for all backend services)
cp .env.example .env
# Edit: add HELIUS_API_KEY, SUPABASE_URL, SUPABASE_KEY, CRANK_KEYPAIR, etc.

# Frontend
cp app/.env.local.example app/.env.local
```

### 3. Run Development

```bash
# Frontend (Next.js dev server on :3000)
cd app && pnpm dev

# Backend services (each in a separate terminal)
pnpm --filter=@percolator/api dev        # REST API + WebSocket on :3001
pnpm --filter=@percolator/keeper dev     # Crank bot, oracle pusher, liquidations
pnpm --filter=@percolator/indexer dev    # Trade indexing, market discovery, Helius webhooks
```

### 4. Build the Solana Program

```bash
cd program

# Small tier (256 accounts, ~0.44 SOL rent)
cargo build-sbf --features small

# Medium tier (1024 accounts, ~1.73 SOL rent)
cargo build-sbf --features medium

# Large tier (4096 accounts, ~6.87 SOL rent)
cargo build-sbf
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js 14)                     │
│  Landing → Create Wizard → Trade → My Markets → Portfolio     │
└──────────────────────┬───────────────────────────────────────┘
                       │ REST + WebSocket
┌──────────────────────▼───────────────────────────────────────┐
│                       Backend Services (Railway)              │
│  ┌──────────────┬─────────────────┬────────────────────────┐ │
│  │  API         │  Keeper         │  Indexer               │ │
│  │  (Hono)      │  (no HTTP)      │  (Hono, webhook only)  │ │
│  │  REST API    │  Crank bot      │  Trade indexing        │ │
│  │  WebSocket   │  Liquidations   │  Market discovery      │ │
│  │  Swagger UI  │  Oracle pusher  │  Stats collection      │ │
│  │  read-only   │  has keypair    │  Helius webhooks       │ │
│  │  stateless   │  stateful       │  InsuranceLP tracking  │ │
│  └──────────────┴─────────────────┴────────────────────────┘ │
└──────────────────────┬───────────────────────────────────────┘
                       │
           ┌───────────┴──────────┐
           ▼                      ▼
┌─────────────────┐    ┌──────────────────────────┐
│   Supabase      │    │   Solana Blockchain       │
│  (PostgreSQL)   │    │   Percolator Programs     │
│  market data    │    │   Slab Accounts           │
│  trade history  │    │   Token Vaults            │
│  stats          │    │   Oracle Feeds            │
└─────────────────┘    └──────────────────────────┘
```

**Key design decisions:**
- **Slab architecture** — Each market is a single large Solana account ("slab") containing config, engine state, and all user accounts. No account fan-out.
- **Coin-margined** — Collateral = the traded token. No USDC dependency.
- **3-service backend** — API (read-only), Keeper (has keypair), Indexer (writes to DB). Clear separation of concerns.
- **Variable slab sizes** — 3 tiers with different rent costs and capacity.

---

## Project Structure

```
percolator-launch/
├── app/                          # Next.js 14 frontend (Vercel)
│   ├── app/                      # App Router pages
│   │   ├── page.tsx              # Landing page
│   │   ├── create/               # Quick Launch wizard (6-step)
│   │   ├── markets/              # Browse all markets
│   │   ├── trade/[slab]/         # Trading interface
│   │   ├── my-markets/           # Admin dashboard
│   │   ├── portfolio/            # Positions across all markets
│   │   ├── devnet-mint/          # Token faucet (devnet only)
│   │   └── guide/                # Devnet vs mainnet guide
│   ├── components/               # UI components
│   ├── hooks/                    # React hooks
│   └── lib/                      # Utilities, trading math, error messages
│
├── packages/
│   ├── core/                     # @percolator/core — shared TS SDK
│   │   └── src/
│   │       ├── abi/              # Instruction encoders, error codes
│   │       ├── math/             # PnL, liquidation price, margin
│   │       ├── oracle/           # DEX oracle parsers (PumpSwap, Raydium, Meteora)
│   │       └── solana/           # Slab parser, market discovery, PDA derivation
│   │
│   ├── shared/                   # @percolator/shared — common backend utilities
│   │   └── src/
│   │       ├── config.ts         # Shared config from env vars
│   │       ├── db/               # Supabase client + typed queries
│   │       ├── utils/            # Solana utilities, RPC client, binary helpers
│   │       ├── services/         # Event bus
│   │       ├── logger.ts         # Structured logger
│   │       ├── sentry.ts         # Sentry integration
│   │       ├── sanitize.ts       # Input sanitization
│   │       ├── validation.ts     # Zod env validation
│   │       └── retry.ts          # Transaction retry utilities
│   │
│   ├── api/                      # @percolator/api — REST API + WebSocket (Railway)
│   │   └── src/
│   │       ├── index.ts          # Hono app, CORS, security headers, routes
│   │       ├── routes/           # 12 route files (markets, trades, prices, etc.)
│   │       ├── middleware/       # Rate limiting, caching, slab validation
│   │       └── routes/ws.ts      # WebSocket price streaming
│   │
│   ├── keeper/                   # @percolator/keeper — crank bot (Railway, has keypair)
│   │   └── src/
│   │       ├── index.ts          # Service orchestrator + health HTTP server
│   │       └── services/
│   │           ├── crank.ts      # Multi-market crank loop
│   │           ├── oracle.ts     # Oracle price pusher
│   │           └── liquidation.ts # Liquidation scanner + executor
│   │
│   ├── indexer/                  # @percolator/indexer — event indexing (Railway)
│   │   └── src/
│   │       ├── index.ts          # Hono app (/health + /webhook/trades)
│   │       ├── routes/           # Webhook receiver
│   │       └── services/
│   │           ├── MarketDiscovery.ts       # Discover new markets on-chain
│   │           ├── StatsCollector.ts        # Read slabs → write stats to Supabase
│   │           ├── TradeIndexer.ts          # Polling-based trade indexing (backup)
│   │           ├── InsuranceLPService.ts    # Track insurance fund + LP metrics
│   │           └── HeliusWebhookManager.ts  # Register + handle Helius webhooks
│   │
│   └── simulation/               # @percolator/simulation — price simulation for testing
│
├── program/                      # Solana BPF program (Rust)
│   ├── src/lib.rs                # All instruction handlers (Tags 0-28)
│   └── Cargo.toml                # Feature flags: small, medium, large (default)
│
├── percolator/                   # Risk engine (Rust crate, from aeyakovenko/percolator)
│
├── tests/                        # Integration tests (devnet)
│   ├── t1-market-boot.ts
│   ├── t2-user-lifecycle.ts
│   ├── t3-hyperp-lifecycle.ts
│   ├── t4-liquidation.ts
│   ├── t6-risk-gate.ts
│   ├── t7-market-pause.ts
│   └── t8-trading-fee-update.ts
│
├── docs/                         # Architecture and planning docs
├── supabase/                     # Database migrations
├── .env.example                  # Environment variable template
└── docker-compose.yml            # Local multi-service stack
```

---

## Backend Services

The backend runs as three independent services on Railway, all sharing config from `@percolator/shared`.

### API (`packages/api/`)

Read-only, stateless REST API and WebSocket server. No keypair, no writes to chain.

- **Framework**: Hono
- **Port**: 3001 (default)
- **WebSocket**: price streaming — clients subscribe by slab address
- **Swagger UI**: `/docs`
- **Auth**: `x-api-key` header for write endpoints
- **Rate limiting**: per-IP, separate read/write limits
- **CORS**: strict allowlist, rejects unknown origins in production
- **Security headers**: X-Frame-Options, X-Content-Type-Options, etc.

See [`packages/api/README.md`](./packages/api/README.md) for full endpoint list.

### Keeper (`packages/keeper/`)

Runs 24/7 with a Solana keypair. Maintains all active markets.

- **CrankService**: discovers all markets across 3 program tiers, cranks on configurable interval
- **OracleService**: pushes prices for admin-oracle markets where keeper is the oracle authority
- **LiquidationService**: scans for undercollateralized positions, executes liquidations
- **Health endpoint**: port 8081 (default)
- **Devnet stats**: 51 markets, 14,500+ cranks, zero failures

See [`packages/keeper/README.md`](./packages/keeper/README.md).

### Indexer (`packages/indexer/`)

Background service that writes market data to Supabase. Only exposes `/health` and `/webhook/trades`.

- **MarketDiscovery**: polls on-chain for new markets, registers in Supabase
- **StatsCollector**: reads slab accounts every 30s → writes market_stats, oi_history, funding_history
- **TradeIndexer**: polling-based trade indexing (backup to webhooks)
- **InsuranceLPService**: tracks insurance fund balances and LP supply for APY
- **HeliusWebhookManager**: auto-registers Helius webhooks for real-time trade notifications
- **Port**: 3002 (default)

See [`packages/indexer/README.md`](./packages/indexer/README.md).

### API Routes Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health, uptime, stats |
| `/markets` | GET | All markets with stats |
| `/markets/:slab` | GET | On-chain market details (10s cache) |
| `/markets/:slab/trades` | GET | Recent trades (max 200) |
| `/markets/:slab/prices` | GET | Price history for charting |
| `/markets/:slab/volume` | GET | 24h volume and trade count |
| `/funding/global` | GET | Funding rates for all markets |
| `/funding/:slab` | GET | Current rate + 24h history |
| `/funding/:slab/history` | GET | Historical funding data |
| `/open-interest/:slab` | GET | Current OI + history |
| `/insurance/:slab` | GET | Insurance fund balance + history |
| `/crank/status` | GET | Per-market crank stats |
| `/oracle/resolve/:mint` | GET | Best price source for a token mint |
| `/stats` | GET | Platform-wide aggregated statistics |
| `/prices/markets` | GET | Current prices for all markets |
| `/prices/:slab` | GET | Price history (last 100 updates) |
| `/trades/recent` | GET | Recent trades across all markets |
| `/prices/ws` | WebSocket | Live price streaming |

---

## Frontend

Next.js 14 (App Router), deployed on Vercel.

### Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/create` | Quick Launch wizard — 6 steps from token selection to live market |
| `/markets` | Browse all markets — search, filter, sort |
| `/trade/[slab]` | Trading interface — chart, form, position panel, trade history |
| `/my-markets` | Admin dashboard — push prices, pause, configure |
| `/portfolio` | Positions across all markets with aggregate PnL |
| `/devnet-mint` | Token faucet with custom metadata (devnet only) |
| `/guide` | Devnet vs mainnet guide |

### Key Hooks

| Hook | Purpose |
|------|---------|
| `useMarketConfig` | Parse slab on-chain data into typed config |
| `useSlabState` | Full slab state: config, engine, params, accounts |
| `useLivePrice` | Real-time price: WebSocket → Jupiter → on-chain fallback |
| `useTrade` | Execute trades with auto-crank, retry, error handling |
| `useAdminActions` | Admin ops: push price, pause, set fees, renounce |
| `useTokenMeta` | Token metadata with Metaplex → Jupiter → fallback |
| `useInsuranceLP` | Insurance fund deposit/withdraw/balance |

---

## On-Chain Program

### Slab Layout

Each market is a single Solana account:

```
Header (72 bytes)         — magic, version, bump, admin, flags
MarketConfig (320 bytes)  — collateral_mint, vault, oracle config
Engine State (256 bytes)  — mark price, funding, open interest, EWMA
Params (variable)         — leverage, margins, fees, liquidation params
Bitmap (variable)         — used account slots
Accounts (N × slot_size) — per-user: kind, owner, position, capital, pnl
```

### Key Instructions

| Tag | Instruction | Who |
|-----|------------|-----|
| 0 | `InitSlab` | Creator |
| 1 | `InitMarket` | Creator |
| 2 | `InitLP` | Creator |
| 3 | `InitUser` | Anyone |
| 4 | `DepositCollateral` | Trader |
| 5 | `WithdrawCollateral` | Trader |
| 6 | `TradeNoCpi` | Trader |
| 7 | `LiquidateAtOracle` | Anyone |
| 8 | `KeeperCrank` | Anyone |
| 9 | `PushOraclePrice` | Oracle Auth |
| 10 | `TradeCpi` | Trader (vAMM) |
| 14 | `AdminForceClose` | Admin |
| 15 | `SetRiskThreshold` | Admin |
| 23 | `RenounceAdmin` | Admin |
| 24 | `CreateInsuranceMint` | Admin |
| 25 | `DepositInsuranceLP` | Anyone |
| 26 | `WithdrawInsuranceLP` | LP holder |
| 27 | `PauseMarket` | Admin |
| 28 | `UnpauseMarket` | Admin |

### Deployed Programs

**Devnet:**

| Tier | Max Accounts | Rent | Program ID |
|------|-------------|------|------------|
| Small | 256 | ~0.44 SOL | `FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD` |
| Medium | 1024 | ~1.73 SOL | `FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn` |
| Large | 4096 | ~6.87 SOL | `g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in` |

**Matcher (vAMM):** `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy`

**Mainnet:**
- Program: `GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24`
- Matcher: `DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX`

---

## Testing

381 tests across all packages, split between unit tests and devnet integration tests.

```bash
# All tests
pnpm test

# Per package
pnpm --filter=@percolator/core test
pnpm --filter=@percolator/api test
pnpm --filter=@percolator/keeper test
pnpm --filter=@percolator/indexer test

# Integration tests (requires funded devnet wallet)
npx tsx tests/t1-market-boot.ts
npx tsx tests/t2-user-lifecycle.ts
npx tsx tests/t3-hyperp-lifecycle.ts
npx tsx tests/t4-liquidation.ts
npx tsx tests/t6-risk-gate.ts
npx tsx tests/t7-market-pause.ts
npx tsx tests/t8-trading-fee-update.ts

# E2E
pnpm test:e2e
```

**CI (GitHub Actions):** unit, integration, e2e, security, type check, coverage gate on every PR.

### Test Wallet Setup

Tests use `~/.config/solana/id.json`. Fund it with:
```bash
solana airdrop 2 --url devnet
```

---

## Environment Variables

All backend services share a single `.env` file (root or per-package). Copy `.env.example` to get started.

### Shared (all backend services)

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | Yes | Helius RPC endpoint (include API key in URL) |
| `HELIUS_API_KEY` | Yes | Helius API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase anon or service role key |
| `PROGRAM_ID` | No | Default program ID to scan (devnet small tier) |
| `ALL_PROGRAM_IDS` | No | Comma-separated list of all program IDs to monitor |
| `FALLBACK_RPC_URL` | No | Fallback RPC (default: public devnet) |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |

### API Service

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3001` | Listen port |
| `API_AUTH_KEY` | — | API key for protected endpoints |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins (required in production) |
| `WS_AUTH_SECRET` | — | HMAC secret for WebSocket token auth |
| `WS_AUTH_REQUIRED` | `false` | Require WS auth tokens |
| `MAX_WS_CONNECTIONS` | `1000` | Global WebSocket connection limit |

### Keeper Service

| Variable | Required | Description |
|----------|----------|-------------|
| `CRANK_KEYPAIR` | Yes | Base58 or JSON array secret key for crank wallet |
| `CRANK_INTERVAL_MS` | No | Crank interval for active markets (default: 30s) |
| `CRANK_INACTIVE_INTERVAL_MS` | No | Interval for inactive markets (default: 60s) |
| `KEEPER_HEALTH_PORT` | No | Health endpoint port (default: 8081) |

### Indexer Service

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | `3002` | HTTP server port (health + webhook) |
| `INDEXER_API_KEY` | — | Auth key for internal endpoints |
| `WEBHOOK_URL` | — | Public URL for Helius webhook registration |
| `HELIUS_WEBHOOK_SECRET` | — | Secret to validate incoming webhook payloads |
| `DISCOVERY_INTERVAL_MS` | `300000` | Market discovery polling interval (5 min) |

### Frontend (`app/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (server-side only) |
| `NEXT_PUBLIC_API_URL` | No | Backend API base URL |
| `NEXT_PUBLIC_WS_URL` | No | WebSocket URL for live prices |
| `NEXT_PUBLIC_RPC_URL` | No | Solana RPC endpoint |
| `NEXT_PUBLIC_NETWORK` | No | `devnet` or `mainnet-beta` |

---

## Deployment

### Frontend — Vercel

Auto-deploys from `main` via Vercel. Set env vars in the Vercel dashboard. Production: https://percolatorlaunch.com

### Backend — Railway

Three independent services. Each has its own Dockerfile:

```
Dockerfile.api      — API service
Dockerfile.keeper   — Keeper service
Dockerfile.indexer  — Indexer service
```

Deploy via Railway dashboard or CLI:
```bash
railway up
```

Or run all services locally with Docker Compose:
```bash
docker-compose up -d
```

### Solana Programs

```bash
solana program deploy target/deploy/percolator.so \
  --program-id <PROGRAM_KEYPAIR> \
  --url devnet
```

---

## Contributing

1. Fork the repo
2. Create a feature branch (`feat/your-feature` or `fix/the-bug`)
3. Make changes — CI runs type check, lint, unit + integration tests on every PR
4. Open a PR against `main`

**No direct pushes to `main`.** PRs require passing CI.

### Code Style

- TypeScript strict mode throughout
- Shared utilities go in `@percolator/shared` — don't duplicate in individual packages
- Use `createLogger` from `@percolator/shared` for all logging (structured JSON)
- Environment config via `@percolator/shared/config` — never hardcode keys

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS, GSAP |
| **Backend API** | Hono (TypeScript), Railway |
| **Backend Workers** | TypeScript + Node.js, Railway |
| **Database** | Supabase (PostgreSQL) |
| **Blockchain** | Solana (BPFLoaderUpgradeable, SPL Token) |
| **Oracle** | Helius Geyser WebSocket, Jupiter Price API, DexScreener |
| **Wallet** | Solana Wallet Adapter (Phantom, Solflare, Backpack) |
| **CI/CD** | GitHub Actions, Vercel, Railway |
| **Error tracking** | Sentry (frontend + all backend services) |
| **Testing** | Vitest (unit), devnet integration tests (tsx) |

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Full system architecture — services, data flow, database schema |
| [`docs/BACKEND-ARCHITECTURE.md`](./docs/BACKEND-ARCHITECTURE.md) | Backend service breakdown |
| [`docs/INSURANCE-LP-SPEC.md`](./docs/INSURANCE-LP-SPEC.md) | Insurance LP token spec |
| [`docs/MAINNET-READINESS.md`](./docs/MAINNET-READINESS.md) | Mainnet deployment checklist |
| [`docs/MAINNET-ROADMAP.md`](./docs/MAINNET-ROADMAP.md) | Roadmap to mainnet |
| [`packages/api/README.md`](./packages/api/README.md) | API service — endpoints, middleware, config |
| [`packages/keeper/README.md`](./packages/keeper/README.md) | Keeper service — crank, oracle, liquidation |
| [`packages/indexer/README.md`](./packages/indexer/README.md) | Indexer service — stats, webhooks, discovery |

---

## Acknowledgements

- [Anatoly Yakovenko](https://github.com/aeyakovenko) — Percolator protocol design and risk engine
- [Helius](https://helius.dev) — RPC, Geyser WebSocket, webhooks

---

## License

MIT
