# Twitter Thread — Percolator Update (Feb 13-14)

---

## Tweet 1

Percolator devnet update:

Shipped real-time trade indexing via Helius webhooks. Completely replaced the polling TradeIndexer with webhook-driven ingestion. Helius hits our endpoint, we parse the transaction, write straight to Supabase. Instant detection, lower RPC usage, actually scalable.

StatsCollector service now running on Railway. Hits every market every 30 seconds to update volume, last price, 24h change. Oracle prices tracked separately every 60 seconds. All automated.

---

## Tweet 2

Built a global USD/token toggle that works across the entire platform. Markets page, trade page, position panel, pre-trade summary — everything respects the toggle. UsdToggleProvider context syncs state, every component just hooks into it.

Database pipeline is solid now. market_stats and oracle_prices tables have proper FK constraints to the markets table. Migration 005 aligned the schema with what StatsCollector was actually writing. 51 out of 54 markets updating cleanly.

---

## Tweet 3

Added proper trading charts. Candlestick view with 1m/5m/15m/1h/4h/1d timeframes. Volume bars underneath, crosshair tooltip shows OHLCV data. Built with lightweight-charts library — same tech TradingView uses but way lighter on the frontend.

Backend serves prices via /prices/{slab}/history endpoint. Frontend calls it through a Next.js rewrite to the Railway API. Timestamps were a mess (backend sends milliseconds, frontend was multiplying by 1000), fixed that. Scaling handles stable prices correctly now.

---

## Tweet 4

Fixed 14 bugs this sprint:

Security: decimal overflow exploit, margin precision truncation, integer overflow in exponentiation, invalid market configs.

UX: loading states on trade page, mobile table alignment, blank flash on admin refresh, missing token names, LP capital warnings.

Infrastructure: oracle API config, Supabase temp files in git, event listener leaks, non-authority oracle log noise.

---

## Tweet 5

37 commits over the last two days. +4,311 lines added, -1,796 deleted. 117 files touched across frontend, backend, database migrations, tests.

10 PRs merged in this sprint. 167 PRs total since we started building.

14,500+ cranks executed on devnet. Zero failures. Trade matching, liquidations, everything running smooth.

---

## Tweet 6

Comprehensive test coverage. Helius webhook indexer has mocked webhook payload tests. E2E/Integration/Unit suites all passing on CI. TypeScript strict mode, ESLint clean, CodeRabbit approved every PR.

Railway backend health endpoint shows all services operational. RPC connected, crank service running, liquidation service running, StatsCollector running, Helius webhook listener active.

---

## Tweet 7

Pump.fun hackathon submission deadline is Feb 18. Applying for 250K at 10M valuation. Had a call with the team, went well.

Devnet is production-ready. Everything works. Real-time indexing, live stats, professional charts, solid database pipeline, security patched.

Mainnet prep: RPC proxy setup, about 5 SOL for initial market deploys, final security audit. Then we ship.

Try the devnet build: https://percolator-launch.vercel.app
