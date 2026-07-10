# Percolator v17 Playground — Deep Bug Hunt (2026-07-08)

Multi-agent hunt: 16 finder dimensions → 2 adversarial skeptics per finding → ranked
synthesis. 155 agents, 0 errors. **60 verified findings → 44 distinct root causes.**
Severities reconciled to the skeptics' verdicts (not the finders' labels).

---

## HIGH

| # | Title | file:line | Impact | Fix direction |
|---|-------|-----------|--------|---------------|
| 1 | Portfolio & dashboard crash on all v17 markets (`market.config === {}` → `collateralMint` undefined) | `app/portfolio/page.tsx:65-70,305`; `components/dashboard/PositionSummary.tsx:183`; throw site `hooks/useMultiTokenMeta.ts:18` | Any wallet holding a position hits a render TypeError → `/portfolio` and the `/dashboard` position panel are unusable | Read `pos.market.configV17?.collateralMint ?? pos.market.config.collateralMint`; `.filter(Boolean)` in useMultiTokenMeta |
| 2 | Earn LP-vault two-step redemption broken: full withdraw un-completable + false "Withdrawal successful!" + preview≠executed + dead cooldown timer | `components/earn/DepositWithdrawPanel.tsx:133,146-154`; `hooks/useInsuranceLP.ts:514-579`; `app/earn/[slab]/page.tsx:322-334` | After a Max request `userLpBalance→0` permanently disables the button so `ExecuteRedemption` is unreachable — principal stranded in escrow; success toast fires though nothing was withdrawn | Wire `hasPendingRedemption`/`pendingRedemptionShares` into the panel; add Execute/Cancel decoupled from `userLpBalance`; distinguish request vs execute |
| 3 | v17 `portfolio.pnl` (collateral atoms) mis-scaled ×price | `components/trade/PositionsDock.tsx:172-178`; `hooks/usePortfolio.ts:182-185,457-460` | On any entry-cache miss (2nd device, NFT transfer, cleared storage) PnL & portfolio value inflate ~×price (e.g. $8→$1,200 on SOL) | `account.pnl` is already collateral — use directly, don't pass through `computeMarkPnlCollateral` |
| 4 | `/portfolio` blanks Entry/Liq and marks positions "100% safe" (no `estimateEntryFromPnl` fallback; escrow-PDA cache key) | `hooks/usePortfolio.ts:170,564` | Scale-in/NFT-wrapped/cross-device positions show Entry '—', Liq '—', green "safe", excluded from at-risk count — hides liquidation risk the trade page shows | Add cached→`estimateEntryFromPnl` fallback like PositionsDock; key cache by connected wallet not `portfolio.owner` |
| 5 | Oracle-stale submit/close block dead for keeper markets (all 5 live) | `components/trade/OrderTicket.tsx:200`; `PositionsDock.tsx:113`; `PositionPanel.tsx:217` | Keeper stops → market stale-locks on-chain but Long/Short/Close stay enabled while header says "NO ORACLE – trades blocked"; trades revert `EngineStale(19)` and auto-retry burns fees. AUTH_MARK has on-chain `max_staleness_secs=0` so this is the only guard | Add `"keeper"` to the stale-blocking mode set |
| 6 | Unauthenticated `keeper-register` + unbounded/unvalidated blob registry | `app/api/playground/keeper-register/route.ts:49`; `lib/playground-registered-markets.ts` | No auth/ownership check (sibling route requires HMAC); attacker injects arbitrary slabs into the "curated" list; >100 registrations overflow the keeper's single `getMultipleAccounts` (max 100) → 0 AuthMark pushes → all markets stale-lock | Require signature/ownership proof; cap+chunk registry to ≤100 per RPC; add eviction/clear |
| 7 | Withdraw with an open position always reverts on-chain, but UI allows it and shows misleading "stale, retry" | `hooks/useWithdraw.ts:153-170`; `DepositWithdrawCard.tsx:267-303`; `lib/errorMessages.ts:65,196` | Max→Withdraw with a position open reverts `EngineStale(19)`, humanized as transient oracle staleness → user retries forever; real fix (close first) never surfaced | Client-side active-leg gate; don't treat code-19-on-withdraw as transient |
| 8 | `estimateEntryFromPnl` inverts the wrong formula (collateral realized pnl treated as coin-margined unrealized) | `lib/trading.ts:87-100` | On cache-miss recovery the reconstructed entry/liq is wrong (~×price, often clamps entry→mark), feeding wrong Entry/Liq and OrderTicket buying-power gating | Invert the collateral formula (`diff = pnl*1e6/size`) — related to #3 |
| NEW-C | Create-market Step 1 fails "mintAddress not permitted" — playground Vercel project has NO Supabase creds → mirror-mint never registered → pre-fund fail-closes | `app/api/devnet-pre-fund/route.ts:182-263`; `app/api/devnet-mirror-mint/route.ts:241-246,373`; `lib/supabase.ts:39-47` | EVERY `/create` flow dies on step 1 (new mint never in `devnet_mints`; `DEVNET_ALLOWED_MINTS` non-empty so `EMERGENCY_DEVNET_MINTS` is dead code). `/api/devnet-mint-token` ($500 airdrop) also 500s (no try/catch on `getServiceClient()`) | Restore Supabase creds OR decouple these routes from Supabase (use Blob / permit newly-mirror-minted mints / fail-open to the on-chain mint-authority check) |

