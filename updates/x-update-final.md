# Twitter Post — Percolator Update (Feb 13-14)

---

Percolator devnet update:

Shipped real-time trade indexing with Helius webhooks. Replaced polling with event-driven ingestion — trades write straight to Supabase the moment they happen on-chain. Lower RPC usage, instant detection, actually scalable.

Added StatsCollector service running on Railway. Updates market data every 30 seconds (volume, last price, 24h change). Oracle prices tracked every 60 seconds. Fully automated pipeline.

Built global USD/token toggle across the platform. Markets page, trade page, positions — everything synced through a single context provider.

Shipped professional trading charts. Candlesticks with 1m/5m/15m/1h/4h/1d timeframes, volume bars, OHLCV tooltips. Built with lightweight-charts — same tech as TradingView.

Fixed 14 bugs: decimal overflow exploits, margin precision issues, mobile UI alignment, loading states, invalid market configs. Security patches and UX polish.

37 commits, +4,311/-1,796 lines across 117 files. 10 PRs merged this sprint, 167 total. 14,500+ cranks on devnet, zero failures.

Pump.fun hackathon deadline Feb 18. Applying for 250K at 10M. Devnet is production-ready. Mainnet soon.

Try it: https://percolator-launch.vercel.app
