# Percolator v17 Playground — Master Launch & Fix Plan (2026-07-08)

Synthesized from a verify-and-plan workflow (7 of 11 area passes completed; 4 agents failed
the output schema — **stake/earn, keeper-oracle, downstream-display, failure-recovery are
under-covered here** and their items below come from the other passes + prior findings).
Ground truth: proven `launch-test-market.ts` (8/8 on devnet) + `newmarkets.ts`, the
app-resolved SDK, and live on-chain reads. **Nothing is blocked by the re-seed except M6.**

---

## 1. LAUNCH A MARKET — the correct end-to-end spec

### Definitive sequence (keeper-priced devnet market). Wizard maps to it ONLY in `oracleType="keeper"` mode.

| Phase | What happens | Status |
|---|---|---|
| Step 0 (atomic) | createAccount(slab) + createATA(vault) + InitMarket. admin=creator ⇒ marketauth=creator | Correct (nits: dummyAta M18, seed) |
| Step 1 (keeper) | keeper-cosign ⇒ ConfigureAuthMark(mode=3) + UpdateAssetAuthority(Oracle→keeper); SetNftProgramId | **Delegation target broken on Vercel (C1)** |
| Step 2 | LP portfolio + InitUser; matcherCtx (matcher-owned); SetMatcherConfig; InitMatcherCtx(tag 83)→WRAPPER w/ matcher as ACCOUNT | **CORRECT — do not "fix"** |
| Step 3 | DepositCollateral(LP) [+TopUpInsurance +crank] | Atomic bundle risk (H9); no idempotency (M16) |
| Step 4 | CreateLpVault (marketauth-gated) | Correct |
| Step 5 | Stake InitPool — LAST gated call; rotates marketauth creator→stake PDA | **CORRECT ordering** |
| Off-chain | POST /api/markets + /api/playground/keeper-register (pool↔slab binding) | dexType broken (C3); unauth (H1); wrong-pool (H2) |
| Priced | keeper register-poll picks up the slab from the Blob + PushAuthMark | **Keeper never polls (C2)** |

### Already CORRECT (verified — do NOT touch)
Sim-USDC collateral @6dp (mirror-mint removed) · InitMatcherCtx tag 83 → wrapper · marketauth
rotation ordering · pre-fund permits Sim-USDC w/o Supabase · keeper-cosign ConfigureAuthMark +
delegate · trade/deposit/withdraw tx-build.

### Why a fresh wizard launch dies today — 3 INDEPENDENT reasons (C2 was a false alarm):
1. **C3** — `dexType` sent to keeper-register is the raw DexScreener id (`raydium`/`meteora`), which the route 400s → binding silently dropped. [frontend]
2. **C4** — wizard defaults `oracleType='admin'` → never sets oracle_mode=3 / delegates → nothing can push a price. Only `keeper` mode works on devnet. [frontend]
3. **C1** — `PLAYGROUND_KEEPER_KEYPAIR` unset on Vercel → keeper-cosign delegates oracle_authority to the mint-authority key, not the keeper → keeper's pushes are skipped (no live price). [config] (Does NOT hit the accrue cliff — crank still runs.)
~~C2~~ — **register-poll is WORKING** (verified live). Not a blocker.

**No wizard-created v17 market has ever been proven 8/8 on-chain — only the scripts are.** One
devnet dry-run of the wizard (keeper mode, after C1/C3/C4) validates dummyAta + Step-3 bundle + seed.

### KEEPER VERDICT (deep-dive 2026-07-08) — the re-seed is SAFE
The current keeper (500ms push / 20s crank) is **empirically proven safe**: BONK+PENGU cranked 8h /
1470+ cycles / **0 reverts**, sitting at a 2-4 slot gap vs the 500-slot cliff (10× margin). **SOL/JUP/
TRUMP died from the PRIOR un-hardened keeper (2026-07-06 outage) — they were already dead the instant
this process booted, not an ongoing cadence problem.** Re-seeding onto the current keeper+config keeps
fresh markets alive. Recovery-cranker correctly has no auto-fix (deadlock is un-crankable → re-seed is
the only cure, matches premise); stuck markets only simulate (no wasted on-chain tx).

