# UX Audit — Percolator Launch

## Executive Summary

Percolator Launch is significantly ahead of MidTermDev's implementation in design quality, feature breadth, and polish. The homepage clearly communicates the value prop, the Quick Launch flow is genuinely innovative, and the trading UI is well-structured. However, there are critical UX gaps that would block real usage: the TradeForm has broken CSS class names that prevent buttons from rendering correctly, jargon like "slab," "bps," "vAMM," and "base units" is unexplained throughout, and error states rely on raw error strings in several places. The biggest gap vs. a production perp DEX is the lack of beginner onboarding — a DeFi degen who's never traded perps would bounce at the Create page's advanced options without understanding what they're configuring.

---

## Critical UX Issues (blocks real usage)

### U1: TradeForm Long/Short buttons use invalid CSS class syntax
- **Page:** `/trade/[slab]` — `TradeForm.tsx`
- **Problem:** CSS classes like `bg-#00FFB2`, `bg-[white/[0.06]]`, `border-[white/[0.06]]` are invalid Tailwind. These should be `bg-[#00FFB2]`, `bg-white/[0.06]` etc. The Long button likely renders with no background color, making it invisible or broken-looking.
- **Impact:** Users can't visually distinguish the active Long/Short toggle. The submit button may also be invisible.
- **Fix:** Replace all `bg-#00FFB2` with `bg-[#00FFB2]`, all `bg-[white/[0.06]]` with `bg-white/[0.06]`, all `border-[white/[0.06]]` with `border-white/[0.06]` throughout TradeForm.tsx and PositionPanel.tsx.

### U2: "No account found. Go to Dashboard to create one." — dead end
- **Page:** `/trade/[slab]` — `TradeForm.tsx`
- **Problem:** When user has no account, TradeForm shows "Go to Dashboard to create one" but there IS no "Dashboard" page. The account creation happens in DepositWithdrawCard (sidebar). User is told to navigate somewhere that doesn't exist.
- **Impact:** First-time trader is stuck, can't figure out how to start.
- **Fix:** Either (a) remove this message and rely on the DepositWithdrawCard's "Create Account" button which is visible on the same page, or (b) change text to "Create an account using the panel on the right to start trading" with an arrow pointing to it.

### U3: No wallet-connected gate on Create page
- **Page:** `/create`
- **Problem:** User can fill out the entire Quick Launch form, auto-detect tokens, configure everything — then at the very end the button says "Connect wallet to launch" (disabled). All that work feels wasted.
- **Impact:** Frustration. User doesn't know they need a wallet until the last step.
- **Fix:** Show a prominent wallet connection prompt at the top of the wizard before showing the form. Or show the form but with a sticky banner: "Connect your wallet to launch a market."

### U4: Quick Launch "LP Collateral" and "Insurance Fund" are in base units
- **Page:** `/create` — `CreateMarketWizard.tsx` Quick Launch advanced settings
- **Problem:** Labels say "LP Collateral" and "Insurance Fund" with hint "Base units deposited as LP" / "Base units for insurance." Nobody knows what base units are. The default insurance is "100" — 100 what? 100 base units = 0.0001 tokens for a 6-decimal token.
- **Impact:** User either deposits absurdly small amounts or has no idea what they're configuring.
- **Fix:** Convert to human-readable token amounts (like the manual flow does). Show the token symbol and decimals.

---

## High UX Issues (confusing but workaround exists)

### U5: "Slab" terminology used everywhere, never explained
- **Page:** All pages
- **Problem:** URLs contain `/trade/[slab]`, code references "slab_address", the market card shows "slab" in the create flow step labels. "Slab" is internal Solana terminology for an on-chain data account. Users have no idea what it means.
- **Impact:** Confusion. "What did I just create? A slab?"
- **Fix:** Rename to "market" or "market address" in all user-facing text. URL can stay as-is.

### U6: Market creation shows ~6.9 SOL cost but Quick Launch shows ~0.5-7.0 SOL
- **Page:** `/create`
- **Problem:** Manual flow's Review step always says "~6.9 SOL" regardless of tier. Quick Launch shows tier-specific costs. The manual flow cost is wrong for small/medium tiers.
- **Impact:** User thinks they need 6.9 SOL when they might only need 0.5 SOL.
- **Fix:** Make the cost dynamic based on selected slab tier in the manual flow.

### U7: "bps" not explained anywhere
- **Page:** `/create`, trading UI
- **Problem:** Trading fee "30 bps", Initial margin "1000 bps" — while the create page does show the % equivalent inline, the term "bps" itself is never defined.
- **Impact:** Degens may know bps, but many won't. Adds friction.
- **Fix:** Add tooltip: "bps = basis points. 100 bps = 1%"