## MEDIUM

| # | Title | file:line | Impact |
|---|-------|-----------|--------|
| 9 | Dashboard "live" ProtocolStatsBar permanently $0 (client Supabase runs empty) | `components/dashboard/ProtocolStatsBar.tsx:51` | 24h Vol/OI/Active show $0 with a green "live" dot while `/api/stats` has real values |
| 10 | `/portfolio` liq/at-risk uses hardcoded 500 bps not on-chain 600 | `hooks/usePortfolio.ts:355` | Understates liquidation risk; contradicts trade page |
| 11 | Insurance-coverage / engine-health = collateral-USD ÷ base-token-OI (no ×price) | `components/trade/EngineHealthCard.tsx:44`; `LiquidationAnalytics.tsx:59` | Health badge price-biased: high-priced tokens read "Healthy", low read "At Risk" |
| 12 | Markets-list health can't detect a stalled keeper (only `price==0`) | `app/markets/page.tsx:957` | Keeper-dead market shows green "Healthy" while `/trade` shows NO ORACLE |
| 13 | PositionNftPanel conflates a received NFT with the user's own same-market position | `components/trade/PositionNftPanel.tsx:79` | Blocks minting your own position; Send modal mislabels |
| 14 | Create-market cross-session RESUME restarts at step 1 → `SetNftProgramId` reverts `AlreadyInitialized` | `components/create/RecoverSolBanner.tsx:140`; `useCreateMarket.ts:868` | Any market stalled past step 1 can't be finished via recovery UI |
| 15 | Create-market retry re-runs Step 3 with no idempotency → double `DepositCollateral`+`TopUpInsurance` | `hooks/useCreateMarket.ts:1148` | Timeout-but-landed + Retry deposits collateral+insurance twice (insurance is one-way) |
| 16 | Create-market cost estimate & SOL gate omit ~0.066 SOL Step-2 LP-portfolio rent | `components/create/CostEstimate.tsx:66` | "Sufficient SOL" shown, flow dies mid-launch for wallets ~[0.214,0.28] SOL |
| 17 | keeper-register reports success for an unpriceable pool (dexType/owner mismatch; defaults `raydium-clmm`) | `app/api/playground/keeper-register/route.ts:72` | Meteora/PumpSwap pool → "registered" but keeper skips forever → market permanently unpriced |
| 18 | Non-atomic read-modify-write on the registry blob drops concurrent registrations | `lib/playground-registered-markets.ts:117-127` | Two near-simultaneous registrations → last-writer-wins, the other silently never priced |
| 19 | Stake "Your Deposits" total & position show only the first pool | `app/stake/page.tsx:1074` | Staking in >1 pool undercounts hero total and hides other positions |
| 20 | Oracle details panel shows fabricated hardcoded "24h Statistics" + fictional Pyth→Chainlink fallback | `components/oracle/OracleDetailsPanel.tsx:359` | Asserts 99.97% uptime / 1,847 pushes-hr even when the feed is dead |
| 21 | WS display-feed liveness never surfaced (freshness dot tracks on-chain oracle only) | `hooks/useOracleFreshness.ts:172` | Dead price WS → frozen mark under green "fresh"; frozen price feeds OrderTicket sizing |
| 22 | `useLpPositions` has no cancellation/request-id guard (wallet-switch race) | `hooks/useLpPositions.ts:104` | Slow fetch for old wallet overwrites new wallet's LP dashboard (self-heals ~30s) |
| 23 | `useMyMarkets` scan-dedup key omits the wallet → new wallet shows previous wallet's markets | `hooks/useMyMarkets.ts:118` | After wallet switch, My Markets lists markets the new wallet has no account in |
| 24 | `my-markets` reads OI/vault/insurance/accounts from empty v17 engine block → all 0, always "● healthy" | `app/my-markets/page.tsx:141` | Every v17 market shows 0 stats + false green health |
| 25 | OpenInterestCard "OI Utilization" uses hardcoded $5M cap (+units mismatch); "LP Net" hardcoded $0 on v17 | `components/market/OpenInterestCard.tsx:137` | Color-coded "near capacity" alarm off a fictional cap; LP Net always +$0 |
| 26 | AccountsCard ("All accounts & liqs" + leaderboard) permanently empty on v17 | `components/trade/AccountsCard.tsx`; `SlabProvider.tsx:295` | Market-wide positions/liq/leaderboard shows empty though positions exist |
| 27 | Portfolio ROE%/PnL% uses ÷total-capital while trade terminal uses ÷initial-margin | `hooks/usePortfolio.ts:186,465` | Same position shows different return % on `/portfolio` vs `/trade` |
| 28 | OrderTicket "Liq price" before-state always '—' on v17; after-state ignores existing position | `components/trade/OrderTicket.tsx:446,443` | Scale-in receipt/confirm-modal liq is fabricated |
| 29 | No EmergencyBurn path: burning a wrapped NFT whose leg closed/liquidated reverts, stranding escrow | `components/trade/PositionNftPanel.tsx:216` | Burn/Send both revert `LegNotActive`; no in-app recovery |
| 30 | Multi-portfolio dedup sort only in `useInitUser`; deposit/withdraw/display pick unsorted `[0]` | `useDeposit.ts:66`; `useWithdraw.ts:123`; `useUserAccount.ts:136` | Deposit credits A while UI shows B; withdraw targets C |
| 31 | v17/v12 layout detection defaults to legacy v12 on any slab-fetch failure | `hooks/useWithdraw.ts:97`; `useDeposit.ts:147` | Transient RPC 429 → v12-shaped tx against a v17 slab → confusing on-chain failure |
| 32 | Stake staleness: pools fetched once on mount; withdraw-tab position not refreshed after deposit | `app/stake/page.tsx:1039,542-567` | TVL/cap-bar frozen; Withdraw tab shows "No staked balance" for a just-made stake until reload |
| 33 | Dashboard StatsBar fabricates "Fee Tier: Maker 0.02% / Taker 0.06%" (no such model); Today's PnL "--" | `components/dashboard/StatsBar.tsx:42` | Invented fee tier presented as live stats |
| 34 | `useDevnetFaucet` latches `checked`, never resets on wallet change | `hooks/useDevnetFaucet.ts:152` | After switching to an empty wallet, faucet never re-checks (Privy path) |
| 35 | Create-market "RETRY INITIALIZATION" regenerates a fresh slab keypair, orphaning the stuck slab | `hooks/useCreateMarket.ts:382-385` | Mints a second slab instead of reusing the restored one |

