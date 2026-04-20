# Pitch Deck V2 — Plan

**Context:** Rewriting `/pitch` at percolatorlaunch.com/pitch for investor/VC outreach. Current deck has 7 slides, investor-ready foundation but gaps (no team, no ask, weak competition slide, ambiguous Toly framing).

**Goal:** 10-12 slide deck that can stand alone as a send-ahead document and also work as in-person pitch. No team slide yet. No ask slide yet. No fundraising terms. Plain language, not blog-y.

---

## Constraints

- **No team slide** — not yet
- **No ask / fundraising terms** — not yet
- **Honest about Toly** — open-source lineage only; he continues to commit to the repo but has not endorsed, invested, or advised
- **Use existing devnet stats** — 168 markets, 3,000+ organic X followers, 471 Kani proofs
- **Plain language** — not walls of text, not jargon

---

## Final Structure (12 slides)

| # | Slide | Purpose |
|---|-------|---------|
| 1 | Cover | Name + tagline |
| 2 | The Gap | 15M tokens / <50 markets |
| 3 | What Percolator Is | Blue chips + memes + long-tail |
| 4 | Product screenshot | Show it's real |
| 5 | Create a market in 60 seconds | Visualize permissionless |
| 6 | How It Works | Three mechanisms (oracle, risk engine, permissionless) |
| 7 | Proof | Devnet stats |
| 8 | Competition matrix | Why only Percolator does this |
| 9 | Why Now | Market timing |
| 10 | Who Uses It | Three user stories |
| 11 | The Opportunity | Market size |
| 12 | Vision + Roadmap | Where this goes |

---

## Slide Copy

### Slide 1 — Cover

- Logo
- **Tagline:** Perpetual futures for every token on Solana.
- URL: percolatorlaunch.com

*No change from current deck.*

---

### Slide 2 — The Gap

**Label:** THE GAP

**Headline:** 15 million tokens live on Solana. Fewer than 50 have perpetual markets.

**Body:**
Every major perps DEX — Hyperliquid, Jupiter, Drift — decides which tokens you can trade with leverage. Listing requires approval, an oracle feed, or millions in auction fees.

The result: 99.9997% of tokens can never have leveraged markets.

**Callout:** Not because of technical limits. Because of design choices.

---

### Slide 3 — What Percolator Is

**Label:** THE SOLUTION

**Headline:** One place to trade any token with leverage.

**Three simple lines:**
- **Blue chips** — SOL, BTC, ETH with deep liquidity and Pyth feeds
- **Memecoins** — WIF, BONK, POPCAT, and anything trading on a DEX
- **Long-tail tokens** — the next 15 million

**Sub-headline:** One account. One collateral balance. Every perp market.

---

### Slide 4 — Product (NEW)

**Label:** THE PRODUCT

**Headline:** Live on devnet today.

**Visual:** Single high-quality screenshot of the trading UI (TradeForm + chart + positions).

**Caption (short):** Trading interface, order routing, cross-margin account. Everything you'd expect from a modern perp DEX — for any token.

**Note for implementation:** Take a clean screenshot from the devnet deployment. Ideally a market with real-looking activity.

---

### Slide 5 — Create a Market in 60 Seconds (NEW)

**Label:** PERMISSIONLESS

**Headline:** Any token. Any user. No approval.

**Three-step visual flow:**
1. **Pick a token** → Paste any Solana mint address
2. **Set parameters** → Fee rate, leverage cap, oracle mode
3. **Launch** → Market live. Trades can execute immediately.

**Footer line:** $500 USDC deposit. 60 seconds. Earn fees forever on every trade in your market.

**Note for implementation:** Consider a screen recording GIF of the actual market creation flow on devnet.

---

### Slide 6 — How It Works

**Label:** THREE MECHANISMS

**Headline:** What makes every-token perps possible.

**1 · On-chain oracle**
If a token trades on Raydium, Meteora, or pump.fun, we can read its price directly from the pool. No Pyth listing required. <0.05% deviation from centralized feeds on BTC, SOL, ETH.

**2 · Mathematically fair risk engine**
Built on open-source research from Anatoly Yakovenko. When a market hits limits, everyone takes a proportional haircut instead of some traders getting force-liquidated. Same deal for everyone.

**3 · Permissionless market creation**
$500 USDC and 60 seconds. No application, no approval. Set your fee rate, earn from every trade in your market.

---

### Slide 7 — Proof

**Label:** LIVE ON DEVNET

**Headline:** Built. Verified. Growing.

**Stats grid:**
| | |
|---|---|
| **168** | Markets created on devnet |
| **3,000+** | Organic X followers |
| **471** | Formal proofs verified (Kani) |
| **0** | Unresolved critical or high findings |

**Milestones:**
- Position NFTs — transferable perp positions on Solana
- Apache 2.0 licensed — fully open source
- Zero paid marketing, zero incentive programs

**Note:** Update "471" before launch if Kani proof count has changed. Current as of 2026-04-16 audit session.

---

### Slide 8 — Competition (NEW)

**Label:** THE LANDSCAPE

**Headline:** Only one protocol lists every token.

**Comparison matrix:**

| | Hyperliquid | Jupiter Perps | Drift | **Percolator** |
|---|---|---|---|---|
| Permissionless markets | ✗ | ✗ | ✗ | **✓** |
| Long-tail tokens | ✗ | ✗ | ✗ | **✓** |
| Cross-margin | ✓ | ✗ | ✓ | **✓** |
| On-chain oracle | ✗ | ✗ | ✗ | **✓** |
| Market creator fees | ✗ | ✗ | ✗ | **✓** |

