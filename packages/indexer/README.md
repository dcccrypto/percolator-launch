# @percolator/indexer

Background indexing service for Percolator. Reads on-chain data and writes to Supabase. No public API — only `/health` and `/webhook/trades` endpoints.

**Deployed on:** Railway | **Port:** 3002

---

## Overview

The indexer runs five background services:

| Service | What it does |
|---------|-------------|
| `MarketDiscovery` | Scans on-chain programs for new markets, registers them in Supabase |
| `StatsCollector` | Reads all slab accounts every 30s → writes stats, OI, funding history |
| `TradeIndexer` | Indexes trades from on-chain transactions (webhook-primary, polling-backup) |
| `InsuranceLPService` | Tracks insurance vault balances and LP token supply |
| `HeliusWebhookManager` | Registers Helius webhooks, validates and routes incoming trade events |

---

## Quick Start

```bash
# Development
pnpm --filter=@percolator/indexer dev

# Production build
pnpm --filter=@percolator/indexer build
pnpm --filter=@percolator/indexer start
```

---

## Environment Variables

All shared config comes from `@percolator/shared` via the root `.env`. Copy `.env.example` from the repo root.

| Variable | Default | Description |
|----------|---------|-------------|
| `INDEXER_PORT` | `3002` | HTTP server port |
| `RPC_URL` | Helius devnet | Solana RPC endpoint (include API key) |
| `HELIUS_API_KEY` | — | Helius API key |
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_KEY` | — | Supabase service role key |
| `ALL_PROGRAM_IDS` | devnet 3 tiers | Comma-separated program IDs to monitor |
| `INDEXER_API_KEY` | — | Auth key for internal webhook endpoint |
| `WEBHOOK_URL` | — | Public URL of this service (for Helius webhook registration) |
| `HELIUS_WEBHOOK_SECRET` | — | Secret to validate incoming Helius payloads |
| `DISCOVERY_INTERVAL_MS` | `300000` | Market discovery polling interval (5 min) |
| `SENTRY_DSN` | — | Sentry DSN for error tracking |

---

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health — DB and RPC connectivity |
| POST | `/webhook/trades` | Helius webhook receiver — validates and processes trade events |

The webhook endpoint validates the `HELIUS_WEBHOOK_SECRET` before processing.

---

## Services in Detail

### MarketDiscovery

- Calls `getProgramAccounts` across all `ALL_PROGRAM_IDS` on startup and every `DISCOVERY_INTERVAL_MS`
- Parses slab binary data to extract market config (mint, symbol, deployer, oracle type)
- Fetches token metadata from Metaplex on-chain data + Jupiter API fallback
- Upserts into Supabase `markets` table
- Implements `MarketProvider` interface — other services call `getMarkets()` instead of querying the chain directly

### StatsCollector

- Polls all known markets every 30s
- For each market: fetches slab account, parses engine state, config, and params
- Writes/upserts:
  - `market_stats` — total OI, funding rate, last price, volume
  - `oi_history` — OI snapshots with timestamps
  - `funding_history` — funding rate snapshots
  - `oracle_prices` — oracle price updates

### TradeIndexer

Two modes:

1. **Webhook (primary)** — `HeliusWebhookManager` registers enhanced webhooks with Helius. Incoming webhook payloads are validated and parsed immediately.
2. **Polling (backup)** — Falls back to polling recent transactions for each market every 5 minutes. Also used for backfilling historical trades.

Parses both `TradeCpi` (tag 10, vAMM trades) and `TradeNoCpi` (tag 6, direct trades) from instruction data. Deduplicates by transaction signature.

Writes to Supabase `trades` table: slab address, side (long/short), price, size, trader, timestamp, signature.

### InsuranceLPService

- Monitors insurance vault token accounts for all markets
- Tracks LP token mint supply
- Computes APY metrics from fee revenue
- Writes to `insurance_history` table

### HeliusWebhookManager

- On startup: checks if webhooks are already registered, creates/updates as needed
- Requires `WEBHOOK_URL` to be set (public URL of the indexer service)
- Routes incoming webhook payloads to `TradeIndexer` for processing
- Handles webhook re-registration if endpoint URL changes

---

## Architecture Notes

- **No dependency on Keeper** — uses its own `MarketDiscovery` instead of relying on the keeper's market list
- **Shared utilities** — all DB queries, config, and RPC from `@percolator/shared`
- **Graceful shutdown** — handles SIGTERM/SIGINT

---

## Testing

```bash
pnpm --filter=@percolator/indexer test
pnpm --filter=@percolator/indexer test:coverage
```

---

## Deployment

```bash
docker build -f Dockerfile.indexer -t percolator-indexer .
docker run -p 3002:3002 --env-file .env percolator-indexer
```

### Production Checklist

- [ ] `SUPABASE_KEY` is the **service role** key (needs write access)
- [ ] `WEBHOOK_URL` set to public Railway URL (e.g. `https://percolator-indexer.railway.app`)
- [ ] `HELIUS_WEBHOOK_SECRET` set and matches Helius dashboard
- [ ] Railway health check pointed at `/health`
- [ ] `SENTRY_DSN` set for error tracking
