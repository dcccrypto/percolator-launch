# Market Bootstrap Service (PERC-355)

Automatically bootstraps new devnet markets with liquidity, trades, and oracle prices.

## Quick Start

```bash
# Set required environment variables
export HELIUS_API_KEY="your-helius-key"
export NEXT_PUBLIC_SUPABASE_URL="https://xxx.supabase.co"
export SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIs..."
export BOOTSTRAP_KEYPAIR="/path/to/bootstrap-wallet.json"

# Optional: additional market maker wallets
export MM_WALLETS="/path/to/mm1.json,/path/to/mm2.json,/path/to/mm3.json"

# Run
npx tsx scripts/market-bootstrap.ts
```

## Components

1. **Market Watcher** — Polls Supabase every 30s for new unbootstrapped markets
2. **Auto-LP Seed** — Deposits 50 USDC + 10 USDC insurance from protocol wallet
3. **Oracle Price Pusher** — Feeds CoinGecko prices every 10s for admin-oracle markets
4. **Seed Trades** — Places 3 initial trades (buy/sell/buy) to populate chart
5. **Market Maker** — Ongoing small trades every 60-75s with rotating wallets

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOOTSTRAP_KEYPAIR` | Yes | `/tmp/bootstrap-wallet.json` | Protocol wallet keypair path |
| `HELIUS_API_KEY` | Yes | — | Helius RPC API key |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | — | Supabase URL |
| `SUPABASE_SERVICE_KEY` | Yes | — | Supabase service role key |
| `MM_WALLETS` | No | — | Comma-separated paths to MM wallet keypairs |
| `LP_SEED_AMOUNT` | No | `50000000` | LP seed in micro-units (50 USDC) |
| `INSURANCE_SEED` | No | `10000000` | Insurance seed (10 USDC) |
| `TRADE_SIZE` | No | `1000000` | Seed trade size (1 USDC) |
| `MM_TRADE_SIZE` | No | `500000` | Market maker trade size (0.5 USDC) |

## Supabase Migration

Add the `bootstrapped` column to the markets table:

```sql
ALTER TABLE markets ADD COLUMN IF NOT EXISTS bootstrapped boolean DEFAULT false;
```

## Wallet Setup

Generate devnet wallets:
```bash
solana-keygen new -o /tmp/bootstrap-wallet.json --no-bip39-passphrase
solana airdrop 5 $(solana-keygen pubkey /tmp/bootstrap-wallet.json) --url devnet
```

Fund with test USDC using the devnet faucet or mint authority.
