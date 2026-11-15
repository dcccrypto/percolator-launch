# Bot API load test (stage D, 71496cd68), local only

a1 in-process handlers, mock RPC (fixtures), conc 128, 30,000 req, 50 throwaway mm keys, mix read 60 / quote 30 / account 2 / build 8
  1,689 rps over 17.8 s; error rate 0 (5xx/transport); 27,616 x 200, 300 x 409 no_portfolio (mock cannot simulate), 2,084 x 429 global build ceiling (300/min, by design)
  p50 61 ms, p95 129 ms, p99 150 ms (reads 57/70/92, quotes 116/139/161); queueing on one Node thread
a2 same, conc 16, 10,000 req: 1,215 rps, error rate 0, p50 10.5 ms, p95 27 ms, p99 52 ms
a3 next start (prod build) :3917 + mock RPC, conc 32, 8,000 req reads+quotes, anon (XFF rotated over 800 addrs, TRUSTED_PROXY_DEPTH=1)
  695 rps, 8,000 x 200, p50 42 ms, p95 69 ms, p99 82 ms (client shares the CPU)
b  next start against public devnet RPC, conc 2, 80 req paced 0.5 rps, reads+quotes, anon
  0.47 rps, error rate 26% (59 x 200, 21 x 503 rpc_unavailable from devnet 429s), p50 1.8 s, p95 8.0 s, p99 13.6 s
  reads 42/50 ok p50 0.62 s; quotes 17/30 ok p50 7.9 s
  -> public devnet RPC is not usable for bots; needs a dedicated RPC (not set up: no new paid services)
No builds against devnet in the load test (separate simulate-only run: scripts/bot-api/sim-live.ts, out/stageC-sim-live.txt).