### U8: Health badge has no tooltip/explanation
- **Page:** `/markets`, `/trade/[slab]`
- **Problem:** HealthBadge shows "Healthy", "Caution", "Low Liq", or "Empty" with no explanation of what determines health or what action to take.
- **Impact:** User sees "Caution" on a market and doesn't know if it's safe to trade.
- **Fix:** Add tooltip explaining each level. E.g., "Caution: Insurance fund is low relative to open interest."

### U9: Price chart "No price data yet" with no context
- **Page:** `/trade/[slab]`
- **Problem:** New markets show either a blank chart or "No price data yet" or "Price chart building... (updates with each trade)". None of these explain WHY there's no data or what to do about it.
- **Impact:** User thinks the market is broken.
- **Fix:** Add: "Prices appear after the first trade. Be the first to trade this market!"

### U10: Portfolio page shows slab addresses instead of market names
- **Page:** `/portfolio`
- **Problem:** Each position row shows `{pos.slabAddress.slice(0, 8)}…` instead of the market name/symbol.
- **Impact:** User can't tell which market a position belongs to without clicking into each one.
- **Fix:** Use the supabase market metadata to show symbol/name.

### U11: TradeForm blocks new trades when position is open — no partial close
- **Page:** `/trade/[slab]`
- **Problem:** If user has an open position, the entire TradeForm is replaced with "Position open - close before opening a new one." User can't add to their position or partially close.
- **Impact:** Experienced traders expect to be able to add to positions. At minimum, the UX feels restrictive.
- **Fix:** This is a protocol limitation. Add explanatory text: "This market supports one position at a time. Close your current position to open a new one." Make it less abrupt.

---

## Medium UX Issues (polish)

### U12: Mobile nav doesn't include Faucet link
- **Page:** Header (mobile)
- **Problem:** The devnet faucet link only shows in desktop nav, not in mobile hamburger menu.
- **Fix:** Add faucet link to mobile nav array when `network === "devnet"`.

### U13: Markets page table is not responsive
- **Page:** `/markets`
- **Problem:** 8-column grid doesn't collapse on mobile. Columns will be squished.
- **Fix:** Use a card layout on mobile, table on desktop.

### U14: Homepage GitHub link goes to generic "github.com"
- **Page:** Homepage footer
- **Problem:** `<a href="https://github.com">GitHub</a>` — links to github.com, not the actual repo.
- **Fix:** Link to `https://github.com/dcccrypto/percolator-launch`.

### U15: Network toggle in header is dangerous
- **Page:** Header
- **Problem:** Clicking the "Devnet"/"Mainnet" button switches network instantly with no confirmation. User could accidentally switch to mainnet and send real SOL to devnet markets.
- **Fix:** Add confirmation dialog when switching networks.

### U16: No loading state for market discovery on Markets page
- **Page:** `/markets`
- **Problem:** While on-chain discovery runs, there's a skeleton loader, but if discovery finds 0 markets AND supabase also has 0, user sees "No markets yet" even if discovery is still loading.
- **Fix:** The `loading` variable uses AND (`&&`) — should be OR (`||`). Fix: `const loading = discoveryLoading || supabaseLoading;`

### U17: Create page manual flow Review step hardcodes cost
- **Page:** `/create` manual flow, step 4
- **Problem:** Shows "~6.9 SOL" always regardless of slab tier selection.
- **Fix:** Calculate based on selected tier like Quick Launch does.

---

## Copy Issues

| Location | Issue | Current Text | Fix |
|----------|-------|-------------|-----|
| Homepage hero | Uses "perpetual futures" without explaining what they are | "Launch perpetual futures markets for any Solana token." | Add a brief parenthetical: "Launch perpetual futures markets (bet on any token's price going up or down, with leverage) for any Solana token." |
| Homepage hero | "SPL token" is jargon | "Pick any SPL token" | "Pick any Solana token" |
| Homepage hero | "toly's Percolator program" — who is toly? | "Built on toly's Percolator program." | "Built on Anatoly Yakovenko's Percolator protocol" or just "Powered by Percolator" |
| Create page Quick Launch | "Base units" jargon | "Base units deposited as LP" | "Tokens to deposit as liquidity" |
| Create page | "vAMM LP" jargon | "Enable vAMM LP" | "Enable Virtual Market Maker" with tooltip explaining what it does |
| Create page | "Impact K (bps)" meaningless | "Impact K (bps)" | "Price Impact Factor" with tooltip |
| Create page | "Liquidity (notional)" jargon | "Virtual liquidity depth (e6)" | "Virtual liquidity depth (in USD)" |
| Create page | "Invert price feed" cryptic | "Invert price feed" | Add tooltip: "Enable when the collateral token IS the token being traded (e.g., trading SOL/USD with SOL as collateral)" |
| Trade page | "Margin" label unclear for beginners | "Margin (Token)" | "Collateral to risk" with info icon |
| Trade page | "Oracle Price" in PositionPanel | "Oracle Price" | "Market Price" — users don't know what an oracle is |
| Engine Health | All metrics are technical: "Haircut Ratio", "Net LP Pos", "Liq/GC Cursor", "Crank Cursor", "Sweep Start" | Various | Either hide this from normal users or add tooltips for each metric |
| My Markets admin | "Burn Admin Key" sounds dangerous without context | "🔥 Burn Admin Key" | Good — the confirmation dialog IS well-written with irreversibility warning ✓ |
| Markets table | "OI" abbreviation | "OI" sort button | "Open Interest" |

