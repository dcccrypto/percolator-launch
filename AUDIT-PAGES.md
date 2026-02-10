# AUDIT-PAGES.md — Market Pages, Creation Flow & Navigation Audit

**Auditor:** Cobra  
**Branch:** `cobra/feat/faucet-metadata-guide`  
**Date:** 2026-02-10  
**Scope:** All pages in `app/app/`, navigation, creation flow, data loading

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 5 |
| 🟠 High | 8 |
| 🟡 Medium | 12 |
| 🔵 Low | 9 |

---

## 🔴 Critical Issues

### C1: Markets page uses deprecated `supabase` export (can crash on SSR)
**File:** `app/app/markets/page.tsx:7`  
`import { supabase } from "@/lib/supabase"` uses the deprecated eager singleton. On server-side or during SSG this is `null`, causing `supabase.from(...)` to throw. The landing page correctly uses `getSupabase()`.  
**Fix:** Change to `import { getSupabase } from "@/lib/supabase"` and call `getSupabase().from(...)`.

### C2: Markets page `volume` column actually shows `cTot` (capital total), not volume
**File:** `app/app/markets/page.tsx` — table header says "volume" but renders `capitalTokens` (`m.onChain.engine.cTot`).  
The actual 24h volume from Supabase (`m.supabase?.volume_24h`) exists but isn't shown in the table — only used for sorting.  
**Fix:** Show `formatNum(m.supabase?.volume_24h)` in the volume column instead of `capitalTokens`.

### C3: Quick Launch — no wallet balance check before launch
**File:** `CreateMarketWizard.tsx` — `QuickLaunchPanel`  
No check that the user has enough of the collateral token to cover `lpCollateral + insuranceAmount`. The manual flow has `tokenBalance` check + 80% warning, but Quick Launch skips this entirely. Users will get a confusing on-chain error.  
**Fix:** Add the same ATA balance check from the manual flow.

### C4: Quick Launch — `insuranceAmount` parsed with wrong decimals possible
**File:** `CreateMarketWizard.tsx:~line 190`  
`parseHumanAmount(insuranceAmount, c.decimals)` — `insuranceAmount` defaults to `"100"` (string), and `c.decimals` comes from token meta. But `lpCollateral` uses `effectiveLpCollateral` which is raw string like `"1000000"`, not human-readable. Mixing human amounts (insurance=`"100"`) with potentially raw amounts (lp=`"1000000"`) depending on what `quickLaunch.config.lpCollateral` returns. If it returns raw lamports, the market gets wildly misconfigured.  
**Fix:** Verify `quickLaunch.config.lpCollateral` unit and normalize.

### C5: Network switch doesn't reload wallet adapter or RPC connection
**File:** `Header.tsx` — `handleNetworkSwitch`  
Calls `setNetwork()` which presumably updates config, but doesn't trigger any re-render of the wallet provider or RPC connection. The app will show "mainnet" badge but still be connected to devnet RPC and vice versa. Page reload required.  
**Fix:** Force `window.location.reload()` after network switch, or propagate through context.

---

## 🟠 High Issues

### H1: Landing page Supabase query has no error handling
**File:** `app/app/page.tsx:~line 100`  
`const { data } = await getSupabase().from("markets_with_stats")...` — no `.catch()`, no error state. If Supabase is down or env vars missing, the page silently shows 0 markets, 0 volume, which looks like a dead protocol.  
**Fix:** Add try/catch, show error state or hide stats section on failure.

### H2: Markets page — `useMarketDiscovery` could be slow/empty
**File:** `app/app/markets/page.tsx`  
Markets are loaded from TWO sources: on-chain discovery + Supabase. If either fails, behavior is unclear. On-chain scan could take 10+ seconds. No timeout or partial rendering.  
The merge logic requires on-chain data — if discovery returns 0 markets (RPC issue), the page shows "no markets" even if Supabase has data.  
**Fix:** Show Supabase markets as fallback even if on-chain discovery fails.

