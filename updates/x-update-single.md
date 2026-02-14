# Twitter Post — Percolator Update (Feb 13-14)

---

Percolator devnet update — Feb 13-14:

Shipped real-time trade indexing via Helius webhooks. Completely replaced the polling TradeIndexer with webhook-driven ingestion. When a trade happens on-chain, Helius hits our endpoint, we parse the transaction data, validate it, and write it straight to Supabase. Instant detection, significantly lower RPC usage, and actually scalable infrastructure. The old polling system was hitting RPC every few seconds checking for new trades. This is event-driven and only processes what actually happened.

StatsCollector service is now running on Railway. Every 30 seconds it queries all active markets and updates volume_24h, last_price, and price_change_24h in the database. Oracle prices get tracked separately every 60 seconds. Fully automated pipeline — market_stats and oracle_prices tables populate without any manual intervention. Migration 005 aligned the database schema with what the backend was actually writing. 51 out of 54 markets updating cleanly. The three failing markets have FK constraint issues (missing from the markets table), but that is a data cleanup issue, not a code problem.

Built a global USD/token toggle that works across the entire platform. Markets page, trade page, position panel, pre-trade summary — everything respects the toggle state. UsdToggleProvider context component syncs the state, and every component just hooks into it with useUsdToggle. No prop drilling, no duplicate state. Clean implementation.

Added proper trading charts with candlestick view and multiple timeframes (1m/5m/15m/1h/4h/1d). Volume bars show underneath the price chart. Crosshair tooltip displays OHLCV data when you hover. Built with lightweight-charts library — same core tech TradingView uses but way lighter on the frontend bundle. Backend serves price history via /prices/{slab}/history endpoint. Frontend calls it through a Next.js API rewrite that proxies to the Railway backend. Had to fix timestamp handling (backend sends milliseconds, frontend was incorrectly multiplying by 1000 again). Chart scaling now handles stable prices correctly — no more diagonal lines when price barely moves.

Fixed 14 bugs this sprint. Security patches: decimal overflow exploit (token decimals validation), margin precision truncation (safe BigInt math), integer overflow in exponentiation (BigInt guard), invalid market configurations (block fee >= margin). UX improvements: loading states on trade page, mobile table alignment and overflow, blank flash on admin page refresh, missing token names on admin page, LP capital warnings when liquidity is insufficient. Infrastructure cleanup: oracle API URL configuration, Supabase .temp files committed to git (gitignore fix), unused imports and event listener leaks, non-authority oracle log noise reduction.

37 commits over two days. +4,311 lines added, -1,796 lines deleted. 117 files touched across frontend, backend, database migrations, and test suites. 10 PRs merged in this sprint alone. 167 PRs merged total since the project started. All CI checks passing — E2E tests, integration tests, unit tests, TypeScript strict mode, ESLint. CodeRabbit approved every PR. Vercel deployments green.

14,500+ cranks executed on devnet with zero failures. Trade matching engine and liquidation service running continuously. Railway backend health endpoint confirms all services operational: RPC connected, crank service active, liquidation service active, StatsCollector running, Helius webhook listener processing events.

Pump.fun hackathon submission deadline is February 18. Applying for 250K at 10M valuation. Had a call with the team earlier this week — went well. Devnet is production-ready at this point. Real-time trade indexing works, live market stats populate automatically, professional charts render correctly, database pipeline is solid, and security vulnerabilities are patched.

Mainnet prep checklist: set up RPC proxy infrastructure, acquire roughly 5 SOL for initial market deployments, run final security audit on the program code. After that, we ship.

Try the devnet build: https://percolator-launch.vercel.app

This is what building in public looks like. Ship fast, fix bugs faster, keep cranking.