## LOW
36 NFT mint escrows whole sub-account, no Mint warning · 37 ClosePositionModal fabricates partial-close "Est. Receive" · 38 Stake withdraw silently no-ops when amount>balance · 39 Flushed insurance pool shows 1:1 estimate but deposit reverts · 40 DashboardHeader omits `$` / hides negative equity · 41 MarketInfoBar shows raw base-token OI as `$` when price null · 42 Send-NFT modal claims stale v12 transfer semantics · 43 single-slab API mislabels keeper as `oracle_mode:"admin"` · 44 `usePortfolio` missing try/catch on `computePnlPercent` (**drop candidate**)

---

## Systemic themes (root-cause clusters)
1. **v17-null / empty-struct class (largest).** v12 helpers read fields null/empty/zero on v17: `engine{}`, `config{}`, `entryPrice 0n`, `accounts[]`, `portfolio.pnl` semantics → #1 crash, #24, #26, #3, #4, #28, #43.
2. **OI units — base-token atoms vs USD notional** (forgot ×price / divided USD by a token count): #11, #25, #41.
3. **Entry-price cache-miss handling** (localStorage entry cache + wrong/absent fallback): #3, #4, #8, #28 — wrong PnL, wrong Liq, blank Entry, false "safe".
4. **"keeper" is the forgotten oracle-mode branch** (guards/labels handle admin/hyperp, omit keeper — the mode of all 5 live markets): #5, #12, #20, #21, #43.
5. **Stale client state & wallet-switch races** (missing refetch-on-tx / wallet-scoped cancellation): #18, #22, #23, #32, #34.
6. **Multi-tx / two-step flows on single-button UIs** (non-idempotent retries, unmodeled state machines): #2, #14, #15, #35.
7. **keeper-register registry structurally unsafe** — unauth (#6), non-atomic (#18), unvalidated (#17): 3 defects in one 40-line surface that is the SOLE market↔pool binding on v17.
8. **"Live-looking" widgets wired to nothing** (placeholder/fabricated data as real): #9, #20, #24, #25, #26, #33.
9. **Residual Supabase dependency on a Supabase-free deployment** (NEW-C): the create-market mint routes (`devnet-mirror-mint`, `devnet-pre-fund`, `devnet-mint-token`) still require Supabase, which is unset on the playground Vercel project → `/create` bricked.

## Coverage gaps (what wasn't fully hunted)
- On-chain/LiteSVM repro would raise confidence on the top-impact chains: #6 (>100-pool DoS), #15 (double-deposit), #2 (redemption stranding).
- Under-hunted code paths: matcher/order-matching, trade-CPI account ordering, funding-rate math, liquidation/crank execution — nearly all findings are read/display-side. NFT mint Token-2022 heap/frame not probed.
- Security scope was narrow: only `keeper-register` was adversarially reviewed; other routes + keypair/secret exposure not examined.
