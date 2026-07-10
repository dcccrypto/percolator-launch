# Percolator v17 Devnet Playground — THE DEFINITIVE VERIFICATION + EXECUTION PLAN (2026-07-08)

---
## ✅ EXECUTION STATUS (updated 2026-07-08 — shipped to `playground` @ 1bea67a2, deployed live)

**PRs:** merged 8 (#2295/#2309[C3,M1]/#2308/#2311/#2296[H6-withdraw]/#2299/#2302/#2306); closed 3 (#2304/#2297/#2298); change-requested 6 (#2312/#2305/#2307/#2303/#2294/#2330 — flagged the 3 that regress live fixes).

**Findings SHIPPED (deployed):** C3, M1 (via #2309) · H1, H3, H2 (api-security) · P1, M7, M9, M10 (portfolio-withdraw) · S1, S2, S-M1, S-H1 (stake-earn) · H8, #13, #36 (nft) · H7, H6, LF1, TX1, EC, M8, T3-dd (trade-guards) · W1/W2/W3, W5/W7/W8/W9/W10/W11 (wizard) · H11, H12, H10/M13, M12, A1, M19, M15 (market-data) · wizard→keeper-register H1 auth wiring. **tsc 0 errors, 94/94 key tests green, all live pages 200, /api/stats live.**

**Already shipped earlier today:** portfolio config:{} crash, funding field-map, wizard→Sim-USDC, pre-fund Sim-USDC, ROE, maint-600.

**BUILT, pending gated apply:**
- **Keeper resilience** (`resilience/keep-alive` on percolator-oracle-keeper): D5/D1/D2a/G6/G8/G9 — stops the death recurrence. NEEDS a keeper restart (ops) to take effect; G6 hot-reload then makes re-seeds restart-free.
- **C1** — set `PLAYGROUND_KEEPER_KEYPAIR` on Vercel = keeper key `FbTbDeGW…` (one secret op) → wizard-launched markets get priced.

**REMAINING (human-gated):** keeper restart · C1 env · the RE-SEED (only after keeper resilience is live) · ANSEM re-delegate/cleanup · full wallet click-through on fresh markets.
---


Synthesized from 8 deep-coverage passes + 15 independent re-verification verdicts + a dedicated
matcher audit + a dedicated keeper runtime audit — all grounded on live devnet RPC, live endpoint
probes, deployed program source (`~/v17`), the proven scripts (`launch-test-market.ts` 8/8,
`newmarkets.ts`), and the pinned SDK. 24 workflow agents, 0 errors.

**Ground-truth market state:** BONK + PENGU **alive** (push lag ~1 slot, accrue lag <20, cranks clean).
SOL + JUP + TRUMP **deep-stale/DEAD** (273k–283k slots past the 500-slot ≈190s accrue cliff → every
trade/close/crank reverts `EngineStale(19)`/`EngineLockActive(21)`; re-seed is the only cure). ANSEM
(wizard-created) priced-broken (`authorityMismatch` = live C1). The keeper still pushes fresh prices
to all five, so **dead markets display a live green price — the single most dangerous divergence.**

---

## 1. VERIFICATION RESULTS (trustworthiness)

### Re-verified (15 verdicts): 13 CONFIRMED · 1 PARTIAL (H2) · 1 REFUTED (C4)
C1, C3, H1, H3, H4, H5, H6, H7, H8, H9, H10, H11, H12 = **CONFIRMED**. H2 = PARTIAL (core real: no
server-side pool priceability check; the "defaults raydium-clmm at :72" headline was misattributed).

### STALE / REFUTED — do NOT action
- **C4 REFUTED** — the wizard DOES auto-select `keeper` mode + set `oracle_mode=3` on devnet when a pool is found (`CreateMarketWizard.tsx:446-456`). The residual is C1 (env var), not wizard code. **Drop C4.**
- **C2 STALE** — register-poll is live + proven (`[register-poll] added ANSEM`). **Drop.**
- **#10 (portfolio 500 maint margin)** — v17 path uses on-chain 600; 500n only in dead v12 branch. Cosmetic.
- **my-markets crash (#49)** — fixed (optional chaining landed). H11 (fabricated data) is the surviving bug.
- **matcher/trade-CPI** — **byte-correct + on-chain-proven (open/short/limit/close PASS, matcher CPI runs, delegate matches).** No bug. `InitMatcherCtx` tag-83 is real (deployed handler; source is on an unmerged branch). Do NOT flag.
- Also stale: `/api/prices/markets` comment, AccountRiskSidebar (dead code), stake share-count comments, PLAYGROUND.md addresses.

### CONFIRMED WORKING / already-fixed (do NOT re-touch)
Portfolio config:{} crash fix, ROE (#27), maint-margin=600, TradeCpi ordering, deposit/withdraw tx-build,
pre-fund Sim-USDC, register-poll, LP-vault + stake tx, `/api/rpc` hardening, keeper hardened cranker.

---

## 2. COMPLETE RANKED LIST

### CRITICAL — wizard/launch dead end-to-end (config/ops + api, ship first)
- **D-OPS1** [ops] Live deploy PREDATES today's commits → the portfolio/funding/wizard-Sim-USDC fixes are **not actually live** (3 routes 404, stale earn hero). **Redeploy `origin/playground`.** ⚠ verify.
- **C1** [config] `PLAYGROUND_KEEPER_KEYPAIR` unset on Vercel → wizard delegates oracle auth to the MINT authority not the keeper → wizard markets dead on arrival. Set it = keeper key `FbTbDeGW…`; fail loud if mismatch. `lib/playground-keeper-signer.ts:34`.
- **C3** [frontend+api] Wizard sends raw `dexId` (raydium/meteora) not `raydium-clmm` → keeper-register 400 → never priced. Map dexId→dexType before POST. `CreateMarketWizard.tsx:689,750`.
- **H3** [api] devnet-pre-fund runs the 24h gate BEFORE the balance check → 2nd/3rd wizard launch 429s → throws. Make gate balance-aware. `devnet-pre-fund/route.ts:288`.

### HIGH — mislead users / strand funds / block trades (one frontend deploy, no re-seed)
- **H4+H5** PnL/entry double-scaled ~×price (~82× SOL) on entry-cache miss (root: `×oracle` not `×1e6`); blanks Entry/Liq → false "safe". `lib/trading.ts:97`; `usePortfolio.ts:184`; `PositionsDock.tsx:169`.
- **H6** No engine accrue-staleness guard → doomed trades/closes on cliff-dead markets (live now). `OrderTicket.tsx:200`; `useOracleFreshness.ts:172`.
- **H7** Oracle-stale guard dead for keeper mode → fires for 0/5 markets. Add `"keeper"` to the mode set.
- **P1** (NEW) Every position labeled by collateral → BONK long & PENGU short both read "USDC/USD". Populate `PortfolioPosition.symbol`. `portfolio/page.tsx:309`.
- **H11** `/my-markets` fabricates 0 OI/vault/insurance + always-"healthy" from empty `engine:{}`. Use `parseMarketGroupV17OI`. `my-markets/page.tsx:141`.
- **W1** Cross-session RESUME re-runs Step-1 `SetNftProgramId` → reverts `AlreadyInitialized`. Resume from `stuckSlab.lastStep`. `useCreateMarket.ts:868`.
- **W2** Step-3 retry double-deposits LP + double-tops one-way insurance. Idempotency guard. `useCreateMarket.ts:1071`.
- **H9/W3** Step-3 deposit rolls back when topup/crank reverts. Send DepositCollateral alone. `useCreateMarket.ts:1174`.
- **W8** Launch SOL gate under-counts ~0.069 SOL (omits Step-2 rent) → mid-launch death. `CreateMarketWizard.tsx:301`.
- **S1** (NEW) Full LP redemption strands funds — request zeroes balance → Withdraw button permanently disabled, no claim UI (2 live SOL victims). Add redemption-aware panel + Claim button. `DepositWithdrawPanel.tsx:146`.
- **H1** keeper-register unauthenticated + unbounded → griefer repoints any market's pricing pool. Add HMAC/wallet-sig. `keeper-register/route.ts:49`.
- **H8** No EmergencyBurn → liquidated wrapped NFT reverts `LegNotActive(22)`, strands rent. Add tag-5 path. `useBurnPositionNft.ts:116`.

### MEDIUM (fold into the correctness deploy)
H2 (keeper-register no pool check) · M13+H10 (stats $0 across /api/stats + ProtocolStatsBar) · H12 (OI as $ / fake $5M cap) · M1 (Blob-market null symbol/logo) · M-new-1 (single-slab API mislabels keeper "admin") · LF1 (error copy calls cliff-permanent 19/21 "transient" + 8× auto-retry) · A1 (CrankHealthCard always "n/a"/"FRESH") · M19 (funding OFF but full funding UI) · M12 (price-biased health) · M7 (withdraw gated to total not free margin) · M8 (before/after-liq) · M9 (default-v12-on-blip) · M10 (unsorted [0] portfolio) · M11 (AccountsCard empty v17) · S2 (false "Withdrawal successful" toast) · S-M1 (stake first-pool-only) · S-M2 (partial redeem) · S-H1 (useInsuranceLP no wallet-refresh/race guard) · T1-dd (Trades red-error vs empty) · A2 (AdlLeaderboard 508 loop) · T2-dd (MarketBookCard "—" v17) · TX1 (slippage code-9 shown "Invalid instruction") · EC (cross-program error-code collision 22=EngineNonProgress vs LegNotActive) · W5/W7/W9 (wizard resume robustness) · W6 (Step-3 unreclaimable) · M-new-2 (oracle_authority API returns marketauth).

### LOW / cosmetic
LF2 (phantom Buffer) · LF3 (unsafe maint default) · M-4/E1 (Earn insurance $0 Supabase) · S-M3 (LP decimals) · S-H2 (NAV impairment dormant) · T3-dd (double -PERP suffix) · T4-dd (oracle-history fallback) · #37 (close vs withdraw copy) · #13 (NFT conflation) · W4 (dummyAta) · W10/W11/W12/W13 · TX3/TX4/TX6 · warmup route · M-new-3 · admin-crash residuals · stake L1-L3 · StatsBar.

### Blocked-by RE-SEED (program cliff, un-crankable)
- **DEAD-MKTS** SOL/JUP/TRUMP deep-stale → re-seed only.
- **M2-dd** Dead markets render "LIVE" with frozen price → clears on re-seed (+ seed freshness from on-chain slot).
- **TX2** (NEW) BONK coarse `markEwmaE6=4` (~5× off) → large (~$500) trades revert `Custom(14)`. Re-seed BONK with finer mark.
- **ANSEM** wizard market authorityMismatch → re-delegate or re-seed after C1.
- **D-OPS2** external indexer gone → trades/funding/candles/stats history empty (degrade to empty-states).

---

## 3. KEEPER-RESILIENCE PLAN (stop the recurrence)
All keeper/ops-layer, blocked-by nothing.
- **D5** LP-discovery gotcha (leading cause of the 3 deaths): `DISCOVERY_RETRY_MS=300_000` > the 190s cliff → one transient boot miss = death. Add `lpPortfolio` to `MarketEntry`; skip discovery for seeded markets; 20s retry for poll-added. `recovery-cranker.ts:106`.
- **D1** Deterministic crank-on-boot: `await crankAllOnce()` (using registry lpPortfolio) before `startKeeperLoop`. `cross-cluster.ts:~186`.
- **D2** Redundancy + hang detection: /health-polling watchdog (kill+restart on stale `lastCycleAgo`) + `Promise.race([runCycle, timeout])`; stand up an **active-active 2nd keeper** on an always-on VPS (same key, ~10s phase offset).
- **D3** Pre-cliff alerting: surface per-market `{crankOk, consecutiveReverts, lastCleanCrankAgo, keeperBalanceSol}` on /health; external monitor WARN >90s / CRIT >150s (before 190s cliff) + real notifications.
- **D4** Host reliability: launchd plist (RunAtLoad+KeepAlive) + durable `pmset disablesleep 1`; ideally systemd on the VPS.
- Secondary: G6 (registry hot-reload + prune — else re-seed forces a restart-gap), G8 (parallel crank >15 markets), G9 (register vars in .env + boot WARN), G10 (stale pidfiles), G11 (identity/balance self-check).

---

## 4. EXECUTION SEQUENCE

**Already in source (NOT live per D-OPS1 — redeploy):** portfolio config:{} crash, funding field-map, wizard Sim-USDC, pre-fund Sim-USDC, ROE, maint-600, register-poll. Keeper hardening IS live+healthy.

**WAVE A — unblock launch (config/ops + api + keeper; hours, no re-seed):**
1. D-OPS1 redeploy origin/playground (carries done fixes + the Wave-B bundle)
2. C1 set PLAYGROUND_KEEPER_KEYPAIR on Vercel (highest-leverage single change)
3. C3 map dexId→dexType (ships with redeploy)
4. H3 fix pre-fund gate/24h lock
5. H1/H2 authenticate keeper-register + server-side pool priceability check
6. Keeper D5 + D1 + D2a + D4 (stops the death recurrence BEFORE any re-seed)
7. Re-delegate/re-seed ANSEM once C1 is set
→ then the first-ever end-to-end wizard dry-run in keeper mode.

**WAVE B — correctness deploy (one frontend bundle, no re-seed):** H4+H5 (PnL root fix + unit test) · H6/H7/LF1 (staleness guards + non-transient errors) · P1/H11/H12 (labels + real data + OI units) · H8/EC (EmergencyBurn + error map) · wizard cluster W9→W1→W2→H9/W3→W5→W8→W7/W10/W11 · stake cluster S1+S2+S-M2→S-H1→S-M1 · trade/portfolio med (M7-M11, TX1) · liquidation/funding (A1, M19, M12, LF2/LF3) · downstream/api (stats on-chain, M1, M-new-1/2, graceful empties, warmup).

**WAVE C — scale/resilience:** keeper D2b (active-active) + D3 (monitor) + G6/G8/G9-11 · frontend TX3/TX4 · stake NAV/decimals/insurance · optional indexer restore.

**RE-SEED (human-gated):** prerequisite = Wave-A keeper items live first (else re-seeded markets re-die). Unblocks: DEAD-MKTS, M2-dd, TX2 (finer BONK mark), ANSEM. Runbook: newmarkets.ts → prune registry → (G6 hot-reload or restart primary while secondary cranks) → confirm each discovers LP + authorityMismatch:false + 0 reverts in the first cycle.

---

## 5. COMPLETENESS
**Fully covered:** 8 deep passes closed the 4 previously-failed areas + re-verified all high-severity items against live state. Matcher/trade-CPI proven clean (risk retired). Funding confirmed OFF. Cliff measured (500 slots ≈190s). 15 items re-verified (13 CONFIRMED / 1 PARTIAL / 1 REFUTED); stale items flagged.

**Residual unknowns (honest, bounded):**
1. Live-liquidation reconciliation — `computeLiqPrice` is internally consistent but never byte-matched against a real on-chain liquidation (no underwater position to force one).
2. Address-set drift — config.ts/keeper-registry (`9NqrXt…`, authoritative) vs PLAYGROUND.md (`CsPuA8jj…`, stale doc but real portfolios read on it = an older seed still on-chain). Code findings are address-independent; reconcile at re-seed.
3. W4 (dummyAta) rests on possibly drift-stale `~/v17` source; cheap to match the proven ATA path.
4. D-OPS1 live-vs-source delta inferred from 3 routes 404 + stale copy; a redeploy resolves it (Wave-A step 1).

Modulo those four, **this is the whole list** — CRITICAL→LOW, deduped, NEW items folded in. Nothing high-severity is known-unhunted. Execute from Wave A.