**Subtext:** Everyone else competes for the same 30-50 tokens. We opened a new category.

**Open question:** Should we include non-Solana competitors (dYdX, GMX, Gains)? Current recommendation: no — keeps the slide focused on the Solana opportunity.

---

### Slide 9 — Why Now

**Label:** TIMING

**Headline:** The window is open.

**Three stats:**
- **$2–4B** — Monthly Solana perp volume today
- **10×** — Growth in Solana DEX volume in 18 months
- **Every week** — Thousands of new tradable tokens launch with no perp path

**Closing line:** Perps are the next trillion-dollar DeFi category. The winner is whoever can list the most assets fastest.

---

### Slide 10 — Who Uses It (NEW)

**Label:** THE USERS

**Headline:** Three audiences. One protocol.

**Three user stories:**

**The trader**
Wants leverage on WIF the moment it trends. Can't get it on Hyperliquid. Opens Percolator, trades instantly.

**The creator**
Launches a token and wants a perp market for it. Deposits $500. Earns fees from every trade for the life of the market.

**The LP**
Backs long-tail inventory that didn't exist before. Earns yield uncorrelated to blue-chip perp flow.

**Open question:** Are these three audiences right? Any fourth user type we should include (e.g., market maker, DAO treasury)?

---

### Slide 11 — The Opportunity

**Label:** THE MARKET

**Headline:** We're not taking a slice. We're building a new pie.

**Layout:** Two columns with a vertical divider.

**Left (existing market):**
- **$2–4B** monthly Solana perp volume
- ~50 tokens, all blue chips
- Mature, contested, low growth ceiling

**Right (new opportunity):**
- **15M+ tokens** with zero perp access today
- Every token on pump.fun, every memecoin, every new launch
- The long tail of crypto, finally tradable with leverage

*Keeps the spirit of current Slide 6 but reframed as opportunity sizing rather than TAM math.*

---

### Slide 12 — Vision + Roadmap (NEW)

**Label:** WHERE THIS GOES

**Headline:** Every tradable asset becomes a perp market.

**Body (short):**
Today perps are a luxury reserved for the 50 tokens exchanges choose to support. In five years, every token worth trading spot will also be tradable perpetually.

**Roadmap (directional, no dates):**
- **Phase 1 · Mainnet beta** — launching soon
- **Phase 2 · Liquidity deepening** — market maker programs, LP incentives
- **Phase 3 · Advanced primitives** — position NFTs, structured products, options
- **Phase 4 · Cross-chain expansion** — every-token perps beyond Solana

**Footer line:** We're building this regardless. If that resonates, let's talk.

---

## Changes from Current Deck (at-a-glance)

| Change | Rationale |
|---|---|
| Added product screenshot slide | Show it's real — high-impact for send-ahead decks |
| Added market creation flow slide | Makes "permissionless" concrete, not abstract |
| Added competition matrix | Direct answer to "why only you?" question VCs ask first |
| Added user stories slide | Makes TAM claims concrete |
| Reframed "Why Us" → "Vision + Roadmap" | Removed team/ask without losing forward-looking content |
| Toly reference softened | "Built on open-source research from Anatoly Yakovenko" — no implied endorsement |
| Dropped "$25M auction slot" detail | Too narrow (Hyperliquid-specific) |
| Dropped ADL technical explanation | Too technical for VC audience |
| Dropped team signals, mainnet date | Per user request — no team/ask yet |
| 516 → 471 Kani proofs | Accurate per 2026-04-16 audit session |
| "0 critical or high findings" → "0 **unresolved** critical or high findings" | Accurate — last session fixed 1 critical + 4 high |

---

## Things Dropped Permanently

- Team slide (user decision — not yet)
- Ask / fundraising terms (user decision — not yet)
- "$25M auction slot" specificity
- ADL as a technical problem statement
- Mainnet date promise
- Team signals / advisor mentions
- "Built on Toly's risk engine" framing that implied endorsement

---

## Open Questions for User

1. **Product screenshot** — generate a mock UI image, or user to provide a clean devnet screenshot?
2. **Competition matrix rows** — are the 5 rows accurate? Add/remove?
3. **Non-Solana competitors** — include dYdX / GMX / Gains in competition slide, or keep Solana-focused?
4. **Roadmap phases** — are the 4 phases right? Any to drop, add, or reword?
5. **User stories** — are trader/creator/LP the right three, or is there a fourth?
6. **Why Now stats** — confirm "$2–4B monthly" and "10× DEX volume growth" are accurate and current

---

## Implementation Notes (for when we resume)

- **File to edit:** `app/app/pitch/page.tsx`
- **Keep existing:** design system (colors, fonts, grid background, nav controls)
- **Add:** 5 new slide components (`Slide04Product`, `Slide05Create`, `Slide08Competition`, `Slide10Users`, `Slide12Vision`)
- **Rename existing components** to match new slot numbers
- **Update `TOTAL_SLIDES`** from 7 to 12
- **Update `SLIDES` array** with new ordering
- **Screenshot assets:** if using real screenshots, drop them in `app/public/images/pitch/` with meaningful names
- **Test:** print preview works (page-break-after already set per slide) — verify 12-slide PDF export looks right
- **Mobile:** existing responsive grid handles 12 slides fine; spot-check on narrow viewport

---

## Status

- [x] Plan approved
- [ ] Product screenshot provided or generated
- [ ] Open questions answered
- [x] Implementation started
- [ ] Deck reviewed
- [ ] Pushed to production

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-17 | 60s override applied per user directive — all "30 seconds" / "30-second" changed to "60 seconds" / "60-second" throughout plan and implementation. |
