# Percolator Launch

**Pump.fun for Perps** — Launch perpetual futures markets for any Solana token in one click.

Powered by [Percolator](https://github.com/toly/percolator), deployed on Solana mainnet.

## Architecture

```
percolator-launch/
├── packages/core/     # Slab parser, instruction encoder, PDA derivation
├── app/               # Next.js 14 frontend
│   ├── app/page.tsx          # Landing page
│   ├── app/launch/           # Launch wizard
│   ├── app/markets/          # Browse markets
│   ├── app/trade/[slab]/     # Trading UI
│   ├── app/portfolio/        # User portfolio
│   ├── app/devnet-mint/      # Faucet (devnet only)
│   ├── app/api/health/       # Health check endpoint
│   ├── app/api/stats/        # Platform stats endpoint
│   └── middleware.ts         # Security headers + rate limiting
├── services/
│   ├── oracle/        # Price pusher (Jupiter → on-chain)
│   └── keeper/        # Multi-market crank bot
├── program/           # Solana program (Rust)
├── percolator/        # Risk engine library (Rust)
└── README.md
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/dcccrypto/percolator-launch.git
cd percolator-launch
pnpm install

# 2. Set up environment
cp app/.env.local.example app/.env.local
# Edit .env.local with your values (see Environment Variables below)

# 3. Build and run
pnpm build        # builds core + app
pnpm dev           # starts Next.js dev server at http://localhost:3000
```

### For New Contributors

1. **Frontend** lives in `app/` — standard Next.js 14 with App Router
2. **Core SDK** in `packages/core/` — slab parsing, instruction encoding, PDA derivation
3. **Solana program** in `program/` — Rust, builds with `cargo build-sbf`
4. **Tests** in `tests/` — run with `pnpm test`

Branch naming: `cobra/<type>/<description>` (e.g., `cobra/feat/new-feature`)

## Environment Variables

### App (`app/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anonymous key (client-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (server-side only) |
| `INDEXER_API_KEY` | ✅ | API key for indexer/trade recording endpoints |
| `NEXT_PUBLIC_RPC_URL` | ❌ | Custom Solana RPC URL (defaults to devnet) |
| `NEXT_PUBLIC_NETWORK` | ❌ | `devnet` or `mainnet-beta` (defaults to `devnet`) |
| `NEXT_PUBLIC_PROGRAM_ID` | ❌ | Override program ID |

### Oracle Service (`services/oracle`)

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | ✅ | Solana RPC endpoint |
| `MARKETS` | ✅ | JSON array of `{slab, mint}` objects |
| `WALLET_PATH` | ❌ | Path to keypair (defaults to `~/.config/solana/id.json`) |

### Keeper Service (`services/keeper`)

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | ✅ | Solana RPC endpoint |
| `SLABS` | ✅ | JSON array of slab addresses to crank |
| `WALLET_PATH` | ❌ | Path to keypair (defaults to `~/.config/solana/id.json`) |
| `CRANK_INTERVAL_MS` | ❌ | Crank interval in ms (defaults to 5000) |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Extended health check (Supabase + RPC status) |
| `/api/stats` | GET | No | Platform-wide stats (markets, volume, traders) |
| `/api/markets` | GET | No | List all markets with stats |
| `/api/markets` | POST | API Key | Register a new market |
| `/api/markets/[slab]/trades` | GET | No | Recent trades for a market |
| `/api/markets/[slab]/trades` | POST | API Key | Record a trade (indexer) |
| `/api/markets/[slab]/stats` | GET | No | Market-specific stats |
| `/api/markets/[slab]/prices` | GET | No | Price history |
| `/api/crank` | POST | API Key | Trigger crank |
| `/api/launch` | POST | API Key | Launch new market |

## Program IDs (Mainnet)

- **Program:** `GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24`
- **Matcher:** `DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX`

## How It Works

1. **Pick a token** — Paste any Solana mint address
2. **Set parameters** — Leverage, fees, initial liquidity
3. **Deploy** — One-click multi-tx deployment creates:
   - Slab account (market state)
   - Vault ATA (collateral)
   - Market initialization
   - Oracle authority setup
   - vAMM matcher + LP
4. **Trade** — Share the link, anyone can trade

## Security

- **CSP headers** on all responses (middleware)
- **Rate limiting** on API routes (120 req/min per IP)
- **API key auth** on mutation endpoints
- **On-chain verification** of slab ownership on market registration

## Services

### Oracle (`services/oracle`)
Pushes prices from Jupiter API to all registered markets.

```bash
cd services/oracle
MARKETS='[{"slab":"...","mint":"..."}]' RPC_URL=... npx tsx src/index.ts
```

### Keeper (`services/keeper`)
Cranks all markets every 5 seconds.

```bash
cd services/keeper
SLABS='["slab_address_1","slab_address_2"]' RPC_URL=... npx tsx src/index.ts
```

## License

MIT
