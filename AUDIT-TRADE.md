# Trade Page Audit — 2026-02-10

Systematic audit of the trade page, all components, hooks, and data flows.

---

## TradeHistory.tsx (THE #1 ISSUE Khubair flagged)

### Bug: Schema mismatch — trades never display
- **Severity**: CRITICAL
- **What**: The frontend `Trade` interface expects `{ id, side, size, price_e6, fee, trader, tx_signature, created_at }` but the DB schema (`trades` table in `001_initial_schema.sql`) has columns `{ id, slab_address, trader, side, size, price, fee, tx_signature, created_at }`. Note: `price` not `price_e6`. Meanwhile the server-side `TradeRow` type in `packages/server/src/db/queries.ts` has `{ id, slab_address, user, direction, size_e6, price_e6, timestamp }` — a THIRD incompatible schema. The indexer's `insertTrade()` writes `user`, `direction`, `size_e6`, `price_e6`, `timestamp` but the DB expects `trader`, `side`, `size`, `price`, `fee`, `tx_signature`, `created_at`. **Nothing lines up.**
- **Where**: `app/components/trade/TradeHistory.tsx:7-15`, `supabase/migrations/001_initial_schema.sql:39-50`, `packages/server/src/db/queries.ts:22-30`
- **Fix**: Pick ONE canonical schema. The DB migration is the source of truth. Either: (a) update `TradeRow` and `insertTrade` in server to match the DB columns, or (b) run a new migration to rename columns. Then update the frontend `Trade` interface to match. Most likely the DB schema is correct and the server types + frontend need updating. This is why **no trades ever show** — the indexer inserts into wrong column names (silently fails or inserts nulls), and the frontend reads column names that don't exist in the response.

### Bug: No indexer running to populate trades
- **Severity**: CRITICAL
- **What**: Trades are only populated by POSTing to `/api/markets/[slab]/trades` (called by an indexer). There's no evidence the indexer is deployed or running. The `insertTrade()` in `packages/server` also inserts but with the wrong schema. Without an indexer, the `trades` table is always empty, so the frontend always shows "No trades yet."
- **Where**: `app/app/api/markets/[slab]/trades/route.ts:28-44`
- **Fix**: Either (a) deploy the indexer/keeper that calls this endpoint after each trade, or (b) record trades client-side after a successful `trade()` call in `TradeForm.tsx` by POSTing to the trades API, or (c) parse trade events from on-chain transaction logs.

### Bug: price_e6 field doesn't exist in DB response
- **Severity**: HIGH
- **What**: Frontend reads `trade.price_e6` and passes it to `formatPriceE6(BigInt(Math.round(trade.price_e6)))`. The DB column is `price` (NUMERIC), not `price_e6`. Even if trades existed, prices would show as "—".
- **Where**: `TradeHistory.tsx:82`
- **Fix**: Change to `trade.price` or rename DB column.

### Bug: Hardcoded devnet explorer URL
- **Severity**: LOW
- **What**: `https://explorer.solana.com/tx/${trade.tx_signature}?cluster=devnet` is hardcoded. Other components use `explorerTxUrl()` which handles cluster dynamically.
- **Where**: `TradeHistory.tsx:64`
- **Fix**: Use `explorerTxUrl(trade.tx_signature)` like other components.

---

## TradeForm.tsx

### Bug: setMarginPercent loses fractional precision
- **Severity**: MEDIUM
- **What**: `setMarginPercent` computes `(capital * BigInt(pct)) / 100n` then divides by `1_000_000n` and converts to string, losing all sub-token fractional amounts. E.g., if capital is 1,500,000 (1.5 tokens), 25% = 375,000 native, but `375000n / 1_000_000n` = `0n` → user sees "0" in the input.
- **Where**: `TradeForm.tsx:87-91`
- **Fix**: Use the full `formatPerc()` function to preserve fractional display: `setMarginInput(formatPerc(amount))`.

