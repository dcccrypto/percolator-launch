# Percolator Launch

**Pump.fun for Perps** — Launch perpetual futures markets for any Solana token in one click.

Built on [Percolator](https://github.com/aeyakovenko/percolator) by Anatoly Yakovenko. Permissionless, coin-margined, fully on-chain.

[![Live on Devnet](https://img.shields.io/badge/Devnet-Live-14F195?style=flat&logo=solana)](https://percolator.app)
[![PRs Merged](https://img.shields.io/badge/PRs-66%20merged-blue?style=flat)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat&logo=typescript)](/)
[![Tests](https://img.shields.io/badge/Tests-32%2F32%20passing-14F195?style=flat)]()

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
- [Features](#features)
- [On-Chain Program](#on-chain-program)
- [Backend Services](#backend-services)
- [Frontend](#frontend)
- [Core SDK](#core-sdk)
- [Testing](#testing)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Design System](#design-system)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

### Prerequisites

- **Node.js** 18+ and **pnpm** 8+
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
# Frontend
cp app/.env.local.example app/.env.local
# Edit with your keys (see Environment Variables section below)

# Backend
cp packages/server/.env.example packages/server/.env
# Edit with Helius API key, crank wallet, etc.
```

### 3. Run Development

```bash
# Frontend (Next.js dev server)
cd app && pnpm dev

# Backend (Hono server — separate terminal)
cd packages/server && pnpm dev
```

### 4. Build the Solana Program

```bash
cd program

# Small tier (256 accounts, ~0.5 SOL rent)
cargo build-sbf --features small

# Medium tier (1024 accounts, ~1.8 SOL rent)
cargo build-sbf --features medium

# Large tier (4096 accounts, ~6.9 SOL rent)
cargo build-sbf
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                    │
│  Landing → Create Wizard → Trade → My Markets → Portfolio│
└──────────────────────┬───────────────────────────────────┘
                       │ RPC + WebSocket
┌──────────────────────▼───────────────────────────────────┐
│                  Backend (Hono / Railway)                 │
│  Crank Bot │ Oracle Service │ Liquidation │ Price Engine │
└──────────────────────┬───────────────────────────────────┘
                       │ Solana RPC
┌──────────────────────▼───────────────────────────────────┐
│                Solana Programs (BPF)                      │
│  Percolator Program (3 tiers) + Matcher (vAMM)           │
│  Slab accounts store ALL market state in one account     │
└──────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **Slab architecture** — Each market is a single large Solana account ("slab") containing config, engine state, and all user accounts. No account fan-out.
- **Coin-margined** — Collateral = the traded token. No USDC dependency.
- **Admin oracle mode** — For devnet tokens without Pyth feeds, the market admin pushes prices manually. Mainnet uses live oracle feeds.
- **Variable slab sizes** — 3 tiers with different rent costs and capacity. Pick the right size for your market.

---

## Project Structure

```
percolator-launch/
│
├── app/                          # Next.js 14 frontend (App Router)
│   ├── app/                      # Pages
│   │   ├── page.tsx              # Landing page
│   │   ├── create/               # Quick Launch wizard (6-step market creation)
│   │   ├── markets/              # Browse all markets (search, filter, sort)
│   │   ├── trade/[slab]/         # Trading interface (chart, trade form, positions)
│   │   ├── my-markets/           # Admin dashboard (push prices, pause, configure)
│   │   ├── portfolio/            # Your positions across all markets
│   │   ├── devnet-mint/          # Token faucet with custom metadata (devnet only)
│   │   ├── guide/                # Devnet vs mainnet guide
│   │   └── agents/               # How AI agents can contribute
│   ├── components/
│   │   ├── create/               # CreateMarketWizard, SlabSizeSelector
│   │   ├── trade/                # TradeForm, PositionPanel, AccountsCard, TradeHistory
│   │   ├── layout/               # Header, navigation, TickerBar
│   │   ├── market/               # MarketCard, ShareCard
│   │   └── providers/            # SlabProvider (context for slab data)
│   ├── hooks/                    # React hooks
│   │   ├── useMarketConfig.ts    # Parse slab config from on-chain data
│   │   ├── useLivePrice.ts       # WebSocket + Jupiter + on-chain price feed
│   │   ├── useTrade.ts           # Trade execution (auto-crank, retry, error handling)
│   │   ├── useAdminActions.ts    # Admin: push price, pause, set fees, renounce
│   │   ├── useTokenMeta.ts       # Metaplex → Jupiter → fallback token metadata
│   │   └── useInsuranceLP.ts     # Insurance fund deposit/withdraw
│   └── lib/
│       ├── trading.ts            # PnL, liquidation price, margin calculations
│       ├── format.ts             # USD/token/address formatting
│       ├── errorMessages.ts      # All 34 program error codes → human messages
│       ├── config.ts             # Network config, explorer URLs
│       └── sendTx.ts             # Transaction builder with retry + priority fees
│
├── packages/
│   ├── core/                     # Shared TypeScript SDK (@percolator/core)
│   │   └── src/
│   │       ├── abi/              # Binary encoding/decoding for all 29 instructions
│   │       │   ├── instructions.ts   # Encode functions (encodePushOraclePrice, etc.)
│   │       │   ├── accounts.ts       # Account meta specs per instruction
│   │       │   ├── encode.ts         # Primitive encoders (u8, u64, i64, i128)
│   │       │   └── errors.ts         # PercolatorError enum (34 error codes)
│   │       ├── math/             # Trading math (coin-margined PnL, liq price, margin)
│   │       ├── oracle/           # DEX oracle parsers
│   │       │   └── price-router.ts   # PumpSwap, Raydium CLMM, Meteora DLMM
│   │       ├── solana/
│   │       │   ├── slab.ts       # Slab parser (header, config, engine, params, accounts)
│   │       │   ├── discovery.ts  # On-chain market discovery (getProgramAccounts)
│   │       │   └── pda.ts        # PDA derivation (vault, insurance mint, Pyth push oracle)
│   │       └── validation.ts     # Input validators
│   │
│   └── server/                   # Backend API (Hono framework, deployed on Railway)
│       └── src/
│           ├── index.ts          # Server entry, CORS, routes, graceful shutdown
│           ├── config.ts         # Environment-based configuration
│           ├── routes/
│           │   ├── markets.ts    # GET /markets, POST /markets
│           │   ├── crank.ts      # GET /crank/status, POST /crank/:slab
│           │   ├── oracle-router.ts  # GET /oracle/resolve/:mint
│           │   ├── prices.ts     # GET /prices/:slab, WebSocket /prices/ws
│           │   ├── insurance.ts  # GET /insurance/:slab
│           │   └── health.ts     # GET /health
│           ├── services/
│           │   ├── crank.ts          # Auto-crank bot (all markets, batched, rate-limited)
│           │   ├── oracle.ts         # Oracle price fetcher (DexScreener → Jupiter → fallback)
│           │   ├── PriceEngine.ts    # Helius Geyser WebSocket → live price streaming
│           │   ├── liquidation.ts    # Auto-liquidation scanner + executor (15s interval)
│           │   ├── TradeIndexer.ts   # Parse crank txs → extract trades → Supabase
│           │   ├── InsuranceLPService.ts # Insurance fund monitoring
│           │   ├── lifecycle.ts      # Market state machine (Quick Launch flow)
│           │   ├── vamm.ts           # vAMM matcher integration
│           │   └── events.ts         # Internal event bus
│           ├── middleware/
│           │   ├── auth.ts           # API key authentication
│           │   ├── rate-limit.ts     # Token-bucket rate limiter (10 req/s)
│           │   └── validateSlab.ts   # Slab address validation
│           └── utils/
│               ├── solana.ts         # Keypair loading, sendWithRetry, connection
│               ├── rpc-client.ts     # Rate-limited RPC with fallback to public devnet
│               └── priority-fee.ts   # Priority fee estimation
│
├── program/                      # Solana BPF program (Rust)
│   ├── src/lib.rs                # All instruction handlers (Tags 0-28)
│   ├── Cargo.toml                # Feature flags: small, medium, large (default)
│   └── Cargo.lock
│
├── percolator/                   # Risk engine (Rust crate, from aeyakovenko/percolator)
│   └── src/                      # Position math, funding rates, liquidation logic, EWMA
│
├── tests/                        # Integration tests (run against live devnet)
│   ├── harness.ts                # Shared test utilities + wallet setup
│   ├── t1-market-boot.ts         # Full market creation lifecycle
│   ├── t2-user-lifecycle.ts      # Deposit → trade → withdraw → close
│   ├── t3-hyperp-lifecycle.ts    # Admin oracle flow (push price, crank, trade)
│   ├── t4-liquidation.ts         # 8-step liquidation: create → leverage → crash → liquidate
│   ├── t6-risk-gate.ts           # Risk threshold EWMA + circuit breaker (10 tests)
│   ├── t7-market-pause.ts        # Pause/unpause enforcement (14 tests)
│   └── t8-trading-fee-update.ts  # Dynamic fee update + backwards compat (8 tests)
│
├── docs/                         # Extended documentation
│   ├── BACKEND-ARCHITECTURE.md   # Backend service architecture
│   ├── INSURANCE-LP-SPEC.md      # Insurance LP token spec (VaR-based yield)
│   ├── MAINNET-READINESS.md      # Mainnet deployment checklist
│   ├── MAINNET-ROADMAP.md        # Roadmap to mainnet
│   └── MIDTERM-COMPARISON.md     # Comparison with MidTermDev's implementation
│
├── CONTRIBUTING-AGENTS.md        # Guide for AI agents contributing to the repo
├── AUDIT-TRADE.md                # Trade system audit (23 findings)
├── AUDIT-PAGES.md                # Pages audit (34 findings)
└── AUDIT-BACKEND.md              # Backend audit (15 findings)
```

---

## Features

### Market Creation (Quick Launch)
- **6-step guided wizard** — Token selection → configure leverage/fees → deploy slab → init market → init vAMM → create insurance LP mint
- **Variable slab sizes** — Small (256 slots, ~0.5 SOL), Medium (1024, ~1.8 SOL), Large (4096, ~6.9 SOL)
- **Any SPL token works** — Paste a mint address. If it has a DEX pool, the Smart Price Router auto-detects the price feed
- **Idempotent creation** — If a step fails and you retry, it checks if the account already exists before re-creating
- **vAMM auto-liquidity** — Matcher program provides initial LP so markets are tradeable immediately
- **Insurance LP mint** — On-chain SPL claim token for insurance fund (pro-rata redemption)

### Trading
- **Up to 20x leverage** — Configurable per-market by the creator
- **Long & short** — Full directional trading with coin-margined PnL
- **Auto-crank in every trade** — Each trade tx prepends PushOraclePrice + KeeperCrank instructions
- **Real-time prices** — WebSocket streaming via Helius Geyser, falls back to Jupiter polling
- **Position panel** — Live PnL, liquidation price, margin health (distance-from-liq formula)
- **Trade history** — On-chain transaction indexing via TradeIndexer service
- **Human-readable errors** — All 34 program error codes mapped to clear messages

### Smart Price Router
The oracle system automatically finds the best price source for any token:

| Priority | Source | Coverage |
|----------|--------|----------|
| 1 | **DexScreener** | Any token with a DEX pool (PumpSwap, Raydium, Meteora, Orca) |
| 2 | **Pyth** | Major tokens with institutional oracle feeds |
| 3 | **Jupiter** | Aggregated price from all DEX sources |
| 4 | **On-chain** | Admin-pushed price (devnet only for tokens with no DEX presence) |

Multi-source median pricing with 30% max deviation protection and 5-minute staleness expiry.

### Admin Dashboard (My Markets)
- **Push oracle prices** — For admin-oracle markets, push prices with one click (circuit breaker auto-disabled)
- **Pause/unpause** — Emergency market pause (blocks all user operations, crank continues)
- **Update trading fees** — Change fee rate without redeploying
- **Reset risk gates** — Clear risk-reduction-only mode when markets get stuck
- **Renounce admin** — Irreversibly burn admin keys (makes market fully permissionless)
- **Top up insurance** — Add funds to insurance vault

### Insurance LP
- On-chain deposit/withdraw with SPL claim tokens
- Pro-rata redemption — your LP tokens represent your share of the insurance vault
- Vault grows from trading fees and liquidation proceeds
- Anti-drain protection via `risk_reduction_threshold`

### Security
- **Rate limiting** — Token-bucket algorithm, 10 req/s per client
- **API key auth** — All mutation endpoints require `x-api-key` header
- **CORS allowlist** — Only configured origins can access the API
- **Priority fees** — 100k µLamports for reliable tx inclusion
- **Reliable confirmation** — `getSignatureStatuses` polling instead of `confirmTransaction` (which false-reports failures on devnet)
- **Idempotent operations** — Market creation and account setup check for existing state before creating
- **Compile-time guards** — `compile_error!` macros prevent unsafe feature combinations in Rust

---

## On-Chain Program

The Percolator program handles all market operations. Everything lives in a single "slab" account per market.

### Slab Layout

```
┌─────────────────────────────────────────────┐
│ Header (72 bytes)                           │
│   magic, version, bump, admin, flags        │
├─────────────────────────────────────────────┤
│ MarketConfig (320 bytes)                    │
│   collateral_mint, vault, oracle config,    │
│   funding params, risk thresholds,          │
│   oracle authority + prices                 │
├─────────────────────────────────────────────┤
│ Engine State (256 bytes)                    │
│   mark price, funding accumulator,          │
│   open interest, risk metrics (EWMA)        │
├─────────────────────────────────────────────┤
│ Params (variable)                           │
│   leverage limits, margin requirements,     │
│   fee rates, liquidation params             │
├─────────────────────────────────────────────┤
│ Bitmap (variable, based on max_accounts)    │
├─────────────────────────────────────────────┤
│ Accounts (N × account_size)                 │
│   Each: kind, owner, position, capital,     │
│         pnl, entry_price, funding_offset    │
└─────────────────────────────────────────────┘
```

### Instruction Tags

| Tag | Instruction | Who | Description |
|-----|------------|-----|-------------|
| 0 | `InitSlab` | Creator | Allocate slab account |
| 1 | `InitMarket` | Creator | Set market parameters (leverage, fees, oracle) |
| 2 | `InitLP` | Creator | Initialize vAMM liquidity via matcher program |
| 3 | `InitUser` | Anyone | Create a trading account on the slab |
| 4 | `DepositCollateral` | Trader | Deposit tokens to your account |
| 5 | `WithdrawCollateral` | Trader | Withdraw available collateral |
| 6 | `TradeNoCpi` | Trader | Open or close a position (direct mode) |
| 7 | `LiquidateAtOracle` | Anyone | Liquidate an undercollateralized position |
| 8 | `KeeperCrank` | Anyone | Update funding rates, mark price, risk metrics |
| 9 | `PushOraclePrice` | Oracle Auth | Push a new price (admin oracle or Pyth relay) |
| 10 | `TradeCpi` | Trader | Trade via vAMM matcher (with LP counterparty) |
| 14 | `AdminForceClose` | Admin | Emergency close a position |
| 15 | `SetRiskThreshold` | Admin | Configure risk params + optional trading fee update |
| 16 | `SetOracleAuthority` | Admin | Change oracle authority pubkey |
| 17 | `SetOraclePriceCap` | Admin | Set circuit breaker (max price change per push) |
| 23 | `RenounceAdmin` | Admin | Burn admin keys permanently |
| 24 | `CreateInsuranceMint` | Admin | Create SPL claim token for insurance LP |
| 25 | `DepositInsuranceLP` | Anyone | Deposit to insurance fund → receive LP tokens |
| 26 | `WithdrawInsuranceLP` | LP holder | Redeem LP tokens → receive pro-rata vault share |
| 27 | `PauseMarket` | Admin | Pause market (blocks InitUser, Deposit, Withdraw, Trade) |
| 28 | `UnpauseMarket` | Admin | Resume market operations |

### Error Codes

All 34 error codes are mapped to human-readable messages in the frontend. Key ones:

| Code | Name | Meaning |
|------|------|---------|
| 0 | `InvalidMagic` | Not a valid slab account |
| 5 | `InsufficientFunds` | Not enough collateral |
| 7 | `SlabFull` | Max accounts reached, use a larger tier |
| 12 | `OracleInvalid` | No valid price available |
| 14 | `Undercollateralized` | Position below maintenance margin |
| 15 | `EngineUnauthorized` | Wrong oracle authority |
| 22 | `EngineRiskReductionOnlyMode` | Risk circuit breaker active — close-only |
| 33 | `MarketPaused` | Market is paused by admin |

Full error enum: [`packages/core/src/abi/errors.ts`](./packages/core/src/abi/errors.ts)

### Deployed Programs

**Devnet:**

| Tier | Max Accounts | Slab Size | Rent | Program ID |
|------|-------------|-----------|------|------------|
| Small | 256 | 62,808 bytes | ~0.5 SOL | `8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL` |
| Medium | 1024 | 249,480 bytes | ~1.8 SOL | `9RKMpUGWemamrMg75zLgjYPmjWGzfah7wf9rgVrTddnT` |
| Large | 4096 | 992,560 bytes | ~6.9 SOL | `58XqjfaeBVcJBrK6mdY51SaeEW1UFmFX9sVimxpryFEu` |

**Matcher (vAMM):** `4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy`

**Mainnet:**
- Program: `GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24`
- Matcher: `DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX`

---

## Backend Services

The backend runs on Railway and provides critical infrastructure:

### Crank Bot (`services/crank.ts`)
- Discovers all markets across 3 program tiers via `getProgramAccounts`
- Cranks every market every 10 seconds (batches of 3, rate-limited)
- Pushes oracle prices for markets where the crank wallet is the oracle authority
- Handles 43+ markets concurrently with 0 failures

### Liquidation Scanner (`services/liquidation.ts`)
- Scans all markets every 15 seconds for undercollateralized positions
- Sends multi-instruction tx: crank → liquidate (atomic)
- Only pushes oracle price when crank wallet IS the oracle authority

### Price Engine (`services/PriceEngine.ts`)
- Streams live prices via Helius Geyser WebSocket
- Falls back to Jupiter polling when WebSocket disconnects
- Broadcasts to all connected frontend clients

### Trade Indexer (`services/TradeIndexer.ts`)
- Listens for successful crank events
- Parses on-chain transactions for TradeCpi (tag 10) and TradeNoCpi (tag 6)
- Extracts trader, size, side, price from instruction data
- Writes to Supabase `trades` table with deduplication

### API Routes

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/markets` | GET | — | List all discovered markets with stats |
| `/markets` | POST | API Key | Register a new market in Supabase |
| `/markets/:slab/trades` | GET | — | Recent trades for a market |
| `/crank/status` | GET | — | Per-market crank stats (success/fail counts) |
| `/crank/:slab` | POST | API Key | Force-crank a specific market |
| `/oracle/resolve/:mint` | GET | — | Resolve best price source for a token mint |
| `/prices/:slab` | GET | — | Current price + 24h stats for a market |
| `/prices/ws` | WebSocket | — | Live price streaming (subscribe by slab address) |
| `/insurance/:slab` | GET | — | Insurance fund stats |
| `/health` | GET | — | Service health, uptime, crank/liquidation stats |

---

## Frontend

### Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page — explains the protocol, CTA to create or trade |
| `/create` | Quick Launch wizard — 6 steps from token selection to live market |
| `/markets` | Browse all markets — search by CA/name, filter by leverage/oracle type |
| `/trade/[slab]` | Trading interface — chart, trade form, position panel, accounts table, trade history |
| `/my-markets` | Admin dashboard — manage markets you created (push prices, pause, configure) |
| `/portfolio` | Your positions across all markets with aggregate PnL |
| `/devnet-mint` | Faucet — mint test tokens with custom name/symbol (Metaplex metadata) |
| `/guide` | Comprehensive devnet vs mainnet guide |
| `/agents` | How AI agents can contribute to the project |

### Key Hooks

| Hook | Purpose |
|------|---------|
| `useMarketConfig` | Parse slab on-chain data into typed config object |
| `useSlabState` | Full slab state: config, engine, params, all accounts |
| `useLivePrice` | Real-time price from WebSocket → Jupiter → on-chain fallback |
| `useTrade` | Execute trades with auto-crank, error handling, retry |
| `useAdminActions` | Admin operations (push price, pause, set fees, renounce) |
| `useTokenMeta` | Token metadata: cache → Metaplex on-chain → Jupiter → fallback |
| `useInsuranceLP` | Insurance fund operations (deposit/withdraw/balance) |

---

## Core SDK

The `@percolator/core` package (`packages/core/`) is a shared TypeScript library used by both frontend and backend.

### Slab Parsing
```typescript
import { fetchSlab, parseConfig, parseEngine, parseParams, parseAccount, detectLayout } from "@percolator/core";

const data = await fetchSlab(connection, slabPubkey);
const config = parseConfig(data);     // Market configuration
const engine = parseEngine(data);     // Engine state (mark price, OI, funding)
const params = parseParams(data);     // Trading parameters (leverage, margins, fees)
const account = parseAccount(data, 0); // Individual user account
```

### Instruction Encoding
```typescript
import { encodePushOraclePrice, encodeKeeperCrank, encodeTradeCpi } from "@percolator/core";

const pushData = encodePushOraclePrice({ priceE6: 1_500_000n, timestamp: BigInt(now) });
const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
const tradeData = encodeTradeCpi({ lpIdx: 0, userIdx: 1, size: 10_000_000n });
```

### Trading Math
```typescript
import { computeMarkPnl, computeLiqPrice, computePnlPercent } from "@percolator/core";

const pnl = computeMarkPnl(positionSize, entryPrice, oraclePrice);
const liqPrice = computeLiqPrice(entryPrice, capital, positionSize, maintenanceMarginBps);
const roe = computePnlPercent(pnl, capital);
```

### Market Discovery
```typescript
import { discoverMarkets } from "@percolator/core";

const markets = await discoverMarkets(connection, programId);
// Returns: DiscoveredMarket[] with slabAddress, config, programId
```

---

## Testing

All tests run against **live Solana devnet** and require a funded wallet.

```bash
# Run all test suites
pnpm test

# Individual suites
npx tsx tests/t1-market-boot.ts         # Market creation lifecycle
npx tsx tests/t2-user-lifecycle.ts      # Deposit → trade → close → withdraw
npx tsx tests/t3-hyperp-lifecycle.ts    # Admin oracle: push price → crank → trade
npx tsx tests/t4-liquidation.ts         # Full liquidation (8 steps, all verified)
npx tsx tests/t6-risk-gate.ts           # Risk threshold EWMA (10/10 passing)
npx tsx tests/t7-market-pause.ts        # Pause/unpause enforcement (14/14 passing)
npx tsx tests/t8-trading-fee-update.ts  # Dynamic fee updates (8/8 passing)
```

**Current status: 32/32 on-chain tests passing.**

### Test Wallet Setup

Tests use the keypair at `~/.config/solana/id.json`. Fund it with:

```bash
solana airdrop 2 --url devnet
# If faucet is dry, transfer from another wallet
```

---

## Environment Variables

### Frontend (`app/.env.local`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | — | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | — | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Supabase service role key (server-side only) |
| `INDEXER_API_KEY` | Yes | — | API key for protected endpoints |
| `NEXT_PUBLIC_RPC_URL` | No | Helius devnet | Solana RPC endpoint |
| `NEXT_PUBLIC_NETWORK` | No | `devnet` | `devnet` or `mainnet-beta` |
| `NEXT_PUBLIC_WS_URL` | No | `ws://localhost:3001` | Backend WebSocket URL for live prices |
| `NEXT_PUBLIC_HELIUS_API_KEY` | No | — | Helius API key for higher rate limits |

### Backend (`packages/server/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HELIUS_API_KEY` | Yes | — | Helius RPC + Geyser WebSocket key |
| `CRANK_KEYPAIR` | Yes | — | Base58 or JSON array of crank wallet secret key |
| `API_AUTH_KEY` | No | — | API key for mutations (if unset, all requests allowed) |
| `SUPABASE_URL` | No | — | Supabase project URL (for trade indexer) |
| `SUPABASE_KEY` | No | — | Supabase service role key |
| `ALLOWED_ORIGINS` | No | `https://percolator.app,http://localhost:3000` | CORS allowlist |
| `PORT` | No | `3001` | Server listen port |
| `CRANK_INTERVAL_MS` | No | `10000` | Crank cycle interval (ms) |
| `CRANK_INACTIVE_INTERVAL_MS` | No | `60000` | Interval for markets with no activity |
| `ALL_PROGRAM_IDS` | No | All 3 devnet tiers | Comma-separated program IDs to scan |
| `FALLBACK_RPC_URL` | No | `https://api.devnet.solana.com` | Fallback RPC for read-only calls on 429 |

---

## Deployment

### Frontend — Vercel
The frontend auto-deploys from `main` branch via Vercel. Set environment variables in the Vercel dashboard.

### Backend — Railway
The backend runs on Railway with a Dockerfile at `packages/server/Dockerfile`.

```bash
# Deploy via Railway CLI
railway up
```

### Solana Programs
Programs are deployed via `solana program deploy` with BPFLoaderUpgradeable (allows upgrades):

```bash
solana program deploy target/deploy/percolator.so \
  --program-id <PROGRAM_KEYPAIR> \
  --url devnet
```

---

## Design System

**Solana Terminal** — A dark, HUD-inspired design language built for serious traders.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-base` | `#0A0A0F` | Page background |
| `--panel-bg` | `#111318` | Card/panel background |
| `--accent` | `#9945FF` | Solana purple — primary accent |
| `--long` | `#14F195` | Long positions, positive PnL |
| `--short` | `#F43F5E` | Short positions, negative PnL |
| `--warning` | `#FFB800` | Warnings, approaching liquidation |
| `--border` | `#1E2433` | Subtle borders |
| `--font-mono` | `JetBrains Mono` | Numbers, addresses, data |
| `--font-sans` | `Inter` | Body text |

Grid background overlay, noise texture, glass-morphism panels. No emojis in data UI. ScrollReveal animations via GSAP with CSS fallback.

---

## Documentation

Detailed docs live in the [`docs/`](./docs/) directory:

| Document | Description |
|----------|-------------|
| [`BACKEND-ARCHITECTURE.md`](./docs/BACKEND-ARCHITECTURE.md) | Backend service architecture and data flow |
| [`INSURANCE-LP-SPEC.md`](./docs/INSURANCE-LP-SPEC.md) | Insurance LP token system (VaR-based yield model) |
| [`MAINNET-READINESS.md`](./docs/MAINNET-READINESS.md) | Mainnet deployment checklist |
| [`MAINNET-ROADMAP.md`](./docs/MAINNET-ROADMAP.md) | Full roadmap to mainnet |
| [`MIDTERM-COMPARISON.md`](./docs/MIDTERM-COMPARISON.md) | Feature comparison with MidTermDev's implementation |
| [`CONTRIBUTING-AGENTS.md`](./CONTRIBUTING-AGENTS.md) | AI agent contribution guide |
| [`AUDIT-TRADE.md`](./AUDIT-TRADE.md) | Trade system audit (23 findings, all resolved) |
| [`AUDIT-PAGES.md`](./AUDIT-PAGES.md) | Frontend pages audit (34 findings, all resolved) |
| [`AUDIT-BACKEND.md`](./AUDIT-BACKEND.md) | Backend audit (15 findings, all resolved) |

---

## Contributing

We welcome contributions from both humans and AI agents.

### Getting Started
1. Fork the repo
2. Create a feature branch (e.g. `feat/your-feature` or `fix/the-bug`)
3. Make your changes
4. Open a PR against `main` with a clear description
5. CI runs TypeScript + ESLint checks automatically

### For AI Agents
See [CONTRIBUTING-AGENTS.md](./CONTRIBUTING-AGENTS.md) and the [Agent Guide](https://percolator.app/agents) for:
- Architecture overview and file map
- Example prompts for common tasks
- PR guidelines and code style
- How to test changes on devnet

### Rules
- **No direct pushes to `main`** — always use PRs
- PRs require at least 1 review
- CI must pass (TypeScript strict mode + ESLint)
- No hardcoded API keys — use environment variables

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS, GSAP animations |
| **Backend** | Hono (TypeScript), Railway |
| **Database** | Supabase (PostgreSQL + Realtime) |
| **Blockchain** | Solana (BPFLoaderUpgradeable programs, SPL Token) |
| **Oracle** | Helius Geyser WebSocket, Jupiter Price API, DexScreener, Pyth |
| **Wallet** | Solana Wallet Adapter (Phantom, Solflare, Backpack, etc.) |
| **Token Metadata** | Metaplex Token Metadata (on-chain) |
| **CI/CD** | Vercel (frontend), Railway (backend), GitHub Actions (PR checks) |
| **Testing** | Custom devnet integration tests (tsx) |

---

## Acknowledgements

- [Anatoly Yakovenko](https://github.com/aeyakovenko) — Percolator protocol design and risk engine
- [Solana Foundation](https://solana.org) — Network infrastructure
- [Helius](https://helius.dev) — RPC, Geyser WebSocket, and developer tools

---

## License

MIT
