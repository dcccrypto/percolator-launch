# @percolator/keeper

Keeper service for the Percolator protocol — cranking, oracle price pushing, and liquidations. Runs 24/7 with a Solana keypair. No public HTTP API.

**Deployed on:** Railway | **Devnet stats:** 51 markets, 14,500+ cranks, zero failures

---

## Overview

Three services run concurrently:

| Service | Interval | What it does |
|---------|----------|-------------|
| `CrankService` | Configurable (active/inactive) | Discovers all markets, batches crank transactions |
| `OracleService` | Every crank cycle | Pushes prices for admin-oracle markets |
| `LiquidationService` | Configurable | Scans for undercollateralized positions, executes liquidations |

---

## Quick Start

```bash
# Development
pnpm --filter=@percolator/keeper dev

# Production build
pnpm --filter=@percolator/keeper build
pnpm --filter=@percolator/keeper start
```

`CRANK_KEYPAIR` must be set or the service exits immediately.

---

## Environment Variables

All shared config comes from `@percolator/shared` via the root `.env`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CRANK_KEYPAIR` | **Yes** | — | Base58 private key (or JSON array) for the keeper wallet |
| `RPC_URL` | Yes | Helius devnet | Solana RPC endpoint |
| `HELIUS_API_KEY` | Yes | — | Helius API key for transaction submission |
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_KEY` | Yes | — | Supabase service role key |
| `ALL_PROGRAM_IDS` | No | devnet 3 tiers | Comma-separated program IDs to monitor |
| `CRANK_INTERVAL_MS` | No | `30000` | Crank interval for active markets |
| `CRANK_INACTIVE_INTERVAL_MS` | No | `60000` | Crank interval for inactive markets |
| `DISCOVERY_INTERVAL_MS` | No | `300000` | How often to scan for new markets (5 min) |
| `KEEPER_HEALTH_PORT` | No | `8081` | Health endpoint port |
| `SENTRY_DSN` | No | — | Sentry DSN for error tracking |

---

## Structure

```
packages/keeper/src/
├── index.ts              # Entry point — orchestrates services, health HTTP server
└── services/
    ├── crank.ts          # CrankService — market discovery + cranking
    ├── oracle.ts         # OracleService — price fetching + on-chain push
    └── liquidation.ts    # LiquidationService — scan + execute liquidations
```

---

## Services in Detail

### CrankService

- On startup: calls `getProgramAccounts` across all configured program IDs to discover all markets
- Maintains two sets of markets: **active** (recently traded) and **inactive**
- Active markets cranked at `CRANK_INTERVAL_MS`, inactive at `CRANK_INACTIVE_INTERVAL_MS`
- Batches multiple markets per transaction where possible to minimize fees
- Tracks per-market state: last crank time, slot, success/fail counts, consecutive misses
- Removes markets after 3 consecutive discovery misses (market closed or migrated)
- Re-runs discovery every `DISCOVERY_INTERVAL_MS` to pick up new markets

### OracleService

- Fetches prices from DexScreener API; falls back to Jupiter aggregated price
- Cross-validates between sources — rejects pushes where sources diverge >30%
- Pushes `PushOraclePrice` instruction **only** for markets where the keeper wallet is the oracle authority
- Pyth-oracle markets are self-updating; admin-oracle markets require the keeper push

### LiquidationService

- Polls all markets on a configurable interval
- For each market: fetches all user accounts from slab, computes mark-to-market PnL against current oracle price
- For undercollateralized accounts: executes atomic sequence:
  1. `PushOraclePrice` (ensure fresh price)
  2. `KeeperCrank` (update mark price and funding)
  3. `LiquidateAtOracle` (close position at oracle price)
- Liquidation reward goes to the keeper wallet
- Uses the same oracle service for price resolution

---

## Health Endpoint

HTTP server on `KEEPER_HEALTH_PORT` (default 8081):

```
GET /health
```

Response:
```json
{
  "status": "ok",
  "marketsTracked": 51,
  "lastCrankTime": 1234567890,
  "lastOracleUpdateTime": 1234567890
}
```

Status codes: `200` ok/degraded, `503` down.

---

## Security Notes

- `CRANK_KEYPAIR` must be kept secret. Never commit it to the repo.
- The keeper wallet only needs enough SOL for transaction fees (keep topped up to avoid crank failures)
- On mainnet, the keeper wallet should be the oracle authority only for markets you control

---

## Graceful Shutdown

Handles SIGTERM and SIGINT — in-flight transactions complete before exit.

---

## Testing

```bash
pnpm --filter=@percolator/keeper test
```

---

## Deployment

```bash
docker build -f Dockerfile.keeper -t percolator-keeper .
docker run --env-file .env percolator-keeper
```

### Production Checklist

- [ ] `CRANK_KEYPAIR` set (base58 private key)
- [ ] Keeper wallet funded (min 0.5 SOL recommended)
- [ ] `RPC_URL` uses a paid Helius plan (public devnet will rate-limit at scale)
- [ ] Railway restart policy set to always-restart
- [ ] Railway health check pointed at `:8081/health`
- [ ] `SENTRY_DSN` set for error tracking