### Bug: Max button same precision loss
- **Severity**: MEDIUM
- **What**: Max button does `(capital / 1_000_000n).toString()` which truncates fractional tokens. User with 1.5 tokens sees "1" as max.
- **Where**: `TradeForm.tsx:146`
- **Fix**: Use `formatPerc(capital)` instead.

### Bug: Keyboard shortcut handler does nothing
- **Severity**: LOW
- **What**: The `handleKey` function checks for Enter but returns early if the active element is INPUT or BUTTON, and does nothing otherwise. The entire effect is dead code.
- **Where**: `TradeForm.tsx:101-110`
- **Fix**: Remove or implement the intended behavior (likely: focus the submit button or trigger `handleTrade`).

### Bug: "Press Enter to submit" hint is misleading
- **Severity**: LOW
- **What**: The hint says "Press Enter to submit" but Enter only works when focused on the margin input (via `onKeyDown` on the input). It does NOT work from anywhere on the page.
- **Where**: `TradeForm.tsx:198`
- **Fix**: Either make global Enter work or change hint to "Press Enter in the input to submit".

### Bug: Trade blocked when position exists — no partial close/increase
- **Severity**: MEDIUM
- **What**: If `hasPosition` is true, the entire form is replaced with a "Position open — close before opening new one" message. Users can't increase position size or partially close. This is a significant UX limitation.
- **Where**: `TradeForm.tsx:113-127`
- **Fix**: Allow same-direction trades to increase position, or implement partial close UI.

### Bug: Risk gate only blocks UI, not checked server-side
- **Severity**: MEDIUM
- **What**: `riskGateActive` shows a warning banner but doesn't disable the submit button. Users can still submit trades in risk-reduction mode.
- **Where**: `TradeForm.tsx:65-66, 188`
- **Fix**: Add `riskGateActive` to the disabled condition on the submit button.

### Bug: priceUsd could be null in PreTradeSummary
- **Severity**: LOW
- **What**: When `priceUsd` is null, `oracleE6` is passed as `0n` to `PreTradeSummary`. This could produce misleading fee/liq estimates.
- **Where**: `TradeForm.tsx:180`
- **Fix**: Don't show PreTradeSummary when price is unavailable, or show a warning.

---

## PositionPanel.tsx

### Bug: entryPrice uses reservedPnl as fallback — incorrect semantics
- **Severity**: HIGH
- **What**: `entryPriceE6 = account.reservedPnl > 0n ? account.reservedPnl : account.entryPrice`. `reservedPnl` is a PnL value, not a price. If `reservedPnl` happens to be positive, it's used as the entry price, producing completely wrong PnL calculations.
- **Where**: `PositionPanel.tsx:41-42`
- **Fix**: Always use `account.entryPrice`. If entryPrice is 0, show "N/A" or fetch from trade history.

### Bug: Margin health calculation is simplistic
- **Severity**: LOW
- **What**: `healthPct = (capital * 100n) / absPosition` — this is capital/position ratio as percentage, not a standard margin health metric. Doesn't account for unrealized PnL eating into margin.
- **Where**: `PositionPanel.tsx:78-81`
- **Fix**: Use `(capital + pnlTokens) / margin_required * 100` for actual margin health.

### Bug: No loading/error state when userAccount loads but engine data isn't ready
- **Severity**: LOW
- **What**: If `userAccount` exists but `livePriceE6` and `config.lastEffectivePriceE6` are both null/0, `currentPriceE6` = 0, making PnL calculations produce misleading zeros.
- **Where**: `PositionPanel.tsx:37-38`
- **Fix**: Show a "waiting for price" indicator when `currentPriceE6` is 0 and position exists.

---

## DepositWithdrawCard.tsx

### Bug: Withdraw doesn't check for open position
- **Severity**: MEDIUM
- **What**: Users can attempt to withdraw while having an open position. On-chain this may fail, but the error handling is `catch {}` — silently swallowed.
- **Where**: `DepositWithdrawCard.tsx:57-67`
- **Fix**: Show warning or disable withdraw when user has an open position (or at least show the caught error).

