# Percolator Playground — Contributor Guide

Everything you need to run the **Percolator devnet playground** locally and ship a
pull request. Written to be followed step by step — a human **or** an AI coding agent
can execute the whole thing top to bottom.

> **The playground** is a pro perpetual-futures trading terminal on Solana **devnet**.
> Anyone connects a wallet, gets test funds, and trades perps on real mainnet tokens
> (SOL, JUP, TRUMP, PENGU, BURNIE, Percolator) priced off live mainnet DEX pools. The
> trading app is the **`app/`** directory of this repo.
>
> **▶ Live playground: https://percolator-playground.vercel.app** — connect a devnet
> wallet and trade, no setup. (This guide is for contributing to it.)

## Contents

1. [What we need help with](#1-what-we-need-help-with)
2. [Concepts (60-second glossary)](#2-concepts-60-second-glossary)
3. [How it fits together](#3-how-it-fits-together)
4. [Prerequisites](#4-prerequisites)
5. [Setup — clone and install](#5-setup--clone-and-install)
6. [Configure the app](#6-configure-the-app)
7. [Run it](#7-run-it)
8. [Get test funds & place your first trade](#8-get-test-funds--place-your-first-trade)
9. [Map of the app — where to work](#9-map-of-the-app--where-to-work)
10. [Make a change (the dev loop)](#10-make-a-change-the-dev-loop)
11. [Code conventions](#11-code-conventions)
12. [Open a pull request](#12-open-a-pull-request)
13. [Guardrails](#13-guardrails)
14. [Troubleshooting](#14-troubleshooting)
15. [Quick reference](#15-quick-reference)

---

## 1. What we need help with

We want **frontend contributions**. This is a Next.js + TypeScript app — that's where
you can help:

- 🐛 **Bug fixes** — anything broken, misbehaving, or throwing in the console.
- ✨ **Frontend improvements** — better UX, cleaner layouts, loading/empty/error states,
  keyboard shortcuts, mobile responsiveness, accessibility.
- 🎨 **UI polish** — spacing, colors, charts, animation, making the terminal feel fast
  and pro-grade.
- 📊 **New frontend features** — order-ticket enhancements, position/PnL views, market
  stats, portfolio tools — anything that makes trading nicer.
- ⚡ **Performance** — fewer re-renders, faster loads, snappier interactions.

**Good first contributions:** improve a loading/empty state, fix a console warning, tidy
a component, add a tooltip, make a panel responsive, fix a mobile layout. Small, focused
PRs are perfect.

**Out of scope** (please don't PR these): on-chain program changes, the price keeper,
mainnet deployment, or anything requiring server secrets. This is **frontend, devnet-only**
— see [Guardrails](#13-guardrails).

---

## 2. Concepts (60-second glossary)

You don't need deep protocol knowledge to fix UI, but these terms show up everywhere:

- **Perp / perpetual** — a leveraged long/short position with no expiry.
- **Slab** — each market is a single big Solana account ("slab") holding the market
  config, engine state, and every trader's portfolio. A market == a slab address.
- **sim-USDC** — one test SPL token used as collateral across **all** markets (like USDC
  on a real perps DEX). Get it once from the faucet; trade any market with one balance.
- **AuthMark** — the on-chain price that trades **settle** against. It's derived from the
  market's mainnet DEX pool and pushed on-chain by the keeper.
- **Display price (Pyth)** — the continuously-ticking price shown in the UI (Pyth Hermes,
  like Hyperliquid's index price). It's ~0.1% from the AuthMark. **The UI ticks off Pyth;
  trades settle at the AuthMark. This is intentional — don't "fix" it.**
- **Keeper** — an off-chain service (maintainer-run) that reads mainnet DEX pools and
  pushes the AuthMark to the devnet markets. You never run it.
- **Position NFT** — you can "wrap" a position into a transferable NFT. Minting **escrows**
  the position into the NFT (it moves out of your portfolio into the NFT); burn the NFT to
  unwrap it. See the note in [Troubleshooting](#14-troubleshooting).
- **LP vault / stake** — liquidity + insurance mechanisms (the "Earn"/"Stake" pages).

---

## 3. How it fits together

```
   Browser (devnet wallet)
        │
        ▼
   Next.js app  (app/)  ────────────────►  Solana devnet
     ├─ its own /api routes                 (Percolator v17 programs,
     ├─ Pyth WS  → ticking display price      one "slab" account per market)
     └─ direct on-chain reads/writes                 ▲
                                                     │ AuthMark (the trade price)
                              maintainer's keeper ───┘
                                     ▲
                                     │ reads
                              mainnet DEX pools (Raydium / Meteora)
```

- The **programs are already deployed** on devnet — you never build or deploy them.
- A **maintainer runs the keeper**, so markets stay priced 24/7. Contributors don't run
  or need it.
- The **app** runs entirely on its own `/api` routes + on-chain reads + the local Pyth
  price feed. **No backend service, no secrets.**

---

## 4. Prerequisites

- **Node.js 20+** and **pnpm** (`npm i -g pnpm`).
- **git** and a **GitHub account** (to fork + PR).
- A Solana wallet browser extension — **Phantom** or **Solflare** — set to **Devnet**
  (Settings → Developer/Network → Devnet).

That's it. No Rust, no Solana CLI, no Docker.

---

## 5. Setup — clone and install

Just this one repo. The SDK (`@percolatorct/sdk`) installs from npm like any other
dependency — there's no second repo to clone and nothing to build.

```bash
# The playground lives on the `playground` branch (main is the marketing site)
git clone -b playground https://github.com/dcccrypto/percolator-launch.git
cd percolator-launch
pnpm install
```

`pnpm install` pulls the SDK for you. Requires **Node 20+** and **pnpm**.

---

## 6. Configure the app

Create **`app/.env.local`** with exactly this — it's all a contributor needs, no secrets:

```bash
# app/.env.local
NEXT_PUBLIC_DEFAULT_NETWORK=devnet
NEXT_PUBLIC_WS_URL=ws://localhost:8787
NEXT_PUBLIC_TEST_USDC_MINT=DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC

# Optional — your own free Helius devnet key (helius.dev) to skip the rate-limited
# public RPC. Leave blank to use the public devnet RPC.
HELIUS_DEVNET_API_KEY=

# Optional — leave blank. External indexer features (candles, 24h stats) degrade
# gracefully when unset. That's expected, not a bug.
NEXT_PUBLIC_API_URL=
```

Program IDs and market addresses are baked into `app/lib/config.ts`, so they're not in
your env.

---

## 7. Run it

Open **two terminals**, both in `app/`:

```bash
# Terminal 1 — live display prices (streams Pyth, no key needed)
pnpm dev:price-ws

# Terminal 2 — the Next.js app
pnpm dev
```

Open **http://localhost:3000**, connect a **devnet** wallet, and you'll see live markets
with ticking prices. That's a healthy setup. ✅ (Both terminals must be running for prices
to tick.)

---

## 8. Get test funds & place your first trade

You only need this if you want to actually trade (most UI work doesn't require funds):

1. Get **sim-USDC** on your devnet wallet from the hosted playground faucet — ask a
   maintainer for the link. Devnet balances persist, so you only do this once.
2. Open a market (e.g. SOL), **deposit** some sim-USDC in the order ticket.
3. Set a size + leverage, click **Long** or **Short**.
4. Watch the position appear in the positions panel; **close** it from there.

If a transaction fails, the UI surfaces the error — most are "insufficient funds" (get
more sim-USDC) or transient RPC hiccups (retry, or add your own Helius key).

---

## 9. Map of the app — where to work

Everything you'll touch is under **`app/`**:

```
app/
  app/                 Next.js app-router pages + the app's own API routes
    trade/[slab]/      the trade terminal (the main page)
    markets/           market browser        my-markets/  creator dashboard
    portfolio/         positions across markets   earn/  stake/  LP + staking
    faucet/  devnet-mint/  test-fund pages    analytics/ leaderboard/
    api/               the app's OWN backend routes (markets, prices, chart, faucet…)
  components/trade/     the trade UI (see below)
  hooks/               data reads + tx builders (see below)
  lib/                 config, math, formatters, price store
  scripts/local-price-ws-server.ts   the Pyth display-price feed
```

**Key trade components** (`app/components/trade/`):
`OrderTicket` (place trades) · `PositionsDock` / `PositionPanel` (open positions) ·
`TradingChart` (price chart) · `PositionNftPanel` (wrap/transfer/burn position NFTs) ·
`ClosePositionModal` · `TradeConfirmationModal` ·
`FundingRateCard` · `MarketStatsCard` · `EngineHealthCard` / `CrankHealthCard`.

**Key hooks** (`app/hooks/`):
`useSlab` / `SlabProvider` (raw market state) · `useUserAccount` (your position) ·
`useLivePrice` (ticking price) · `useTrade` (open) · `useClosePosition` ·
`useDeposit` / `useWithdraw` · `useMarketConfig` / `useMarketInfo` ·
`useMintPositionNft` / `useBurnPositionNft` / `useTransferPositionNft` /
`usePositionNft` / `useNftWrappedPosition` (position-NFT flow) ·
`useOracleFreshness` · `useTokenMeta` · `usePortfolio`.

**Key lib** (`app/lib/`):
`config.ts` (program IDs, RPC, network) · `trading.ts` (PnL, liq price, margin math) ·
`format.ts` (number/price formatters) · `oraclePrice.ts` · `priceStore/` (live-price
store + WS manager) · `nft-program.ts` · `errorMessages.ts`.

Rule of thumb: **components render, `lib/` and the SDK compute.** If you're writing math
in a component, it probably belongs in `lib/`.

---

## 10. Make a change (the dev loop)

```bash
# 1. Branch off main (never commit to main)
git checkout -b fix/short-description

# 2. Edit code under app/

# 3. Typecheck — must be 0 errors
cd app && npx tsc --noEmit

# 4. Run the unit tests
pnpm test

# 5. Verify in the browser (pnpm dev:price-ws + pnpm dev) with a connected devnet
#    wallet — click through the exact thing you changed. Types don't prove UX.

# 6. Commit, push, open a PR (see below)
```

**Definition of done:** `tsc` clean, `pnpm test` green, the changed flow works in the
browser, PR opened against `main`.

---

## 11. Code conventions

- **TypeScript strict** — no `any` escapes, no `@ts-ignore` without a reason.
- **Match the file you're editing** — naming, comment density, and structure. Read the
  neighbors before adding.
- **Components are pure formatters** — push math to `lib/trading.ts` or the SDK; don't
  inline `bigint` arithmetic in JSX.
- **Prefer SDK helpers** (`@percolatorct/sdk`) for instruction building and account
  parsing over hand-rolled byte layouts.
- **Tailwind** for styling; follow the existing dark-theme token classes
  (`var(--text)`, `var(--long)`, `var(--short)`, `var(--accent)`…).
- **Live price** comes from the shared store (`useLivePrice` / `lib/priceStore`) — don't
  open your own WebSocket.
- Keep PRs focused. One fix or feature per PR.

**Stack:** Next.js 16 (App Router) · React 18 · TypeScript (strict) · Tailwind 4 ·
Solana Wallet Adapter · `@percolatorct/sdk` · SWR · Vitest.

---

## 12. Open a pull request

Standard GitHub **fork → branch → PR** flow:

```bash
git checkout -b fix/short-description
# … changes, tsc clean, tests green, verified in the browser …
git commit -m "fix(trade): what changed and why"
git push origin fix/short-description
gh pr create --fill --base main    # or open the PR in the GitHub UI
```

**A good PR:** one focused change, a clear description of what and why, how you tested it,
and a screenshot/GIF for anything visual.

**CI that runs on your PR** (see `.github/workflows/`):
- **Test Suite** (`test.yml`) — builds the SDK + app and runs the Vitest suite
  (`pnpm --filter app test`). **This is the gate — make it green.**
- **PR Check** (`pr-check.yml`) — builds the packages + the app.

Run `npx tsc --noEmit` and `pnpm test` locally before pushing so CI passes first try.

---

## 13. Guardrails

- ✅ **Frontend + devnet only.** Everything you need is in `app/`.
- ❌ **Don't** change or redeploy the on-chain programs (that's a separate, gated repo).
- ❌ **Don't** commit secrets — no API keys, no keypairs. `.env.local` is gitignored;
  keep it that way. Never hardcode keys in tracked files.
- ❌ **Don't** run or depend on the keeper/faucet locally — those are maintainer-run.
- ❌ **Don't** push to `main`, `npm publish`, or `vercel deploy`.
- ❌ **Don't** switch the app to mainnet "to test." Devnet only.
- ✅ **Do** treat the external indexer API as optional — candles / 24h stats / ADL rank
  show empty locally, and that's expected. Not a bug to chase.

---

## 14. Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm install` fails fetching `@percolatorct/sdk` | Transient registry/network hiccup — re-run `pnpm install`. The SDK is a normal npm dependency (no separate clone). |
| Prices don't move in the UI | Start `pnpm dev:price-ws` too, and make sure `NEXT_PUBLIC_WS_URL=ws://localhost:8787` is in `app/.env.local`. Both terminals must run. |
| RPC errors / "rate limited" | Add your own free `HELIUS_DEVNET_API_KEY=<key>` to `app/.env.local`. |
| Wallet won't connect / wrong network | Set the wallet extension to **Devnet**. |
| Can't trade — "insufficient funds" | Get sim-USDC from the hosted playground faucet (ask a maintainer). Devnet balances persist. |
| Candles / 24h stats / ADL show empty | Expected — those come from an optional external indexer the local playground doesn't run. Not a bug. |
| A position vanished after I minted a Position NFT | Expected — minting **wraps (escrows)** the position into the NFT. It shows in the positions panel marked "🎫 NFT"; burn the NFT to unwrap it. |
| `tsc` errors after `git pull` | Re-run `pnpm install` (the SDK or deps may have changed). |

---

## 15. Quick reference

- **Cluster:** Solana **devnet** only.
- **Collateral:** sim-USDC `DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC` (6 decimals).
- **Programs** (in `app/lib/config.ts`):
  - wrapper `69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9`
  - matcher `4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT`
  - nft `5TnritLtHS76s5iV8axqDmqhcmJKMRUekMGrk9rBTqSP`
  - vault/stake `51CeUNpbXovK2BRADPyssuf3Q1xWGabEK9pYkp5mqVhQ`
- **Live markets** (devnet slabs) — 2026-07-10 born-immortal re-seed (both backing-bucket
  domains seeded to a non-lapsing expiry via TopUpBackingBucket, fixing the freshness-
  deadlock that could brick a market after an idle gap):
  - SOL `7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV`
  - JUP `B22quVNFuuEYwx4dQigwn41BMBuk9ZcTdMik4UH7PshY`
  - TRUMP `6Hqn4VoMHjvCb1XWQkpnJ1UE3xAverJezVdk3czvgQxh`
  - PENGU `Gbpuam5UYV4MpC1DmGeTVZWtT4UGDmahMW2vo4p1MBAf`
  - BURNIE `GPpyVaHAEJ8u6W9UAyCPp6tuQB2Chm1Z6uLUKA9ePJBC`
  - Percolator `FGaUkXepxCggbmpbgXDWUZ3V2CGSh6MeDCU6KLTLShbH`
- **Common commands** (from `app/`): `pnpm dev` · `pnpm dev:price-ws` ·
  `npx tsc --noEmit` · `pnpm test`.

Thanks for contributing! 🎉