### KEEPER KEEP-ALIVE CHECKLIST (run right after re-seed)
1. Confirm new slabs land in `registry.json` (watch `[register-poll] added …`, or add manually).
2. **CRITICAL gotcha:** watch the first crank cycle per new market for `[cranker] {label}: discovered LP portfolio …`. If it logs `no LP-vault portfolio found yet`, that market gets ZERO cranks until `DISCOVERY_RETRY_MS = 5min` later — LONGER than the ~200s cliff → it can go stale before the 2nd attempt. **Do NOT let a market trade until this line appears.**
3. `curl localhost:3002/health` → confirm `authorityMismatch:false` per new market (else it's the C1 case: cranks but no price).
4. After 60-90s, re-check `live_slot - asset.slot_last` is single/low-double digits, not climbing.
5. If registry >~10-15 markets: apply M1 (chunk pushes ≤12/tx + getMultipleAccounts ≤100) + C7 (parallelize crank loop) FIRST.
6. Keep the watchdog running + Mac mini awake — a single >200s all-crank outage kills every market at once.

---

## 2. Prioritized roadmap (deduped, by layer)

### CONFIG / OPS
- **C1** [broken — WIZARD markets only; 5 seeded markets are FINE] Set `PLAYGROUND_KEEPER_KEYPAIR` in Vercel prod = the IDENTICAL 64-byte JSON at `~/.config/solana/percolator-v17-devnet.json` (keeper `FbTbDeGW…`). Without it, keeper-cosign falls back to the mint-authority key → wizard markets get the wrong `oracle_authority` → keeper pushes skipped (`authorityMismatch:true`). NOTE: a C1-broken market still gets CRANKED (PermissionlessCrank is permissionless) so it does NOT hit the 500-slot cliff — it just never gets a live price. (`playground-keeper-signer.ts:34`)
- **C2** [✅ CONFIRMED WORKING — plan was STALE] register-poll IS running. `REGISTER_SOURCE_URL`+`REGISTER_POLL_INTERVAL_MS` are set via `start-keeper.sh` (the actual launcher; `.env` is never loaded — no dotenv). Boot log shows `[register-poll] starting`, endpoint returns `{"markets":[]}`. Only risk: wiring lives in the shell script, not `.env` → lost if the keeper is ever started another way. Belt-and-suspenders: also add the vars to `.env` + a boot-time WARN if unset.
- **C7** [new — pre-scale] Crank loop is SEQUENTIAL (`recovery-cranker.ts:346`) → cycle time scales linearly with market count; at 30-50 markets a single cycle could approach the 200s cliff budget. Parallelize with `Promise.allSettled`. Do before re-seeding >~10-15 markets; not urgent at N=5.
- M4 [at-risk] Rate-limit/faucet gates degrade to per-instance (Upstash+Supabase unset) → mint-authority SOL drainable. Attach Vercel KV/Upstash.
- M5 [at-risk] `NEXT_PUBLIC_HELIUS_WS_API_KEY` unset → WS falls back to public devnet (reconnect churn).
- **M6** [at-risk, RE-SEED] Bake `playground-slab-meta.ts` update + Blob purge + CLAUDE/PLAYGROUND doc sync into the re-seed runbook.

### KEEPER
- **M1** [at-risk] Batch PushAuthMark packs ALL markets in ONE tx (~15-20 ceiling) + uncapped getMultipleAccounts (100). Chunk ≤12/tx + ≤100/req. (latent while registry small)

### API ROUTES
- **H1** [broken] keeper-register unauthenticated + unbounded (sole market↔pool binding). Require on-chain proof (slab oracle_authority==keeper); cap ≤100 + eviction.
- **H2** [at-risk] keeper-register returns registered:true for wrong dexType/unpriceable pool. Server-side fetch pool owner + detectDexType; reject if null.
- **H3** [broken] devnet-pre-fund rate gate fires BEFORE balance check → 429 on 2nd call/retry kills launch. Read balance first; 200 no-op if sufficient; single whole-flow mint.
- M2 [at-risk] Non-atomic registry-Blob RMW drops concurrent registrations. etag/If-Match CAS.
- M3 [at-risk] Vestigial devnet-airdrop call in wizard (Supabase-hard, confusing errors). Remove.
- M13 [broken] /api/stats skips every v17 account → all-zeros. Add v17 OI path like /api/markets.

### FRONTEND — launch wizard
- **C3** [broken] `dexType` = raw dexId not hyphenated → keeper-register 400. Derive via detectDexType(pool.owner) at launch.
- **C4** [broken] default `oracleType='admin'` → dead market. On devnet default/force `keeper`; disable admin/pyth/hyperp.
- **H9** [at-risk] Step 3 bundles TopUpInsurance + FeeSweep atomically with load-bearing LP DepositCollateral. Send deposit alone; topup/crank separate non-fatal.
- M16 [broken] Step 3 retry re-deposits/re-tops (one-way). Read balance first; idempotent.
- M17 [broken] Cross-session resume restarts Step 1 → SetNftProgramId reverts AlreadyInitialized. Skip if nft_registry PDA exists.
- M18 [at-risk] InitMarket account[8] dummyAta=vaultPda (PDA, not token acct). Pass creator's collateral ATA.
- L: unneeded 500-USDC seed transfer · cost estimate under-count (~0.066 SOL) · retry regenerates slab keypair · Step-3 LP lookup GPA offset 80 [0].

### FRONTEND — trade / portfolio / positions / NFT
- **H4** [broken] `estimateEntryFromPnl` uses ×oracle where it must use ×1e6 (pnl is COLLATERAL atoms) → clamps entry→mark. **ROOT of cache-miss cluster.** `diff = pnl*1e6/absPos` + unit test.
- **H5** [broken] Cache-miss/wrapped positions double-scale PnL (~×price); /portfolio has no entry fallback → wrapped show green "safe". After H4, uniform computeMarkPnl + estimateEntryFromPnl fallback.
- **H6** [broken] No ENGINE-accrue-staleness guard in trade UI → users submit doomed trades on stale-locked markets. Parse header.current_slot vs getSlot(); block submit. (threshold calibrates on live keeper)
- **H7** [broken] Oracle-stale guard DEAD for keeper-mode markets (every live one). Add `'keeper'` to the mode set (OrderTicket/PositionsDock/PositionPanel).
- **H8** [broken] No EmergencyBurn — closed/liquidated wrapped NFT reverts LegNotActive → funds+rent stranded. Add encodeNftEmergencyBurn.
- M7 withdraw not gated to FREE margin · M8 OrderTicket liq before/after · M9 v17/v12 detection defaults v12 on fetch fail · M10 multi-portfolio unsorted [0] · M11 AccountsCard empty on v17.
- L: EngineStale auto-retry (→H6) · NFT identity conflate · partial-close fabricated release · Mint escrow warning.

### FRONTEND — market data / health / stats / funding
- **H10** [broken] Dashboard ProtocolStatsBar $0 under green "live" (Supabase). Rewire to /api/markets.
- **H11** [broken] my-markets shows 0 OI/vault/insurance + false "healthy" on v17. parseMarketGroupV17OI + slot-age health.
- **H12** [broken] OpenInterestCard base-token OI labeled "$" (no ×price), fake $5M cap, $0 LP Net. (oiQ/1e6)×price; remove cap.
- M12 EngineHealthCard/LiquidationAnalytics price-biased coverage; insurance wrongly ×price · M14 markets-list can't detect stalled keeper · M15 StatsBar fabricated Fee Tier · **M19** funding shown "live" but maxAbsFundingE9PerSlot=0 everywhere → honest "Funding: Off".
- L: MarketInfoBar OI "$" when price null · dashboard funding sign→color inverted · DashboardHeader "$"/negative equity.

### Already done / in-flight — DO NOT REDO
v17 config:{} crash (fixed, deployed) · funding field-mapping (landed `d9e9429a`) · ROE÷initial-margin + maint-bps (reconciled) · Sim-USDC "mintAddress not permitted" (fixed).

---

## 3. Sequencing

**Wave A — unblock a fresh wizard launch (FIRST, no re-seed):**
1. C1 — set `PLAYGROUND_KEEPER_KEYPAIR` in Vercel prod = keeper key (minutes) — needs the secret
2. C3 + C4 — frontend deploy: derive dexType from pool owner; default/force keeper mode
3. H1 + H2 — secure keeper-register (same API deploy)
→ then ONE wizard dry-run in keeper mode end-to-end (never been proven 8/8).
(C2 dropped — register-poll already works.)

**Wave B — correctness deploy (frontend, no re-seed, ship together):**
H4→H5 (collateral-scale root + uniform PnL, with unit test) · H6+H7 (staleness guards) · H8
(EmergencyBurn) · H9+M16+M17+M18 (wizard robustness) · H10+H11+H12+M12+M13+M15+M19 (kill fabricated/zeroed stats + funding-is-live illusion) · remaining M/L as capacity allows.

**Wave C — scale & abuse hardening (before opening /create widely):**
M1 (keeper chunking) + M2 (registry CAS) + M4 (KV rate limits) + M5 (Helius WS key).

**Re-seed unblocks only M6** (slab-meta update + Blob purge + doc sync). The re-seed itself is
correct by construction (newmarkets.ts: admin==keeper, writes registry.json).

---

## 4. Open decisions
1. **Is the public /create wizard a launch goal, or is launch just the operator re-seed?** If wizard must work for users → Wave A mandatory. If not → gate /create behind a maintainer flag, deprioritize.
2. **Funding: keep OFF + make UI honest (recommended) or enable?** Recommend keep off (enabling adds an unvalidated accrue path that interacts with the staleness-lock). Then pick presentation: global "Funding disabled" banner (cheap) vs per-market "Off".
3. **Supabase: decouple fully (recommended, cheap) or restore?** Everything launch/trade-critical already degrades. Drives whether stats point at /api/markets vs reattach indexer (leaderboard/24h volume depend on it).
4. **Rate-limit/abuse: attach Vercel KV/Upstash now or accept unbounded test minting?** Only real risk = draining mint-authority SOL. Drives M4 in Wave B vs C.
5. **Keeper cadence:** confirm the re-seeded keeper cranks (accrue) every market it pushes on the same cadence. If push/crank diverge, H6 is load-bearing. Add self-check: warn if resolved keeper ≠ FbTbDeGW or register-poll disabled.
6. **AccountsCard on v17 (M11):** honest "not available" empty state now, or a getProgramAccounts per-market scan for a real leaderboard?