### Bug: Silent error swallowing on submit
- **Severity**: MEDIUM
- **What**: `handleSubmit` has `catch {}` — if deposit/withdraw throws, the error from the hook (`depositError`/`withdrawError`) may or may not be set depending on where the error originated. If it's a parsing error in `parseHumanAmount`, it's silently lost.
- **Where**: `DepositWithdrawCard.tsx:67`
- **Fix**: `catch (e) { console.error(e); }` at minimum, or set a local error state.

### Bug: No wallet balance shown for deposits
- **Severity**: MEDIUM
- **What**: Users see their account capital but not their wallet's token balance. They have no idea how much they CAN deposit without switching to another app.
- **Where**: `DepositWithdrawCard.tsx` (missing feature)
- **Fix**: Fetch and display wallet token balance using `getTokenAccountBalance` or `useTokenBalance` hook.

### Bug: No max button for withdraw
- **Severity**: LOW
- **What**: There's no "Max" button on the input like TradeForm has. Users must manually type their full balance to withdraw everything.
- **Where**: `DepositWithdrawCard.tsx:85-92`
- **Fix**: Add a max button that fills in the capital amount.

---

## useLivePrice.ts

### Bug: Jupiter poll runs even when WS is active
- **Severity**: LOW
- **What**: Comment says "Always poll" but `pollJupiter` early-returns if `wsConnected.current` is true. However, the interval is still running and making the function call every 10s even when WS is healthy. Minor perf waste.
- **Where**: `useLivePrice.ts:74, 119`
- **Fix**: Clear poll interval when WS connects, restart when it disconnects.

### Bug: WS_URL defaults to ws://localhost:3001
- **Severity**: HIGH
- **What**: `NEXT_PUBLIC_WS_URL` defaults to `ws://localhost:3001`. In production, if this env var isn't set, the WebSocket will fail silently and fall back to Jupiter polling. But Jupiter only works for tokens listed on Jupiter — new/custom tokens will have NO price data at all.
- **Where**: `useLivePrice.ts:6`
- **Fix**: Ensure `NEXT_PUBLIC_WS_URL` is set in all deployment environments. Add a console.warn if using localhost default.

### Bug: REST stats endpoint URL construction fragile
- **Severity**: LOW
- **What**: Converting WS URL to HTTP with `.replace("ws://", "http://").replace("wss://", "https://")` breaks if URL has `ws` in the hostname.
- **Where**: `useLivePrice.ts:111`
- **Fix**: Use a separate `NEXT_PUBLIC_API_URL` env var or a proper URL parser.

### Bug: 24h stats (change24h, high24h, low24h) never displayed
- **Severity**: MEDIUM
- **What**: The hook fetches and stores `change24h`, `high24h`, `low24h` but no component renders them. Wasted network call + missed UX opportunity.
- **Where**: `useLivePrice.ts:111-123`, not consumed anywhere in trade page
- **Fix**: Display 24h change in the price header area of the trade page.

---

## SlabProvider.tsx (data backbone)

### Bug: No error surfacing to user
- **Severity**: MEDIUM
- **What**: If `parseSlab` throws (corrupt data, version mismatch), `error` is set in state but no component checks or displays `SlabState.error`. The page silently shows loading skeletons forever.
- **Where**: `SlabProvider.tsx:60-62`
- **Fix**: Add error display in `TradePageInner` when `useSlabState().error` is truthy.

### Bug: 3-second polling is aggressive for production
- **Severity**: LOW
- **What**: `POLL_INTERVAL_MS = 3000` means every trade page tab makes an RPC call every 3 seconds. With multiple users, this could hit rate limits.
- **Where**: `SlabProvider.tsx:24`
- **Fix**: Increase to 5-10s for production, or make configurable. Rely on WS subscription for real-time updates.

---

## MarketBookCard.tsx

### Bug: Bid/Ask depth are identical
- **Severity**: MEDIUM
- **What**: Both "Bid Depth" and "Ask Depth" display `formatTokenAmount(lpTotalCapital)`. In reality, bid and ask depth should differ based on LP positioning. This is misleading.
- **Where**: `MarketBookCard.tsx:75-82`
- **Fix**: Calculate actual bid/ask depth based on LP net positions and available capital per side.

