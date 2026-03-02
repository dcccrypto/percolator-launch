# PERC-366: Market Maker Fleet

Multi-profile oracle-anchored market making for Percolator devnet. Runs **3 independent market maker instances per market** to create realistic-looking orderbook depth.

## Why a Fleet?

A single market maker creates one bid and one ask. Real orderbooks have depth — multiple price levels with varying sizes. The fleet runs 3 profiles per market:

| Profile | Spread | Size | Re-quote | Role |
|---------|--------|------|----------|------|
| **WIDE** | 60 bps | $2,000/side | 8s | "Bedrock" liquidity — wide spread, large size, backstop |
| **TIGHT_A** | 15 bps | $300/side | 3s | Top-of-book action — tight spread, fast updates |
| **TIGHT_B** | 20 bps | $250/side | 4s | Second aggressive layer — slight oracle offset for staggering |

This creates 6 distinct price levels per market (3 bids + 3 asks) with $2,550 depth per side.

## Quick Start

### Option A: Single wallet (subaccount isolation)

```bash
# Generate a fleet wallet
solana-keygen new -o /tmp/fleet-wallet.json --no-bip39-passphrase

# Fund it
solana airdrop 5 $(solana-keygen pubkey /tmp/fleet-wallet.json) --url devnet

# Run the fleet
BOOTSTRAP_KEYPAIR=/tmp/fleet-wallet.json \
HELIUS_API_KEY=your-key \
npx tsx scripts/mm-fleet.ts
```

### Option B: 3 independent keeper wallets (PERC-368, recommended)

```bash
# Generate 3 keeper wallets + airdrop devnet SOL
pnpm fleet:keygen

# Run with independent wallets
KEEPER_WALLETS_DIR=/tmp/percolator-keepers \
HELIUS_API_KEY=your-key \
pnpm fleet
```

Each profile signs with its own keypair, creating 3 independent on-chain identities.
This looks more realistic on-chain (3 different authorities in the orderbook) and
avoids single-wallet rate limiting.

```bash
# Or use the npm scripts
pnpm fleet           # run fleet
pnpm fleet:dry       # dry run (no transactions)
pnpm fleet:keygen    # generate wallets + airdrop
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   MM Fleet Orchestrator                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │            Shared Price Cache (2s TTL)            │   │
│  │            Binance → CoinGecko fallback           │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │            TX Queue (rate-limited, 200ms gap)     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ SOL / WIDE  │ │ SOL / TIGHT │ │ SOL / TIGHT │       │
│  │  60bps      │ │ _A  15bps   │ │ _B  20bps   │       │
│  │  $2k/side   │ │ $300/side   │ │ $250/side   │       │
│  │  8s cycle   │ │ 3s cycle    │ │ 4s cycle    │       │
│  │  own subacct│ │ own subacct │ │ own subacct │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│                                                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ BTC / WIDE  │ │ BTC / TIGHT │ │ BTC / TIGHT │       │
│  │  ...        │ │ _A  ...     │ │ _B  ...     │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
└─────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Single process** — all instances run in one Node.js process. Simpler ops, shared price cache, rate-limited TX queue avoids 429s.

2. **Subaccount isolation** — each profile gets its own LP + User account on each market. Positions don't bleed across profiles.

3. **Staggered timing** — each instance has random jitter on its quote interval so they don't all fire simultaneously.

4. **Shared oracle pushes** — for Hyperp-mode markets, oracle price is only pushed once per market per cycle (not 3x).

5. **Price cache** — 2-second TTL shared across all instances. One Binance call serves all 3 profiles.

## Environment Variables

### Core
| Variable | Default | Description |
|----------|---------|-------------|
| `BOOTSTRAP_KEYPAIR` | `/tmp/bootstrap-wallet.json` | Fallback wallet keypair (used when no per-profile wallet set) |
| `RPC_URL` | Helius devnet | Solana RPC endpoint |
| `HELIUS_API_KEY` | — | Helius API key |
| `DRY_RUN` | `false` | Simulate without transactions |
| `MARKETS_FILTER` | all | Comma-separated market symbols |
| `FLEET_PROFILES` | all 3 | Comma-separated profiles to run |
| `PROMETHEUS_PORT` | off | Enable Prometheus `/metrics` endpoint |

### Per-Profile Keeper Wallets (PERC-368)
| Variable | Description |
|----------|-------------|
| `KEEPER_WALLETS_DIR` | Directory containing `keeper-wide.json`, `keeper-tight_a.json`, `keeper-tight_b.json` |
| `KEEPER_WALLET_WIDE` | Path to WIDE profile keypair JSON |
| `KEEPER_WALLET_TIGHT_A` | Path to TIGHT_A profile keypair JSON |
| `KEEPER_WALLET_TIGHT_B` | Path to TIGHT_B profile keypair JSON |

### Profile Overrides
Override any profile parameter via environment variables with the pattern `MM_<PROFILE>_<PARAM>`:

```bash
# Make WIDE even wider
MM_WIDE_SPREAD_BPS=80

