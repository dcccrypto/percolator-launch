# r3 HTTP-level load through POST /api/v1/orders (round 3, lane f2)

Server: `next start -p 3971` of the f2 worktree build (BOT_API_ENABLED=1, devnet, v2.2), keys in the process map, one key seeded with the
local-only `BOT_API_DEV_SEED_KEY` (refused on VERCEL / Upstash). Driver: `app/scripts/bot-api/loadtest.ts --mode http`. Market D82VLwS9 (fresh oracle),
owner 4XBUxkvp (has a portfolio there, from seats/trader/portfolio-owners.txt). Nothing was signed or sent; builders only simulate. Code: commit 488048ccd (+ one
untracked-build artifact, hence `dirty:true` in the first JSON; next-env.d.ts, reverted).

## Run A: surfpool fork of devnet as the simulating RPC (r3-http-surfpool.json)
surfpool 18899/18900 forking devnet (lazy account fetch). Surfpool answers getProgramAccounts only for accounts it already holds, so a small local proxy
forwarded getProgramAccounts (cached 120 s, 14 real calls total) to public devnet and everything else (getAccountInfo, getLatestBlockhash,
simulateTransaction, getSlot...) to surfpool. Mix read 30 / quote 20 / build 50, 1 rps, 90 s, concurrency 2.

- 90 requests, throughput 0.99 rps, 5xx/transport error rate 0.00.
- All requests: p50 83.9 ms, p95 147.5 ms, p99 197.0 ms.
- read 19x200 p50 5.0 / p95 59.6 ms; quote 22x200 p50 6.9 / p95 21.2 / p99 33.8 ms.
- build 49 requests, ALL 422 `simulation_failed` Custom(8003) raised by the matcher program (DfTx...) on the fork (about 2k CU in; same on every fresh market): p50 88.2, p95 150.9, p99 197.0 ms.
  So the full build path (auth, limit, idempotency, market and LP scans, BPF simulation on a real simulator, decode, envelope) ran, but the fork's clock/matcher
  state is not the live devnet's, so no clean 200 builds came out of this run. Treat the build latency as the simulating-RPC floor with warm accounts, not as devnet latency.

## Run B: public devnet (the app's default devnet endpoint, nothing set on the command line), builds at <= 0.2 rps (r3-http-public-devnet.json)
Mix read 20 / quote 20 / build 60, 0.2 rps, 120 s, concurrency 1.

- 24 requests, throughput 0.20 rps, 24 x 200, error rate 0.00, non-2xx 0.00.
- All: p50 159.4 ms, p95 367.3 ms, p99 460.6 ms.
- read 5x200 p50 68.6 ms; quote 8x200 p50 91.5 / p95 166.7 ms; build 11x200 (clean simulations through the /v1 route) p50 295.1 / p95 460.6 / p99 460.6 ms (max 460.6).
- Caveat: tiny sample and a quiet moment. Earlier today's direct-builder runs on the same endpoint saw 6-12 s builds and many rpc_unavailable under its throttling, so
  this is a best case; the route's 20 s deadline and the short 429 retries were not exercised.

Cleanup: surfpool, the proxy and both next servers were stopped by PID; ports 18899/18900/18901/3971 are free; no key material was printed or saved.