### Bug: bestBid/bestAsk calculated from E6 values then divided by 1_000_000
- **Severity**: MEDIUM
- **What**: `oraclePrice` is a BigInt in E6 format. `Number(oraclePrice)` gives the raw E6 integer. Then `bestBid / 1_000_000` is correct. BUT `feeBps / 10000` — the spread calculation uses `Number(oraclePrice) * (1 - feeBps / 10000)`. This is arithmetic on raw E6 values, so the final display `(bestBid / 1_000_000).toFixed(6)` should be correct. No actual bug here, just confusing code.
- **Where**: `MarketBookCard.tsx:47-48`
- **Fix**: Add comments or use `formatUsd()` for consistency.

### Bug: depthBarsRef animation re-triggers on every render
- **Severity**: LOW
- **What**: The GSAP animation for depth bars runs in a `useEffect` with `[lps, prefersReduced, maxLpCapital]` deps. Since `lps` is recomputed every 3 seconds (SlabProvider polls), bars re-animate constantly.
- **Where**: `MarketBookCard.tsx:37-52`
- **Fix**: Only animate on first mount, or compare previous values.

---

## EngineHealthCard.tsx

### Bug: BigInt values rendered via String() — safe but could be more readable
- **Severity**: LOW
- **What**: `String(engine.lifetimeLiquidations)`, `String(engine.lifetimeForceCloses)` etc. are technically safe (no React #310 BigInt error) since `String()` is used. Good.
- **Where**: `EngineHealthCard.tsx:43-52`
- **Fix**: No fix needed, just noting it's handled correctly.

### Bug: No refresh mechanism
- **Severity**: LOW
- **What**: Engine health data comes from SlabProvider polling. There's no manual refresh button unlike TradeHistory.
- **Where**: `EngineHealthCard.tsx`
- **Fix**: Minor — could add a refresh button, but polling handles it.

---

## trade/[slab]/page.tsx

### Bug: BigInt passed to ShareButton price prop
- **Severity**: MEDIUM
- **What**: `price={BigInt(Math.round((priceUsd ?? 0) * 1e6))}` — if ShareButton renders this BigInt directly in JSX, it will crash with React error #310. Need to verify ShareButton handles this safely.
- **Where**: `page.tsx:67`
- **Fix**: Verify ShareButton converts BigInt to string before rendering. If it does `{price.toString()}` or similar, it's fine.

### Bug: SlabProvider error not displayed
- **Severity**: MEDIUM
- **What**: If the slab address is invalid or RPC fails, `useSlabState().error` is set but `TradePageInner` never checks it. User sees eternal loading state.
- **Where**: `page.tsx:41-100`
- **Fix**: Add: `const { error } = useSlabState(); if (error) return <ErrorDisplay message={error} />;`

### Bug: No loading state in TradePageInner
- **Severity**: MEDIUM
- **What**: When `engine`, `config` are null (still loading), the page renders mostly empty components. There's no top-level loading skeleton.
- **Where**: `page.tsx:41`
- **Fix**: Add loading state check: `if (loading) return <LoadingSkeleton />;`

---

## Summary by Severity

| Severity | Count | Key Issues |
|----------|-------|------------|
| CRITICAL | 2 | Trade history schema mismatch; no indexer running |
| HIGH | 3 | entryPrice uses reservedPnl; WS URL defaults to localhost; price_e6 column mismatch |
| MEDIUM | 10 | Margin precision loss; risk gate not enforced; bid/ask depth fake; no wallet balance; error states not shown |
| LOW | 8 | Hardcoded devnet URL; dead keyboard handler; animation retriggers; etc. |

### Top 3 Actions
1. **Fix the trades pipeline end-to-end**: Align DB schema ↔ server types ↔ frontend interface. Deploy or implement trade recording.
2. **Fix entryPrice logic in PositionPanel** — using reservedPnl as price produces wrong PnL.
3. **Surface errors and loading states** — currently failures are invisible to users.