### H3: Markets page — 7-column grid doesn't fit mobile at all
**File:** `app/app/markets/page.tsx`  
`grid-cols-[2fr_1fr_1fr_1fr_1fr_0.7fr_0.7fr]` is hardcoded with no responsive breakpoint. On mobile this will be impossibly cramped or overflow.  
**Fix:** Add responsive layout — hide some columns on mobile or switch to cards.

### H4: My Markets page — no auto-refresh / stale data
**File:** `app/app/my-markets/page.tsx`  
`useMyMarkets()` loads once. After pushing a price or doing admin actions, the market data doesn't refresh. User has to manually reload.  
**Fix:** Add `refetch()` callback after successful admin actions, or poll on interval.

### H5: Portfolio page — broken HTML nesting
**File:** `app/app/portfolio/page.tsx:~line 18-19`  
```tsx
<div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
  <div className="relative mx-auto...">
```
The second `<div>` is inside the first self-closing `<div/>` parent but outside it syntactically — there's a missing closing tag creating broken DOM nesting. The `</div>` for the outer container is misaligned.  
**Fix:** Check JSX nesting in the `!connected` branch.

### H6: Portfolio page — positions show truncated slab address, not token symbol
**File:** `app/app/portfolio/page.tsx`  
Position rows show `pos.slabAddress.slice(0, 8)…` instead of the market symbol/name. Totally useless for users who don't memorize slab addresses.  
**Fix:** Look up market metadata to show symbol.

### H7: CreateMarketWizard manual mode — retry uses old `state.step` but doesn't pass symbol/name
**File:** `CreateMarketWizard.tsx:~line 770`  
`handleRetry` calls `create({...})` but omits `symbol` and `name` fields that exist in `handleCreate`. The retry could create a market with missing metadata.  
**Fix:** Add `symbol` and `name` to retry params.

### H8: Devnet mint page — confirmation polling can hang forever
**File:** `devnet-mint-content.tsx`  
The polling loop has a 60s timeout but no explicit rejection — if 60s passes, it just falls through silently and reports success even if unconfirmed.  
**Fix:** Add explicit timeout error: `if (Date.now() - startTime >= TIMEOUT_MS) throw new Error("Transaction confirmation timed out")`

---

## 🟡 Medium Issues

### M1: Landing page — featured markets table has 5 columns, not responsive
5-column grid with no breakpoint. On mobile, text will be microscopic.

### M2: Landing page — `hasMarkets` checks `volume_24h > 0`, so new markets with 0 volume are hidden
A just-launched market won't appear in featured even though it's live.

### M3: Markets page — "recent" sort does nothing
`case "recent": return 0;` — no actual sorting logic. Button exists but is non-functional.

### M4: Markets page — search filters against `merged` which requires on-chain data
If on-chain discovery fails, search will always return empty even with Supabase data available.

### M5: Create page — wallet warning shows `<WalletMultiButton />` but Header already has one
Redundant wallet button. Not broken but confusing UX — two buttons doing the same thing.

### M6: Create page — cost estimates are hardcoded strings, not calculated
`~0.5 SOL`, `~1.8 SOL`, `~7.0 SOL` appear in both Quick Launch and Manual mode as static strings. If rent costs change, these will be wrong.

### M7: Guide page — says "Click the network badge in the header to toggle" but doesn't warn about C5 (no actual reload)
Guide gives instructions that don't fully work.

### M8: Guide page — devnet faucet step says "run 'solana airdrop 2'" but the app has a built-in airdrop button
Could mention the in-app faucet page.

### M9: Footer — hardcoded contract address `8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump`
This is a pump.fun token address in the footer. If this isn't the actual protocol token, it's misleading. Should be configurable or removed.

### M10: Devnet faucet — `connection` created with raw Helius API key in client-side code
**File:** `devnet-mint-content.tsx:5`  
`NEXT_PUBLIC_HELIUS_API_KEY` is embedded in the RPC URL. While `NEXT_PUBLIC_` means it's intentionally public, the devnet faucet creates its own connection instead of using the app's connection from wallet adapter. This bypasses any network config.

### M11: Devnet faucet — "Mint More" doesn't verify user is mint authority
If someone pastes a mint they don't control, `createMintToInstruction` will fail with a confusing error. Should check `mintAuthority === publicKey` first.