## Missing Explanations

These concepts appear in the UI without any tooltip, help text, or inline explanation:

1. **Perpetual futures** — What they are, how they differ from spot trading
2. **Leverage** — What 5x means in practice (5x profit AND 5x loss)
3. **Margin** — Why you need collateral, what happens if it runs out
4. **Liquidation** — When and why your position gets forcefully closed
5. **Insurance fund** — What it's for, why it matters for market health
6. **Oracle** — Where prices come from, what "stale" means
7. **Crank** — What keeps the market running, what happens if it stops
8. **Funding rate** — Not shown at all in our UI (MidTermDev shows it)
9. **Slab / Market capacity** — Why bigger = more expensive
10. **LP Collateral vs Insurance** — What's the difference between these two pools
11. **Health levels** — What Healthy/Caution/Warning/Empty mean precisely
12. **vAMM** — Virtual AMM and why you'd enable it
13. **Initial vs Maintenance margin** — Why there are two margin levels

## Competitor Comparison

### What MidTermDev Does Better
1. **Homepage educational content** — Their page has extensive "How It Works", "SOV Model", "Market Parameters" sections. They EXPLAIN the mechanics. We have a slick landing page but assume knowledge.
2. **Funding rate display** — They have a FundingRate component. We don't show funding rates anywhere.
3. **Market parameters table** — Clean table showing all market params (collateral, fees, margins, oracle, crank interval). Very transparent.
4. **On-chain addresses section** — Shows program, market, mint addresses clearly. Good for trust/verification.
5. **Single-market simplicity** — Their UX is optimized for ONE market (PERC/USD). Everything is focused. No decision paralysis.

### What We Do Better
1. **Design quality** — Night and day. We have glassmorphism, animations, gradients, proper spacing. They have basic Tailwind cards.
2. **Multi-market support** — We can browse, create, and trade ANY market. They're locked to one.
3. **Quick Launch** — One-click market creation with auto-detection. They have no market creation UI.
4. **Portfolio page** — Cross-market position tracking. They don't have this.
5. **Admin dashboard** — Full market management with oracle controls, insurance top-up, admin key burning.
6. **Price chart** — Live SVG chart with hover. They have no chart.
7. **Pre-trade summary** — Shows est. entry, fees, liq price before trading. They have this too but ours is better styled.
8. **Insurance LP system** — We support LP deposits into insurance. They show the insurance balance but don't allow LP.
9. **Search & sorting** — Markets page with search, sort by volume/OI/health. They have a basic list.
10. **Share button** — Can share market links. They don't have this.
11. **Error handling** — humanizeError() translates error codes. They show raw errors.
12. **Devnet faucet** — Built-in token minting. They don't have this.

### Features They Have That We're Missing
1. **Funding rate display** — We should show this on the trade page
2. **"How it works" education** — Inline explanations of the perp model
3. **Market parameters reference** — A clear table of current market settings

## Recommendations (prioritized)

1. **[CRITICAL] Fix broken CSS classes in TradeForm.tsx and PositionPanel.tsx** — buttons are likely invisible
2. **[CRITICAL] Fix "Go to Dashboard" dead-end message in TradeForm** — point to DepositWithdrawCard
3. **[CRITICAL] Fix Quick Launch base units issue** — use human-readable amounts
4. **[HIGH] Add wallet connection prompt at top of Create page** — don't let users configure then get blocked
5. **[HIGH] Replace all "slab" user-facing text with "market"**
6. **[HIGH] Fix Markets page loading state** (`||` not `&&`)
7. **[HIGH] Add tooltips for: bps, margin, leverage, liquidation, oracle, health badges**
8. **[HIGH] Fix homepage GitHub link**
9. **[HIGH] Make manual flow cost dynamic based on tier**
10. **[MEDIUM] Add "What are perpetual futures?" explainer section or tooltip on homepage
11. **[MEDIUM] Make markets table responsive for mobile**
12. **[MEDIUM] Add funding rate display to trade page**
13. **[MEDIUM] Fix portfolio page to show market names instead of addresses**
14. **[MEDIUM] Add network switch confirmation**
15. **[MEDIUM] Add faucet link to mobile nav**
16. **[LOW] Rename "Oracle Price" to "Market Price" in position panel**
17. **[LOW] Add educational content similar to MidTermDev's "How it Works"**
