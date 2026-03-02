# PERC-355: Market Bootstrap Service

## Overview

The market bootstrap service automatically detects new Percolator markets on devnet and brings them to life within ~2 minutes. It handles:

1. **Market Discovery** — Polls for new markets every 30 seconds
2. **LP Seeding** — Deposits initial liquidity into the market LP vault
3. **Insurance Seeding** — Tops up the market's insurance fund
4. **Oracle Price Push** — Fetches real prices from Binance/CoinGecko/DexScreener/Jupiter and pushes to admin oracle every 10 seconds
5. **Seed Trades** — Places 3 initial trades (BUY → SELL → BUY) to generate price history on the chart
6. **Market Maker Bot** — Continuously places small long/short orders every 60-75 seconds using rotating bot wallets

## Architecture

```
┌──────────────────────────────────────────────┐
│          Market Bootstrap Service             │
├──────────────────────────────────────────────┤
│  Discovery Loop (30s)                         │
│    └─ discoverMarkets() via @percolator/sdk   │
│    └─ For each new market:                    │
│         1. Seed LP (InitLP + DepositCollat)   │
│         2. Setup bot accounts (InitUser × N)  │
│         3. Push oracle price                  │
│         4. Crank market                       │
│         5. Place 3 seed trades                │
│                                               │
│  Oracle Pusher (10s)                          │
│    └─ Binance → CoinGecko → DexScreener      │
│    └─ PushOraclePrice instruction             │
│                                               │
│  Market Maker (60s long / 75s short)          │
│    └─ Rotate through 3-5 bot wallets          │
│    └─ TradeNoCpi (buy/sell alternating)       │
│    └─ Auto-handles position limits            │
└──────────────────────────────────────────────┘
```

## Bot Wallets

The service uses 3-5 pre-funded devnet wallets that rotate through trades. Each bot needs:
- **SOL** for transaction fees (~0.01 SOL per trade)
- **Collateral tokens** for each market they trade on

Wallet public keys are printed at startup for documentation.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RPC_URL` | ✓ | devnet | Solana RPC endpoint |
| `PROGRAM_ID` | ✓ | — | Primary Percolator program ID |
| `ALL_PROGRAM_IDS` | — | PROGRAM_ID | Comma-separated program IDs to scan |
| `ADMIN_KEYPAIR` | ✓ | — | Admin keypair (JSON array) |
| `BOT_KEYPAIRS` | — | admin | Comma-separated bot keypairs |
| `BOOTSTRAP_LP_AMOUNT` | — | 50000000 | LP seed (token lamports) |
| `BOOTSTRAP_INSURANCE` | — | 10000000 | Insurance seed (token lamports) |
| `BOOTSTRAP_TRADE_SIZE` | — | 1000000 | Seed trade size |
| `MM_TRADE_SIZE` | — | 500000 | Market maker trade size |
| `MM_LONG_INTERVAL_MS` | — | 60000 | MM long interval (ms) |
| `MM_SHORT_INTERVAL_MS` | — | 75000 | MM short interval (ms) |
| `ORACLE_PUSH_INTERVAL` | — | 10000 | Oracle push interval (ms) |
| `DISCOVERY_INTERVAL` | — | 30000 | Discovery scan interval (ms) |

## Usage

```bash
# One-shot bootstrap (run once, exit)
npx tsx scripts/market-bootstrap.ts --once

# Dry run (no transactions)
npx tsx scripts/market-bootstrap.ts --dry-run

# Continuous mode (discovery + oracle + market maker)
npx tsx scripts/market-bootstrap.ts

# With custom configuration
BOOTSTRAP_LP_AMOUNT=100000000 MM_TRADE_SIZE=250000 \
  npx tsx scripts/market-bootstrap.ts
```

## Price Sources

The oracle price pusher fetches prices with multi-source fallback:

1. **Binance** — lowest latency, used when token has a Binance pair
2. **CoinGecko** — free tier, good coverage
3. **DexScreener** — on-chain DEX aggregator, works for any Solana token
4. **Jupiter** — Solana-native price API

All sources have 5-8 second timeouts. DexScreener and Jupiter are queried in parallel for speed.

## Safety

- Bot private keys are **never hardcoded** — always read from env vars
- Position limits are handled gracefully (trade errors logged, retried next cycle)
- Oracle prices are cross-validated when multiple sources return data
- The service only runs on **devnet** — there is no mainnet bootstrap mode
- `--dry-run` mode prints what would happen without sending any transactions
