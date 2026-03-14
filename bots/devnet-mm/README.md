# PERC-377/354: Devnet Market-Making Bots

Production-ready market-making bot service for Percolator devnet. Inspired by [Drift Protocol's keeper-bots-v2](https://github.com/drift-labs/keeper-bots-v2), adapted for Percolator's LP-based matching model.

## PERC-354: 5-Wallet Fleet (BTC-PERP + SOL-PERP)

For a devnet that _looks alive_ to evaluators, we run 5 independent bot wallets:

| Wallet | Role | Markets | SOL needed | USDC needed |
|--------|------|---------|-----------|------------|
| **filler** | Crank + oracle push | All | ~0.5 | No |
| **maker** | Two-sided quotes | BTC-PERP, SOL-PERP | ~0.5 | 10,000 |
| **trader1** | Simulated aggressive trader | BTC-PERP, SOL-PERP | ~0.5 | 10,000 |
| **trader2** | Simulated passive trader | BTC-PERP, SOL-PERP | ~0.5 | 10,000 |
| **trader3** | Simulated trend-follower | SOL-PERP | ~0.5 | 10,000 |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│               Devnet MM Bot Service (BOT_MODE=all)        │
│                                                           │
│  ┌────────────────┐  ┌──────────────────┐               │
│  │  FILLER BOT    │  │    MAKER BOT     │               │
│  │ • Crank markets│  │ • Bid/ask quotes │               │
│  │ • Push oracle  │  │ • Position skew  │               │
│  │ • System health│  │ • BTC-PERP+SOL   │               │
│  │ Wallet: filler │  │ Wallet: maker    │               │
│  └────────────────┘  └──────────────────┘               │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │              TRADER FLEET (3 wallets)             │   │
│  │  trader1: aggressive — random long/short          │   │
│  │  trader2: passive   — mean-revert                 │   │
│  │  trader3: trend     — follows momentum            │   │
│  │  Each quotes BTC-PERP + SOL-PERP every 30-180s   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Health / Metrics Server                  │   │
│  │   GET /health  — bot status (JSON)                │   │
│  │   GET /metrics — Prometheus exposition            │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## Quick Start (Full Fleet)

### 1. Generate 5 wallet keypairs

```bash
npx tsx src/keygen.ts
# Creates /tmp/percolator-bots/{filler,maker,trader1,trader2,trader3}.json
# Auto-airdrops devnet SOL (may be rate-limited — retry if needed)
```

### 2. Mint test USDC to bot wallets

```bash
# Requires MINT_AUTHORITY_KEYPAIR_JSON or ~/.config/solana/percolator-devnet-mint-authority.json
npx tsx src/fund-devnet-bots.ts
# Mints 10,000 USDC to: maker, trader1, trader2, trader3
```

Or in one step:
```bash
pnpm setup   # keygen + fund
```

### 3. Run full fleet

```bash
FILLER_KEYPAIR_JSON="$(cat /tmp/percolator-bots/filler.json)" \
MAKER_KEYPAIR_JSON="$(cat /tmp/percolator-bots/maker.json)" \
TRADER_KEYPAIR_JSON_0="$(cat /tmp/percolator-bots/trader1.json)" \
TRADER_KEYPAIR_JSON_1="$(cat /tmp/percolator-bots/trader2.json)" \
TRADER_KEYPAIR_JSON_2="$(cat /tmp/percolator-bots/trader3.json)" \
TEST_USDC_MINT=DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs \
HELIUS_API_KEY=your-key \
BOT_MODE=all \
npx tsx src/index.ts
```

### 4. Run filler + maker only (no simulated traders)

```bash
FILLER_KEYPAIR=/tmp/percolator-bots/filler.json \
MAKER_KEYPAIR=/tmp/percolator-bots/maker.json \
HELIUS_API_KEY=your-key \
BOT_MODE=both \
npx tsx src/index.ts
```

### 5. Dry run (no transactions)

```bash
DRY_RUN=true npx tsx src/index.ts
```

## Railway Deployment (PERC-354)

Add these env vars to the `devnet-mm-bots` Railway service:

```
FILLER_KEYPAIR_JSON  = <contents of filler.json>
MAKER_KEYPAIR_JSON   = <contents of maker.json>
TRADER_KEYPAIR_JSON_0 = <contents of trader1.json>
TRADER_KEYPAIR_JSON_1 = <contents of trader2.json>
TRADER_KEYPAIR_JSON_2 = <contents of trader3.json>
TEST_USDC_MINT       = DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs
BOT_MODE             = all
HELIUS_API_KEY       = <your-helius-api-key>
MARKETS_FILTER       = SOL,BTC
```

> ⚠️ **Do NOT add `MINT_AUTHORITY_KEYPAIR_JSON` to the Railway service.** It is only needed for the one-off `npx tsx src/fund-devnet-bots.ts` funding script run locally. Exposing it in a long-running service unnecessarily widens blast radius.

Run `npx tsx src/keygen.ts` to print the `RAILWAY ENV VARS` block with all JSON values ready to paste.

## Bot Roles

### Filler Bot

The filler ensures system health and liveness:

| Function | Description |
|----------|-------------|
| **Cranking** | Calls `KeeperCrank` on all markets at regular intervals to process funding rates, liquidations, and settlement |
| **Oracle Push** | For Hyperp-mode markets (admin oracle), fetches prices from Binance/CoinGecko and pushes on-chain |
| **Auto-Discovery** | Discovers new markets every 5 minutes and adds them to the crank rotation |
| **Batch Processing** | Processes markets in configurable batches to avoid RPC rate limits |
| **Failure Tracking** | Tracks consecutive failures per market and auto-skips permanently broken markets |

### Maker Bot

The maker creates the appearance of an active, liquid market:

| Function | Description |
|----------|-------------|
| **Two-Sided Quotes** | Posts bid + ask around oracle price with configurable spread |
| **Position Skewing** | Widens spread on the side that would increase exposure |
| **Size Jitter** | Randomizes quote sizes ±25% for organic appearance |
| **Spread Noise** | Adds random ±4bps noise to spread each cycle |
| **Multi-Source Pricing** | Fetches from Binance (primary) → CoinGecko (fallback) with 2s cache |
| **Max Position Limits** | Stops quoting on the risky side at 95% exposure |
| **Auto Collateral** | Deposits initial collateral on first setup |

## Configuration

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_MODE` | `both` | `filler`, `maker`, or `both` |
| `RPC_URL` | Helius devnet | Solana RPC endpoint |
| `HELIUS_API_KEY` | — | Helius API key (auto-constructs devnet URL) |
| `PROGRAM_ID` | Small tier | Percolator program ID |
| `MATCHER_PROGRAM_ID` | GTR... | Matcher program ID |
| `DRY_RUN` | `false` | Simulate without sending transactions |
| `HEALTH_PORT` | `18820` | Health/metrics HTTP port |

### Wallets

| Variable | Default | Description |
|----------|---------|-------------|
| `FILLER_KEYPAIR` | `/tmp/percolator-bots/filler.json` | Filler wallet keypair |
| `MAKER_KEYPAIR` | `/tmp/percolator-bots/maker.json` | Maker wallet keypair |
| `BOOTSTRAP_KEYPAIR` | — | Shared wallet fallback (if individual not set) |

### Filler

| Variable | Default | Description |
|----------|---------|-------------|
| `CRANK_INTERVAL_MS` | `5000` | Crank frequency |
| `MAX_CRANK_STALENESS` | `200` | Max stale slots before alert |
| `CRANK_BATCH_SIZE` | `3` | Markets per batch |
| `PUSH_ORACLE` | `true` | Push prices for Hyperp markets |

### Maker

| Variable | Default | Description |
|----------|---------|-------------|
| `SPREAD_BPS` | `25` | Half-spread in basis points |
| `MAX_QUOTE_SIZE_USDC` | `500` | Max quote size per side ($) |
| `MAX_POSITION_PCT` | `10` | Max position as % of collateral |
| `QUOTE_INTERVAL_MS` | `5000` | Re-quote frequency |
| `INITIAL_COLLATERAL` | `10000000000` | Collateral to deposit (6 decimals = $10k) |
| `SKEW_MAX_MULTIPLIER` | `3.0` | Spread multiplier at max exposure |
| `SPREAD_NOISE_BPS` | `4` | Random spread noise |
| `SIZE_JITTER` | `0.25` | Size randomization factor |
| `MARKETS_FILTER` | all | Comma-separated symbols (e.g. `SOL,BTC`) |

## Monitoring

### Health Check

```bash
curl http://localhost:18820/health | jq .
```

```json
{
  "status": "ok",
  "filler": {
    "role": "filler",
    "running": true,
    "markets": 2,
    "stats": { "crankCycles": 120, "crankSuccess": 238, "uptimeS": 600 }
  },
  "maker": {
    "role": "maker",
    "running": true,
    "markets": 2,
    "stats": { "quoteCycles": 60, "tradesExecuted": 118, "uptimeS": 600 }
  }
}
```

### Prometheus Metrics

```bash
curl http://localhost:18820/metrics
```

## Deployment

### Docker

```bash
docker build -t percolator-mm -f bots/devnet-mm/Dockerfile .
docker run -d \
  -e BOOTSTRAP_KEYPAIR=/keys/bot.json \
  -e HELIUS_API_KEY=xxx \
  -v /path/to/keys:/keys \
  -p 18820:18820 \
  percolator-mm
```

### Railway

```bash
# Set env vars in Railway dashboard, then deploy from repo root
railway up --service mm-bots
```

### systemd

```ini
[Unit]
Description=Percolator Devnet MM Bots
After=network.target

[Service]
Type=simple
User=percolator
WorkingDirectory=/opt/percolator-launch/bots/devnet-mm
ExecStart=/usr/bin/npx tsx src/index.ts
Environment=BOOTSTRAP_KEYPAIR=/etc/percolator/bot-wallet.json
Environment=HELIUS_API_KEY=xxx
Environment=BOT_MODE=both
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## How It Works (Percolator vs Drift)

| Concept | Drift keeper-bots-v2 | Percolator devnet-mm |
|---------|---------------------|---------------------|
| Order matching | Filler matches taker orders against DLOB | vAMM matcher handles matching via CPI |
| Market making | FloatingMaker posts limit orders | Maker trades against LP via TradeCpi |
| Cranking | Keeper cranks funding/settlement | Filler cranks funding/liquidation |
| Oracle | Pulls from Pyth/Switchboard | Pushes prices for Hyperp mode, or Pyth |
| Position model | Spot + perp positions | Slab-based user/LP accounts |
| Discovery | DriftClient.subscribe() | getProgramAccounts + magic byte filter |

## Related Scripts

- `scripts/floating-maker.ts` — Original single-wallet maker (PERC-364)
- `scripts/mm-fleet.ts` — Multi-wallet fleet orchestrator (PERC-366)
- `scripts/deploy-devnet-mm.ts` — Market creation + deployment (PERC-370)
- `scripts/keeper-bot.ts` — Simple keeper/quoter (PERC-370)