### M12: My Markets page — hardcoded colors instead of CSS variables
Uses `#1a1a1f`, `#111113`, `#71717a`, `#FF4466`, `#00FFB2`, `#FFB800` etc. inconsistent with the rest of the app which uses `var(--border)`, `var(--panel-bg)`, etc.

---

## 🔵 Low Issues

### L1: `/launch` redirects to `/create` — should this route just be removed?
Server-side redirect works fine but is unnecessary code.

### L2: `/agents` page exists but isn't in the nav
Not linked from Header or any other page. Orphan page.

### L3: Landing page imports `GlassCard` but never uses it
Unused import: `import { GlassCard } from "@/components/ui/GlassCard"`.

### L4: Markets page imports `GlowButton` but Link wraps it inconsistently
`<Link href="/create"><GlowButton>` — button inside an anchor. Potential accessibility issue.

### L5: Header — `setNetwork` imported from config but `setNet` is local state
Two separate state values for network. Config is set but local state update triggers re-render — could desync if config fails.

### L6: My Markets page — `font-family: var(--font-space-grotesk)` used only here
Inconsistent with other pages using `var(--font-heading)`.

### L7: Create page — `ScrollReveal` wraps the wizard with `delay={0.1}` — can cause content flash
Wizard content invisible for 100ms on load.

### L8: Error page — uses hardcoded colors (`#00FFB2`, `#111113`) instead of CSS vars
Inconsistent with the design system.

### L9: Devnet mint page — `DEFAULT_RECIPIENT` hardcoded to a specific wallet
`HoibauLv7EPDTr3oCAwE1UETuUio6w8DZjKM5AoTWsUM` — overridden by connected wallet, but if wallet connects late, this default could mint to the wrong address.

---

## Navigation Audit

| Link | Source | Target | Status |
|------|--------|--------|--------|
| `/` | Header logo | Landing page | ✅ Works |
| `/markets` | Header, Landing CTA | Markets list | ✅ Works |
| `/create` | Header, Landing CTA, Markets page | Create wizard | ✅ Works |
| `/portfolio` | Header | Portfolio page | ✅ Works |
| `/my-markets` | Header ("Admin") | My Markets | ✅ Works |
| `/guide` | Header | Guide page | ✅ Works |
| `/devnet-mint` | Header (devnet only, "Faucet") | Token faucet | ✅ Works |
| `/launch` | — | Redirects to `/create` | ✅ Works |
| `/agents` | Not linked anywhere | Agent hub | ⚠️ Orphan |
| `/trade/[slab]` | Markets list, My Markets, Portfolio | Trade page | ✅ Works (not audited here) |

**Mobile nav:** Mirrors desktop nav correctly with GSAP animation. Faucet link appears on devnet. ✅

---

## Data Flow Summary

### Where do markets come from?
1. **Landing page:** Supabase `markets_with_stats` view → stats + featured list
2. **Markets page:** On-chain `useMarketDiscovery()` (scans program accounts) MERGED with Supabase `markets_with_stats` → full list with metadata
3. **My Markets:** `useMyMarkets()` hook → filters on-chain markets by wallet (admin/lp/trader role)
4. **Portfolio:** `usePortfolio()` hook → finds positions across all markets for connected wallet

### Critical data flow gaps:
- If Supabase is down: Landing shows 0/0/0 stats (looks dead), Markets page still works via on-chain data but has no symbol/volume info
- If RPC is down: Markets page shows "no markets", Portfolio shows "no positions", My Markets shows loading forever
- No caching layer — every page load hits both Supabase and RPC fresh

---

## Recommended Priority

1. **Fix C1** (deprecated supabase import) — quick fix, prevents crashes
2. **Fix C2** (wrong column data) — misleading financial data
3. **Fix C5** (network switch) — users will think they switched but didn't
4. **Fix H3** (mobile markets) — unusable on phones
5. **Fix H5** (portfolio nesting) — potential render bug
6. **Fix H7** (retry missing fields) — market creation can break
7. **Fix H1** (landing error handling) — bad first impression
8. **Fix C3/C4** (Quick Launch balance/units) — user money at risk
