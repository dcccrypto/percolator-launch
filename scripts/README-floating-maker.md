# PERC-364: Floating Market Maker Bot

Oracle-anchored two-sided market maker for Percolator devnet, inspired by [Drift's FloatingMaker](https://github.com/drift-labs/keeper-bots-v2/blob/master/src/bots/floatingMaker.ts).

## What It Does

The bot continuously quotes bid/ask around the real-time oracle price for each active devnet market:

1. **Discovers markets** — scans on-chain program accounts for active Percolator markets
2. **Fetches prices** — Binance → CoinGecko fallback chain for real-time oracle prices
3. **Pushes oracle** — for Hyperp-mode markets, pushes oracle prices on-chain
4. **Quotes bid/ask** — places two-sided quotes with configurable spread
5. **Skews quotes** — as position builds up, skews away from risky side
6. **Auto-discovers** — periodically checks for new markets and adds them

## Quick Start

```bash
# Generate a devnet keypair (if needed)
solana-keygen new -o /tmp/maker-wallet.json --no-bip39-passphrase

# Fund it (devnet)
solana airdrop 2 $(solana-keygen pubkey /tmp/maker-wallet.json) --url devnet

# Run the bot
BOOTSTRAP_KEYPAIR=/tmp/maker-wallet.json \
HELIUS_API_KEY=your-key \
npx tsx scripts/floating-maker.ts

# Or use pnpm script
pnpm maker
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOTSTRAP_KEYPAIR` | `/tmp/bootstrap-wallet.json` | Path to market maker keypair JSON |
| `RPC_URL` | Helius devnet | Solana RPC endpoint |
| `HELIUS_API_KEY` | — | Helius API key (used if RPC_URL not set) |
| `SPREAD_BPS` | `30` | Half-spread in basis points (30 = 0.30%) |
| `MAX_QUOTE_SIZE_USDC` | `500` | Max quote size per side in USDC |
| `MAX_POSITION_PCT` | `10` | Max position as % of collateral |
| `QUOTE_INTERVAL_MS` | `5000` | Re-quote interval in milliseconds |
| `COOLDOWN_SLOTS` | `30` | Min Solana slots between market updates |
| `DRY_RUN` | `false` | Set to `true` to simulate without transactions |
| `MARKETS_FILTER` | all | Comma-separated symbols to trade (e.g., `SOL,BTC`) |
| `INITIAL_COLLATERAL` | `10000000000` | Collateral to deposit per market (10k USDC) |
| `MATCHER_ID` | Devnet default | Matcher program ID for TradeCpi |

## How Quoting Works

### Spread Calculation
```
Base spread = SPREAD_BPS / 10000  (default 0.30%)

Bid price = oracle × (1 - spread × bid_multiplier)
Ask price = oracle × (1 + spread × ask_multiplier)
```

### Position-Aware Skewing

As the bot accumulates a directional position, it skews quotes to reduce exposure:

| Position | Bid Spread | Ask Spread | Effect |
|----------|-----------|-----------|--------|
| Flat | 1x | 1x | Normal two-sided |
| 50% long | 2x wider | 1x | Less willing to buy more |
| Max long | No bid | 1x | Only sells (reduces position) |
| 50% short | 1x | 2x wider | Less willing to sell more |
| Max short | 1x | No ask | Only buys (reduces position) |

### Size Scaling

Quote size scales down as exposure increases:
- At 0% exposure: 100% of MAX_QUOTE_SIZE
- At 50% exposure: ~60% of MAX_QUOTE_SIZE
- At 95%+ exposure: only quote on reducing side

## Architecture

```
┌───────────────────────────────────────────┐
│           Floating Maker Bot              │
├───────────────────────────────────────────┤
│  Price Feeds                              │
│  ├─ Binance (primary, <4s timeout)        │
│  └─ CoinGecko (fallback, <5s timeout)     │
├───────────────────────────────────────────┤
│  Market Discovery                         │
│  ├─ On-chain scan via discoverMarkets()   │
│  ├─ Auto-creates LP + User accounts       │
│  └─ Re-discovers every 10 cycles          │
├───────────────────────────────────────────┤
│  Quote Engine                             │
│  ├─ Oracle-anchored pricing               │
│  ├─ Position-aware skewing                │
│  └─ Configurable spread/size              │
├───────────────────────────────────────────┤
│  Trade Execution                          │
│  ├─ KeeperCrank → TradeCpi pipeline       │
│  ├─ PushOraclePrice for Hyperp markets    │
│  └─ 600k CU budget per trade              │
└───────────────────────────────────────────┘
```

## Risk Management

- **Position cap**: Stops making on one side when position exceeds `MAX_POSITION_PCT` of collateral
- **Size scaling**: Reduces quote size linearly with exposure
- **Spread skewing**: Widens spread on risky side (up to 3x at max exposure)
- **Per-trade cap**: Each quote capped at `MAX_QUOTE_SIZE_USDC`
- **Oracle validation**: Skips quoting if no price source is available

## Monitoring

The bot prints stats every 60 seconds:

```
[13:37:42] [stats] ═══════════════════════════════════════
[13:37:42] [stats] Uptime: 5m 30s | Cycles: 66 | Trades: 120/132 ok
[13:37:42] [stats]   SOL: pos=$250.00 | col=$10000 | exp=25.0%
[13:37:42] [stats]   BTC: pos=$-100.00 | col=$10000 | exp=10.0%
[13:37:42] [stats] ═══════════════════════════════════════
```

## Comparison to Drift FloatingMaker

| Feature | Drift FloatingMaker | Percolator Maker |
|---------|-------------------|-----------------|
| Oracle source | Pyth on-chain | Binance → CoinGecko |
| Order type | Limit w/ oraclePriceOffset | Market via TradeCpi |
| Re-quote interval | 5s | 5s (configurable) |
| Position limit | 10% of collateral | 10% (configurable) |
| Skewing | Basic inventory skew | Linear skew w/ spread multiplication |
| Markets | Config-driven | Auto-discovered from on-chain |
| Account setup | Manual | Automatic LP + User creation |

## Development

```bash
# Run in dry-run mode to test logic without transactions
DRY_RUN=true BOOTSTRAP_KEYPAIR=/tmp/maker-wallet.json npx tsx scripts/floating-maker.ts

# Run with specific markets only
MARKETS_FILTER=SOL,BTC BOOTSTRAP_KEYPAIR=/tmp/maker-wallet.json npx tsx scripts/floating-maker.ts

# Wide spread for volatile markets
SPREAD_BPS=50 BOOTSTRAP_KEYPAIR=/tmp/maker-wallet.json npx tsx scripts/floating-maker.ts
```
