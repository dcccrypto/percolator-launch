# Percolator Launch

**Pump.fun for Perps** — Launch perpetual futures markets for any Solana token in one click.

Built on [Percolator](https://github.com/aeyakovenko/percolator) by Anatoly Yakovenko. Permissionless, coin-margined, fully on-chain.

[![Live on Devnet](https://img.shields.io/badge/Devnet-Live-14F195?style=flat&logo=solana)](https://percolator-launch.vercel.app)
[![57 PRs Merged](https://img.shields.io/badge/PRs-57%20merged-blue?style=flat)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat&logo=typescript)](/)
[![Tests](https://img.shields.io/badge/Tests-32%2F32%20passing-14F195?style=flat)]()

---

## What is this?

Anyone can deploy a leveraged perpetual futures market for **any** Solana token — no listing fees, no governance vote, no permission needed.

Pick a token. Set leverage. Click deploy. Share the link. People trade.

Markets are **coin-margined** — traders deposit the same token they're trading (e.g., BONK perp = deposit BONK as collateral).

### How it works

1. **Pick a token** — Paste any SPL mint address (if it has a DEX pool, it works)
2. **Configure** — Set max leverage (up to 20x), trading fees, slab size
3. **Deploy** — One-click multi-step deployment creates everything on-chain
4. **Trade** — Share the market link. Anyone with a wallet can go long/short
5. **Automatic liquidity** — vAMM matcher provides initial liquidity
6. **Insurance** — LP providers earn yield from trading fees and liquidations

---

## Architecture

```
percolator-launch/
├── app/                    # Next.js 14 frontend (App Router)
│   ├── app/                # Pages
│   │   ├── page.tsx        # Landing
│   │   ├── create/         # Quick Launch wizard
│   │   ├── markets/        # Browse all markets
│   │   ├── trade/[slab]/   # Trading interface
│   │   ├── my-markets/     # Admin dashboard (your markets)
│   │   ├── portfolio/      # Positions & PnL
│   │   ├── devnet-mint/    # Token faucet (devnet)
│   │   ├── guide/          # Devnet/mainnet guide
│   │   └── agents/         # Agent contribution guide
│   ├── components/         # React components
│   │   ├── create/         # Market creation wizard
│   │   ├── trade/          # TradeForm, PositionPanel, DepositWithdraw, TradeHistory
│   │   ├── layout/         # Header, navigation
│   │   └── ui/             # Shared UI primitives
│   ├── hooks/              # Custom React hooks
│   │   ├── useMarketData   # Slab parsing & account state
│   │   ├── useLivePrice    # WebSocket + Jupiter + on-chain price
│   │   ├── useTradeExec    # Trade execution with auto-crank
│   │   └── useTokenMeta    # Token metadata resolution
│   └── lib/                # Utilities
│       ├── slab.ts         # Slab account parser
│       ├── instructions.ts # Transaction builders
│       ├── tokenMeta.ts    # Metaplex → Jupiter → fallback
│       └── pda.ts          # PDA derivation
│
├── packages/
│   ├── core/               # Shared SDK
│   │   └── src/
│   │       ├── abi/        # Slab binary layout, encoding/decoding
│   │       ├── math/       # Risk engine math, PnL calculations
│   │       ├── oracle/     # DEX oracle (PumpSwap, Raydium CLMM, Meteora DLMM)
│   │       ├── runtime/    # Account loaders, PDA helpers
│   │       ├── solana/     # Connection utilities
│   │       └── validation  # Input validation
│   │
│   └── server/             # Backend (Hono on Railway)
│       └── src/
│           ├── index.ts           # Server entry + graceful shutdown
│           ├── routes/            # REST API routes
│           ├── services/
│           │   ├── crank.ts       # Multi-market crank bot
│           │   ├── oracle.ts      # Smart price router (DexScreener → Pyth → Jupiter)
│           │   ├── PriceEngine.ts # WebSocket price streaming (Helius Geyser)
│           │   ├── liquidation.ts # Auto-liquidation engine
│           │   ├── lifecycle.ts   # Market lifecycle manager
│           │   ├── TradeIndexer.ts # On-chain trade parsing → Supabase
│           │   ├── InsuranceLPService.ts # Insurance fund monitoring
│           │   └── events.ts      # Event bus
│           └── db/                # Supabase queries
│
├── program/                # Solana program (Rust, BPF)
│   └── src/lib.rs          # All instruction handlers (Tags 0-28)
│
├── percolator/             # Risk engine library (Rust crate)
│   └── src/                # Position math, funding, liquidation logic
│
├── tests/                  # On-chain integration tests (devnet)
│   ├── harness.ts          # Shared test utilities
│   ├── t1-market-boot.ts   # Market creation lifecycle
│   ├── t2-user-lifecycle.ts # Deposit → trade → withdraw
│   ├── t3-hyperp-lifecycle.ts # Admin oracle market flow
│   ├── t4-liquidation.ts   # Full liquidation lifecycle (8 steps)
│   ├── t6-risk-gate.ts     # Risk threshold + EWMA testing
│   ├── t7-market-pause.ts  # Pause/unpause enforcement
│   └── t8-trading-fee-update.ts # Dynamic fee updates
│
└── docs/                   # Architecture documentation
```

---

## Features

### Market Creation
- **Quick Launch** — 5-step guided wizard, deploys everything in ~30 seconds
- **Variable slab sizes** — Small (256 slots, ~0.5 SOL), Medium (1024, ~1.8 SOL), Large (4096, ~6.9 SOL)
- **Any SPL token** — Auto-detects price feed via Smart Price Router
- **vAMM liquidity** — Automatic initial liquidity via matcher program
- **Insurance LP** — On-chain insurance fund with SPL claim tokens

### Trading
- **Up to 20x leverage** — Configurable per market
- **Long & short** — Full directional trading
- **Coin-margined** — Deposit the token you're trading
- **Auto-crank** — Oracle price push + crank prepended to every trade
- **Real-time prices** — WebSocket streaming via Helius Geyser + Jupiter fallback
- **Trade history** — On-chain transaction indexing

### Smart Price Router
Automatically finds the best price source for any token:
1. **DexScreener** → Real-time DEX prices (PumpSwap, Raydium, Meteora, Orca)
2. **Pyth** → Institutional-grade oracle feeds
3. **Jupiter** → Aggregated DEX pricing
4. Multi-source median with 30% deviation protection and 5-minute staleness expiry

### Admin Dashboard
- Push oracle prices (admin oracle mode)
- Pause/unpause markets
- Update trading fees
- Reset risk gates
- Burn admin keys (renounce)

### Security
- Rate limiting (token-bucket, 10 req/s)
- API key auth on all mutations
- CORS allowlist
- CSP headers
- Priority fees for tx inclusion
- `getSignatureStatuses` polling (not `confirmTransaction`)
- Idempotent market creation with retry logic
- Compile-time safety guards (`compile_error!` prevents unsafe feature combos)

---

## Program Details

### Instruction Tags

| Tag | Name | Description |
|-----|------|-------------|
| 0 | InitSlab | Create market slab account |
| 1 | InitMarket | Initialize market parameters |
| 2 | InitLP | Initialize vAMM matcher liquidity |
| 3 | InitUser | Create user account on slab |
| 4 | DepositCollateral | Deposit tokens as collateral |
| 5 | WithdrawCollateral | Withdraw available collateral |
| 6 | TradeNoCpi | Open/close position (direct) |
| 7 | Liquidate | Liquidate undercollateralized position |
| 8 | KeeperCrank | Update funding, mark price, risk metrics |
| 9 | PushOraclePrice | Push price from oracle authority |
| 10 | TradeCpi | Open/close via matcher program (vAMM) |
| 14 | AdminForceClose | Emergency position close |
| 15 | SetRiskThreshold | Configure risk parameters + trading fees |
| 23 | RenounceAdmin | Burn admin keys (irreversible) |
| 24 | CreateInsuranceMint | Create SPL claim token for insurance LP |
| 25 | DepositInsuranceLP | Deposit to insurance fund, receive LP tokens |
| 26 | WithdrawInsuranceLP | Redeem LP tokens for pro-rata share |
| 27 | PauseMarket | Pause market (blocks user operations) |
| 28 | UnpauseMarket | Resume market |

### Deployed Programs (Devnet)

| Tier | Max Accounts | Rent | Program ID |
|------|-------------|------|------------|
| Small | 256 | ~0.5 SOL | `8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL` |
| Medium | 1024 | ~1.8 SOL | `9RKMpUGWemamrMg75zLgjYPmjWGzfah7wf9rgVrTddnT` |
| Large | 4096 | ~6.9 SOL | `58XqjfaeBVcJBrK6mdY51SaeEW1UFmFX9sVimxpryFEu` |

**Matcher (vAMM):** `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy`

### Mainnet Program

- **Program:** `GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24`
- **Matcher:** `DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX`

---

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- Solana CLI (for program builds)
- Rust + cargo-build-sbf (for program builds)

### Development

```bash
# Clone
git clone https://github.com/dcccrypto/percolator-launch.git
cd percolator-launch
pnpm install

# Configure environment
cp app/.env.local.example app/.env.local
# Edit with your Supabase + RPC credentials

# Run frontend
pnpm dev

# Run backend (separate terminal)
cd packages/server
pnpm dev
```

### Build Solana Program

```bash
# Build all 3 variants
cd program

# Small (256 slots)
cargo build-sbf --features small
# Medium (1024 slots) 
cargo build-sbf --features medium
# Large (4096 slots — default)
cargo build-sbf
```

### Run Tests

Tests run against live devnet — requires funded wallet:

```bash
# All tests
pnpm test

# Individual test suites
npx tsx tests/t1-market-boot.ts      # Market creation
npx tsx tests/t2-user-lifecycle.ts   # Trading lifecycle
npx tsx tests/t4-liquidation.ts      # Liquidation
npx tsx tests/t6-risk-gate.ts        # Risk engine
npx tsx tests/t7-market-pause.ts     # Pause/unpause
npx tsx tests/t8-trading-fee-update.ts # Fee updates
```

---

## Environment Variables

### Frontend (`app/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `INDEXER_API_KEY` | ✅ | API key for protected endpoints |
| `NEXT_PUBLIC_RPC_URL` | ❌ | Custom RPC URL (defaults to devnet) |
| `NEXT_PUBLIC_NETWORK` | ❌ | `devnet` or `mainnet-beta` |
| `NEXT_PUBLIC_WS_URL` | ❌ | Backend WebSocket URL for live prices |

### Backend (`packages/server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | ✅ | Helius RPC + Geyser API key |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `API_AUTH_KEY` | ✅ | API authentication key |
| `CRANK_WALLET_PATH` | ✅ | Path to crank wallet keypair |
| `ALLOWED_ORIGINS` | ❌ | CORS allowlist (comma-separated) |
| `PORT` | ❌ | Server port (default: 3001) |

---

## Backend API

Base URL: `https://percolator-api-production.up.railway.app`

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/markets` | GET | No | List all markets with stats |
| `/markets` | POST | API Key | Register a new market |
| `/markets/:slab/trades` | GET | No | Recent trades for a market |
| `/crank/status` | GET | No | Crank service status (all markets) |
| `/oracle/resolve/:mint` | GET | No | Resolve best price source for a token |
| `/prices/ws` | WS | No | Live price streaming |
| `/health` | GET | No | Server health check |

---

## Design

**Solana Terminal** — Deep dark backgrounds (#0A0A0F), Solana purple (#9945FF), green (#14F195), monospace-first typography, HUD grid overlays. Built for traders who live in terminals.

---

## Contributing

We welcome contributions from humans and AI agents.

### For Developers
1. Fork the repo
2. Create a feature branch (`cobra/<type>/<description>` or your own prefix)
3. Open a PR against `main`
4. CI runs TypeScript + ESLint checks automatically

### For AI Agents
See [CONTRIBUTING-AGENTS.md](./CONTRIBUTING-AGENTS.md) and the [Agent Guide](https://percolator-launch.vercel.app/agents) for architecture context, prompts, and PR guidelines.

### Branch Protection
- Direct pushes to `main` are blocked
- PRs require review before merging
- CI must pass (TypeScript + ESLint)

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14, React 18, Tailwind CSS, GSAP |
| Backend | Hono (TypeScript), Railway |
| Database | Supabase (PostgreSQL) |
| Blockchain | Solana, Anchor-compatible BPF program |
| Prices | Helius Geyser WebSocket, Jupiter, DexScreener, Pyth |
| Wallet | Solana Wallet Adapter (Phantom, Solflare, etc.) |
| CI/CD | Vercel (frontend), Railway (backend), GitHub Actions |

---

## Acknowledgements

- [Anatoly Yakovenko](https://github.com/aeyakovenko) — Percolator protocol design + risk engine
- [Solana Foundation](https://solana.org) — Infrastructure
- [Helius](https://helius.dev) — RPC + Geyser streaming

---

## License

MIT