# Give TIGHT_A more firepower
MM_TIGHT_A_MAX_QUOTE_SIZE_USDC=500
MM_TIGHT_A_MAX_POSITION_PCT=12

# Speed up TIGHT_B
MM_TIGHT_B_QUOTE_INTERVAL_MS=2000
```

## Monitoring

### Dashboard (stdout)
Every 60 seconds, the fleet prints a combined dashboard:

```
════════════════════════════════════════════════════════════════════════
  MM Fleet Dashboard | Uptime: 5m30s | Trades: 180/200 ok | 6 instances
────────────────────────────────────────────────────────────────────────
  Market    Profile   Oracle      Bid         Ask         Pos       Skew
────────────────────────────────────────────────────────────────────────
  SOL       WIDE      $  150.25   $  149.35   $  151.15   $   250    2.5%
  SOL       TIGHT_A   $  150.25   $  150.03   $  150.48   $   -50   -0.5%
  SOL       TIGHT_B   $  150.25   $  149.95   $  150.55   $   120    1.2%
  BTC       WIDE      $97345.00   $96761.93   $97928.07   $     0    0.0%
  BTC       TIGHT_A   $97345.00   $97199.48   $97490.52   $  -200   -2.0%
  BTC       TIGHT_B   $97345.00   $97150.31   $97541.64   $   100    1.0%
════════════════════════════════════════════════════════════════════════
```

### Prometheus Metrics
When `PROMETHEUS_PORT` is set, exposes:

- `mm_fleet_quote_cycles` — total cycles per instance
- `mm_fleet_trades_total{result}` — trades succeeded/failed
- `mm_fleet_position_usd` — current position per instance
- `mm_fleet_last_cycle_ms` — cycle latency
- `mm_fleet_skew_pct` — current skew

### Health Check
```bash
curl http://localhost:9464/metrics
```

## Comparison: Single Maker vs Fleet

| Feature | PERC-364 (Single) | PERC-366 (Fleet) |
|---------|-------------------|------------------|
| Instances | 1 per market | 3 per market |
| Price levels | 2 (1 bid + 1 ask) | 6 (3 bids + 3 asks) |
| Depth per side | $500 | $2,550 |
| Spread range | 30bps | 15–60bps |
| Quote timing | Synchronized | Staggered with jitter |
| Position isolation | None | Per-profile subaccounts |
| TX rate limiting | None | Queue with 200ms gap |
| Price caching | None | 2s shared cache |
| Prometheus | None | Optional `/metrics` |
| Size variation | Fixed | Random jitter ±30% |
| Spread variation | Fixed | Random noise ±5bps |
| Re-discovery | Every 50s | Every 5min |

## Operational Guide

### Running in Production (systemd)

```ini
[Unit]
Description=Percolator MM Fleet
After=network.target

[Service]
Type=simple
User=percolator
WorkingDirectory=/opt/percolator-launch
ExecStart=/usr/bin/npx tsx scripts/mm-fleet.ts
Environment=BOOTSTRAP_KEYPAIR=/etc/percolator/fleet-wallet.json
Environment=HELIUS_API_KEY=xxx
Environment=PROMETHEUS_PORT=9464
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Running with Docker

```bash
docker run -d \
  -e BOOTSTRAP_KEYPAIR=/keys/fleet.json \
  -e HELIUS_API_KEY=xxx \
  -v /path/to/fleet.json:/keys/fleet.json \
  percolator-launch:latest \
  npx tsx scripts/mm-fleet.ts
```

### Running Only Specific Profiles

```bash
# Only run the WIDE profile (for minimal devnet activity)
FLEET_PROFILES=WIDE BOOTSTRAP_KEYPAIR=/tmp/fleet.json npx tsx scripts/mm-fleet.ts

# Only tight profiles (for top-of-book action)
FLEET_PROFILES=TIGHT_A,TIGHT_B npx tsx scripts/mm-fleet.ts
```

## Development

```bash
# Run tests
pnpm test tests/mm-fleet.test.ts

# Dry run
pnpm fleet:dry

# Specific market
MARKETS_FILTER=SOL pnpm fleet:dry
```
