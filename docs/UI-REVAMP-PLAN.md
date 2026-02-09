# Percolator UI Revamp — Full Plan

## Vision
**Not a generic DeFi terminal. A premium trading experience that feels alive.**

Inspiration: Hyperliquid's density + Drift's polish + Jupiter's playfulness. But with its own identity — Percolator should feel like a weapon, not a spreadsheet.

## Design Language

### Color System
Current: `#0a0b0f` bg + `#00d4aa` / `#10b981` accent (generic green terminal)

**New palette — "Neon Obsidian":**
- **Background:** Deep black with subtle blue undertone (`#06080d` → `#0a0e17`)
- **Cards/Surfaces:** Glass morphism with subtle noise texture (`rgba(15,20,35,0.7)` + `backdrop-blur`)
- **Primary accent:** Electric cyan-green (`#00FFB2`) — more vibrant than current
- **Secondary:** Deep violet (`#7B61FF`) for UI elements, hover states
- **Long:** Neon green (`#00FF88`)
- **Short:** Hot coral (`#FF4466`)
- **Warning:** Amber (`#FFB800`)
- **Text hierarchy:** `#F0F4FF` → `#8B95B0` → `#3D4563`
- **Borders:** Gradient borders (`#1a2040` → `#00FFB2/10`)

### Typography
- **Headlines:** Inter or Space Grotesk (bold, tight tracking)
- **Data/Numbers:** JetBrains Mono (monospace for prices, amounts — sharp, readable)
- **Body:** Inter (clean, modern)

### Visual Effects
- **Glass morphism cards** with subtle blur + noise
- **Gradient borders** that subtly animate
- **Glow effects** on interactive elements (buttons, active states)
- **Particle/mesh background** on homepage (subtle, performance-conscious)
- **Micro-interactions** on every button, card hover, tab switch

## GSAP Animation Plan

### Homepage
1. **Hero entrance:** Staggered text reveal (letter-by-letter or word-by-word) with GSAP SplitText
2. **Stats counter:** Number counting animation on scroll (ScrollTrigger)
3. **How it works cards:** Staggered slide-up + fade on scroll
4. **Feature cards:** Parallax tilt on hover (GSAP quickTo)
5. **Background:** Floating gradient orbs with slow GSAP timeline loop
6. **CTA buttons:** Magnetic hover effect (cursor-following glow)

### Trade Page
1. **Page enter:** Cards slide in from edges (left panel from left, right from right, chart from bottom)
2. **Price updates:** Smooth number transitions (GSAP snap/morphing)
3. **Position open/close:** Card flip or expand animation
4. **Order confirmation:** Success burst animation
5. **Tab switches:** Smooth content crossfade

### Market Browser
1. **Cards:** Staggered entrance on load
2. **Hover:** Subtle scale + glow + border light sweep
3. **Filtering:** LayoutGroup-style reflow animation
4. **Loading:** Skeleton shimmer (not just grey blocks — animated gradient sweep)

### Create Market (Quick Launch)
1. **Step progression:** Smooth slide transitions between steps
2. **Token paste:** Bouncy validation animation (green pulse on success)
3. **Deploying:** Multi-stage progress with particle effects
4. **Success:** Confetti / celebration animation
5. **Step indicators:** Animated progress bar with glow

### Global
1. **Page transitions:** Smooth opacity + translate
2. **Toast notifications:** Slide in from top with spring physics
3. **Wallet connect:** Smooth modal entrance
4. **Loading states:** Animated gradient shimmer (not static grey)
5. **Scroll-based reveals:** Subtle parallax on all sections

## Component Architecture

### New UI Components Needed
```
components/ui/
  GlassCard.tsx          — Glass morphism card with blur + noise
  GradientBorder.tsx     — Animated gradient border wrapper
  AnimatedNumber.tsx     — GSAP-powered number transitions
  MagneticButton.tsx     — Cursor-following hover glow
  ShimmerSkeleton.tsx    — Animated gradient loading skeleton
  ParticleBackground.tsx — Lightweight particle/mesh hero bg
  SplitText.tsx          — GSAP text reveal animation
  ScrollReveal.tsx       — ScrollTrigger wrapper component
  GlowBadge.tsx          — Status badges with glow effect
  AnimatedTabs.tsx       — Smooth tab switching with crossfade
```

### Page Restructure
```
Homepage (page.tsx)
├── HeroSection        — Animated hero with SplitText + particle bg
├── StatsBar           — Animated counters on scroll
├── HowItWorks         — 3-step scroll-triggered cards
├── FeaturedMarkets    — Horizontal scroll or grid with hover effects
├── Features           — Bento grid with hover animations
├── CTA                — Magnetic button + glow
└── Footer             — Clean, minimal

Trade Page (trade/[slab]/page.tsx)
├── PriceHeader        — Large price display with smooth updates
├── ChartPanel         — TradingView-style (or lightweight chart with GSAP)
├── TradePanel         — Glass card with animated form
├── PositionPanel      — Expandable positions with PnL animation
├── OrderBook          — If applicable
└── InsuranceLP        — Collapsible panel

Markets (markets/page.tsx)
├── FilterBar          — Animated filter chips
├── MarketGrid         — Staggered entrance, hover effects
└── MarketCard         — Glass card with live stats

Create (create/page.tsx)
├── StepProgress       — Animated progress indicator
├── StepContent        — Slide transitions
└── SuccessView        — Celebration animation
```

## Dependencies to Add
```json
{
  "gsap": "^3.12.0",
  "@gsap/react": "^2.1.0",
  "next-themes": "^0.4.0"
}
```

Note: GSAP is free for standard use. ScrollTrigger, SplitText are included in the free tier for non-commercial. Since we're open source / devnet, this is fine. For mainnet commercial use, GSAP Club membership ($99/yr) may be needed for SplitText — or we can implement our own text splitting.

## Implementation Order
1. **Foundation** (Phase 1) — Install GSAP, new color system, typography, GlassCard, GradientBorder, ShimmerSkeleton
2. **Homepage** (Phase 2) — Full hero redesign with animations, stats, how-it-works, features
3. **Trade Page** (Phase 3) — Glass morphism panels, animated numbers, position animations
4. **Markets & Create** (Phase 4) — Market cards, quick launch step animations
5. **Polish** (Phase 5) — Page transitions, micro-interactions, performance audit

## Performance Budget
- GSAP core: ~30KB gzipped (acceptable)
- ScrollTrigger: ~10KB gzipped
- Total animation overhead: <50KB
- All animations must be GPU-accelerated (transform, opacity only)
- Use `will-change` sparingly
- Disable heavy animations on mobile / prefers-reduced-motion
- No layout thrashing — measure then batch

## What Makes This Different From MidTermDev
MidTermDev's UI is functional but plain — standard DeFi terminal look. Our differentiators:
1. **Glass morphism** — premium feel vs flat cards
2. **GSAP animations** — everything feels alive and responsive
3. **Color identity** — "Neon Obsidian" palette is distinctive
4. **Micro-interactions** — every click, hover, scroll has feedback
5. **Typography** — proper hierarchy with monospace numbers
6. **Homepage** — marketing-grade landing page, not just a list of markets
