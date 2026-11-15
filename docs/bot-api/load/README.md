# Bot API load numbers (raw files)

The raw reports behind the load figures in `docs/ideas/bot-trading-rails.md` section 3.7. Copied unchanged from the
build sessions' output folders on 15 Nov 2026. Checked before committing: no API keys, no credentials, and no RPC URL
carrying a key in any file (the only URLs are `127.0.0.1` targets; the addresses are public devnet market and wallet
addresses). The JSON files are what `app/scripts/bot-api/loadtest.ts` prints.

Nothing in any run signed or sent a transaction. Builders only simulate.

## Which RPC each run used

| File | RPC behind the API | What it measures |
|---|---|---|
| `r3-http-public-devnet.json` | **public devnet** (the app's default devnet endpoint) | real end-to-end latency through `next start` and HTTP, builds included |
| `r3-http-surfpool.json` | **surfpool** fork of devnet (local simulator; getProgramAccounts proxied to public devnet) | the full build path on a real BPF simulator; every build was refused by the matcher on the fork, so build latency is a floor |
| `lt-build.json`, `lt-build-burst.json` | **mock** RPC (recorded fixtures, `app/scripts/bot-api/mock-rpc.ts`) | the API layer's own cost and throughput; also the RPC calls per build |
| `loadtest.md` | **mock** RPC (a1, a2, a3) and **public devnet** (b) | stage D summary; numbers as text, the JSON was not kept |
| `r3-load.md` | surfpool and public devnet | the notes for the two r3 runs above (setup, caveats) |

## Numbers

Latency in ms. Error rate = transport failures + 5xx (4xx coded refusals are not errors; see `non2xxRate` in the JSON).

| Run | RPC | Requests | Throughput | p50 | p95 | p99 | Error rate | Notes |
|---|---|---|---|---|---|---|---|---|
| r3 public devnet, all | public devnet | 24 | 0.20 rps (paced) | 159.4 | 367.3 | 460.6 | 0.00 | 24 x 200 |
| r3 public devnet, builds | public devnet | 11 | (part of the above) | 295.1 | 460.6 | 460.6 | 0.00 | 11 x 200 clean simulations; tiny sample, quiet minute: a best case |
| r3 surfpool, all | surfpool fork | 90 | 0.99 rps (paced) | 83.9 | 147.5 | 197.0 | 0.00 | 41 x 200, 49 x 422 |
| r3 surfpool, builds | surfpool fork | 49 | (part of the above) | 88.2 | 150.9 | 197.0 | 0.00 | all 422 simulation_failed Custom(8003) from the matcher on the fork: a floor, not devnet latency |
| e2 build-heavy paced | mock | 600 | 9.76 rps | 1.9 | 7.7 | 9.6 | 0.00 | 600 x 200; builds 272: p50 6.3 / p95 8.9 / p99 15.0 |
| e2 build-only burst | mock | 280 | 157.9 rps | 185.4 | 452.6 | 618.3 | 0.00 | 280 x 200, under the 300/min global build ceiling |
| stage D a1 | mock | 30,000 | 1,689 rps | 61 | 129 | 150 | 0 | conc 128; 2,084 x 429 from the global build ceiling (by design) |
| stage D a2 | mock | 10,000 | 1,215 rps | 10.5 | 27 | 52 | 0 | conc 16 |
| stage D a3 | mock, via `next start` | 8,000 | 695 rps | 42 | 69 | 82 | 0 | reads + quotes |
| stage D b | public devnet | 80 | 0.47 rps (paced 0.5) | 1,800 | 8,000 | 13,600 | **0.26** | 21 x 503 rpc_unavailable from devnet 429s; reads + quotes only |

Reading them: the API layer itself is cheap (single-digit ms per request on the mock). Real latency is the RPC's.
Public devnet is fine at a trickle (r3) and fails under modest load (stage D b, 26% errors): a bot deployment needs a
dedicated RPC.

## RPC cost per build

About **12 RPC calls per build**, measured on the mock: `lt-build-burst.json` has 3,378 mock RPC requests for 280 builds
(12.1 per build); the council operator seat measured 1,205 for 100 builds. At the global build ceiling
(`GLOBAL_BUILD_BUDGET` = 3,000 weight per minute = 300 builds per minute, `app/lib/bot-api/limits.ts`) that is about
3,600 RPC calls per minute (about 60 per second) from builds alone, on the same RPC the app uses, before any reads. The
ceiling is not derived from an RPC quota; set it from the RPC plan's quota divided by 12, minus headroom for the app,
before turning the API on for real traffic.

## Where each came from

| File | Commit | Command |
|---|---|---|
| `r3-http-public-devnet.json` | `488048ccd` (dirty: false) | `npx tsx loadtest.ts --mode http --base http://127.0.0.1:3971 --market D82VLwS9PjGBHBTa6D4BaWwAgF9TFe42qXz1idh46pSN --owner 4XBUxkvpmiKDkx9iW5NFLvyRcY89Q9ujF8rXNkCr7dv6 --concurrency 1 --rps 0.2 --duration 120 --warmup 1 --mix read=20,quote=20,build=60 --label r3-public-devnet-http-builds` (in the JSON) |
| `r3-http-surfpool.json` | `488048ccd` (dirty: true, one untracked build artifact, see `r3-load.md`) | `npx tsx loadtest.ts --mode http --base http://127.0.0.1:3971 --market D82VLwS9PjGBHBTa6D4BaWwAgF9TFe42qXz1idh46pSN --owner 4XBUxkvpmiKDkx9iW5NFLvyRcY89Q9ujF8rXNkCr7dv6 --concurrency 2 --rps 1 --duration 90 --warmup 3 --mix read=30,quote=20,build=50 --label r3-surfpool-fork-http` (in the JSON) |
| `lt-build.json` | `44f4cf6e0` (from its label; this run predates the sha/command fields) | not recorded; label "e2 build-heavy paced 10rps": inproc, mock RPC, concurrency 16, 20 keys, mix read 30 / quote 20 / account 10 / build 40, pacing 10 rps |
| `lt-build-burst.json` | `44f4cf6e0` (same session) | not recorded; label "e2 build-only unpaced burst 280": inproc, mock RPC |
| `loadtest.md` | `71496cd68` (stage D) | flags are in the file (concurrency, request counts, mix); the exact command lines were not kept |

To reproduce on the mock: see the usage block at the top of `app/scripts/bot-api/loadtest.ts`
(`--mode inproc --rpc mock`). Newer runs print `sha`, `dirty` and `command` into the JSON (`app/scripts/bot-api/provenance.ts`).
