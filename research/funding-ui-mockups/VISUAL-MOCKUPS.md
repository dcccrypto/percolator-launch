# Funding Rate UI - Visual Mockups

**Note:** These are text-based mockups. Actual screenshots to be added after UI is running.

---

## 1. FundingRateCard - Current Rate Display

```
┌─────────────────────────────────────────────┐
│ FUNDING RATE  ⓘ Learn more                 │
├─────────────────────────────────────────────┤
│                                             │
│  +0.0042%                    +36.79% APR   │
│  per hour                                   │
│                                             │
├─────────────────────────────────────────────┤
│ │ Longs pay shorts                          │
│ │ Next funding in 3h 24m                    │
└─────────────────────────────────────────────┘
│ YOUR EST. FUNDING (24H)                     │
│                              -$5.12  ◄─RED  │
│ Based on your LONG position                 │
└─────────────────────────────────────────────┘
```

**Color Coding:**
- **+0.0042%** → RED (positive rate = longs pay)
- **-$5.12** → RED (user is long, so they pay)
- **Border-left accent** → RED bar

---

## 2. FundingRateCard - Receiving Funding

```
┌─────────────────────────────────────────────┐
│ FUNDING RATE  ⓘ Learn more                 │
├─────────────────────────────────────────────┤
│                                             │
│  -0.0018%                    -15.77% APR   │
│  per hour                                   │
│                                             │
├─────────────────────────────────────────────┤
│ │ Shorts pay longs                          │
│ │ Next funding in 2h 47m                    │
└─────────────────────────────────────────────┘
│ YOUR EST. FUNDING (24H)                     │
│                              +$2.34  ◄─GREEN│
│ Based on your LONG position                 │
└─────────────────────────────────────────────┘
```

**Color Coding:**
- **-0.0018%** → GREEN (negative rate)
- **+$2.34** → GREEN (user is long, rate is negative, so they receive)

---

## 3. FundingRateChart - Historical 24h

```
┌─────────────────────────────────────────────┐
│ FUNDING RATE (24H)                          │
│                              +0.0052%/h     │
│                              12:34 PM       │
├─────────────────────────────────────────────┤
│  0.006% ┤                                   │
│  0.004% ┤        ╱╲     ╱╲                  │
│  0.002% ┤     ╱─╱  ╲───╱  ╲───              │
│  0.000% ┼────────────────────────────────   │ ← Zero line
│ -0.002% ┤                      ╲╱           │
│ -0.004% ┤                                   │
│         └────────────────────────────────   │
│         6am    12pm   6pm    12am   6am     │
└─────────────────────────────────────────────┘
```

**Visual Features:**
- **RED shaded zone** → Above zero line (longs pay)
- **GREEN shaded zone** → Below zero line (shorts pay)
- **Dashed zero line** → Gray
- **Accent line** → Main chart line color
- **Hover tooltip** → Shows exact rate + timestamp

---

## 4. Explainer Modal - Full Screen

```
╔═════════════════════════════════════════════╗
║ Understanding Funding Rates            ✕   ║
╠═════════════════════════════════════════════╣
║                                             ║
║ What are funding rates?                     ║
║ ───────────────────────────────────────     ║
║ Funding rates are periodic payments         ║
║ between traders that help keep perpetual    ║
║ futures prices aligned with the spot...     ║
║                                             ║
║ Why do they exist?                          ║
║ ───────────────────────────────────────     ║
║ Unlike traditional futures, perpetual       ║
║ contracts have no expiration date...        ║
║                                             ║
║ ┌───────────────────────────────────────┐   ║
║ │ Percolator's Inventory-Based Funding  │   ║ ← Accent box
║ │                                       │   ║
║ │ When traders open positions, LPs take │   ║
║ │ the opposite side. Funding rates...   │   ║
║ └───────────────────────────────────────┘   ║
║                                             ║
║ When do you pay vs receive?                 ║
║ ───────────────────────────────────────     ║
║ ┌───────────────────────────────────────┐   ║
║ │ ✓ You Receive Funding                 │   ║ ← Green box
║ │ • You're LONG and rate is negative    │   ║
║ │ • You're SHORT and rate is positive   │   ║
║ └───────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────┐   ║
║ │ ⚠ You Pay Funding                     │   ║ ← Red box
║ │ • You're LONG and rate is positive    │   ║
║ │ • You're SHORT and rate is negative   │   ║
║ └───────────────────────────────────────┘   ║
║                                             ║
║ [Scroll for more...]                        ║
║                                             ║
╠═════════════════════════════════════════════╣
║             [ Got it ]                      ║
╚═════════════════════════════════════════════╝
```

**Features:**
- Full-screen overlay with backdrop blur
- Scrollable content (6+ sections)
- Color-coded example boxes
- Sticky header + footer
- ESC to close, click overlay to dismiss

---

## 5. Position Panel - Updated

```
┌─────────────────────────────────────────────┐
│ UNREALIZED PNL                              │
│                          +123.45 SOL (+$X) │ ← Green
│ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░    │ ← Progress bar
│ ROE: +12.34%                                │
└─────────────────────────────────────────────┘
│                                             │
│ Direction          LONG                     │
│ Size               50.00 SOL                │
│ Entry Price        $150.25                  │
│ Market Price       $152.75                  │
│ Liq. Price         $142.50                  │
│ Margin Health      95.2%                    │
│ Est. Funding (24h) -$5.12        ◄── NEW    │ ← Red (paying)
│                                             │
└─────────────────────────────────────────────┘
```

**Color Logic:**
- **Red (-$5.12)** → User is paying funding
- **Green (+$2.34)** → User is receiving funding
- Row follows same style as other position details

---

## 6. MarketStatsCard Integration

```
┌─────────────────────────────────────────────┐
│ SOL Price       Open Interest    Vault      │
│ $152.75         1,234.5 SOL      5,678 SOL  │
│                                             │
│ Trading Fee     Init. Margin     Accounts   │
│ 0.10%          10.00%            42         │
└─────────────────────────────────────────────┘
  ↓ (new section below)
┌─────────────────────────────────────────────┐
│ FUNDING RATE  ⓘ Learn more                 │
│                                             │
│  +0.0042%                    +36.79% APR   │
│  per hour                                   │
│                                             │
│ │ Longs pay shorts                          │
│ │ Next funding in 3h 24m                    │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│        [ Show Funding History ]             │
└─────────────────────────────────────────────┘
  ↓ (when expanded)
┌─────────────────────────────────────────────┐
│ FUNDING RATE (24H)                          │
│ [Chart here]                                │
└─────────────────────────────────────────────┘
```

**Layout:**
- **Vertical stack** → Stats grid → Funding card → Toggle → Chart
- **Collapsible chart** → Saves space, user opt-in
- **Mobile:** Same layout, full width

---

## 7. Desktop Trade Page - Full Context

```
┌─────────────────────────────────────────────────────────────────────┐
│ // TRADE  SOL/USD PERP    $152.75      ◉ Healthy  [tokens|USD]     │
├─────────────────────────────────────────────────────────────────────┤
│                                │                                    │
│  ┌──────────────────────────┐  │  ┌──────────────────────────────┐ │
│  │                          │  │  │ LONG/SHORT  [MAX]  [CLEAR]   │ │
│  │    [Price Chart]         │  │  │                              │ │
│  │                          │  │  │ Size:  ▓▓▓▓▓▓▓▓░░  50 SOL   │ │
│  │                          │  │  │ Leverage: 10x                │ │
│  │                          │  │  │                              │ │
│  └──────────────────────────┘  │  │ [ Submit Long ]              │ │
│                                │  └──────────────────────────────┘ │
│  [Position|Positions|Deposit]  │                                   │
│  ┌──────────────────────────┐  │  [Stats|Trades|Health|Book]      │
│  │ [Position Panel]         │  │  ┌──────────────────────────────┐│
│  │ Unrealized PnL: +$123.45 │  │  │ SOL Price    $152.75         ││
│  │ ...                      │  │  │ Open Interest 1,234 SOL      ││
│  │ Est. Funding: -$5.12  ←  │  │  └──────────────────────────────┘│
│  └──────────────────────────┘  │  ┌──────────────────────────────┐│
│                                │  │ FUNDING RATE  ⓘ Learn more   ││ ← NEW
│                                │  │ +0.0042%/h    +36.79% APR    ││
│                                │  │ Longs pay shorts             ││
│                                │  │ Next in 3h 24m               ││
│                                │  └──────────────────────────────┘│
│                                │  [ Show Funding History ]        │
└─────────────────────────────────────────────────────────────────────┘
```

**Integration Points:**
1. **Position Panel** → Shows funding estimate in position details
2. **Stats Tab** → Shows full funding card + chart toggle
3. **Always visible** → Funding card appears in Stats (default desktop view)

---

## 8. Mobile Trade Page

```
┌───────────────────────────────┐
│ SOL/USD PERP        $152.75  │
│ @ABcd...1234  [Share] ◉      │
├───────────────────────────────┤
│ [────── Price Chart ──────]  │
│                              │
├───────────────────────────────┤
│ [────── Trade Form ──────]   │
│ LONG/SHORT   [MAX]  [CLEAR]  │
│ Size: 50 SOL   Leverage: 10x │
│ [ Submit Long ]              │
├───────────────────────────────┤
│ ▼ Position                   │
│ Unrealized PnL: +$123.45     │
│ Est. Funding: -$5.12      ←  │
├───────────────────────────────┤
│ ▶ Deposit / Withdraw         │
│ (collapsed)                  │
├───────────────────────────────┤
│ [Stats|Trades|Book]          │
│                              │
│ ┌───────────────────────────┐│
│ │ SOL Price    $152.75      ││
│ │ Open Interest 1,234 SOL   ││
│ └───────────────────────────┘│
│ ┌───────────────────────────┐│
│ │ FUNDING RATE  ⓘ           ││ ← NEW
│ │ +0.0042%/h   +36.79% APR  ││
│ │ Longs pay shorts          ││
│ │ Next in 3h 24m            ││
│ └───────────────────────────┘│
│ [ Show Funding History ]     │
│ (taps to expand chart)       │
└───────────────────────────────┘
```

**Mobile Adaptations:**
- Collapsible sections save space
- Full-width cards
- Chart expands in-place (no modal)
- Touch-friendly tap targets

---

## Color Reference

```
Funding Rate Colors:
├─ Positive rate (+0.0042%)     → RED (#FF3B5C)   [longs pay]
├─ Negative rate (-0.0018%)     → GREEN (#14F195) [shorts pay]
├─ Neutral (0.0000%)            → GRAY (#888)
│
User Impact Colors:
├─ You PAY funding              → RED (#FF3B5C)
├─ You RECEIVE funding          → GREEN (#14F195)
├─ No position                  → GRAY (#888)
│
Chart Colors:
├─ Main line                    → ACCENT (#00D4FF)
├─ Positive zone (above zero)   → RED fill (opacity 0.15)
├─ Negative zone (below zero)   → GREEN fill (opacity 0.15)
└─ Zero line                    → GRAY dashed
```

---

## Typography Hierarchy

```
H1: Modal Title
├─ Font: Display
├─ Size: 18px / 1.125rem
└─ Weight: Bold

H2: Section Headers
├─ Font: Display
├─ Size: 14px / 0.875rem
└─ Weight: Bold

H3: Card Headers
├─ Font: Sans
├─ Size: 10px / 0.625rem
├─ Weight: Medium
├─ Transform: Uppercase
└─ Tracking: 0.15em

Body: Main Rate Display
├─ Font: Mono
├─ Size: 24px / 1.5rem
└─ Weight: Bold

Body: Sub-rates (APR)
├─ Font: Mono
├─ Size: 12px / 0.75rem
└─ Weight: Normal

Body: Labels
├─ Font: Sans
├─ Size: 10px / 0.625rem
├─ Transform: Uppercase
└─ Tracking: 0.15em

Body: Values
├─ Font: Mono
├─ Size: 11px / 0.6875rem
└─ Weight: Medium
```

---

## Spacing & Layout

```
Card Padding:
├─ Default: p-3 (12px)
├─ Modal: p-6 (24px)
└─ Nested sections: p-2 (8px)

Gaps:
├─ Vertical stack: gap-1.5 / space-y-1.5 (6px)
├─ Horizontal items: gap-2 (8px)
└─ Grid cells: gap-px (1px borders)

Border Radius:
└─ ALL: rounded-none (0px) ← Brand style

Border Width:
├─ Cards: border (1px)
├─ Accent borders: border-l-2 (2px left)
└─ Grid cell dividers: border-b/border-r (1px)
```

---

## Animation Timing

```
GSAP Animations:
├─ Modal fade in: 0.2s ease-out
├─ Modal scale in: 0.25s ease-out
├─ Tooltip fade: 0.15s ease-out
└─ Hover transitions: 0.15s ease

CSS Transitions:
├─ Button hover: 150ms
├─ Color change: 200ms
└─ PnL bar width: 500ms

Reduced Motion:
└─ All animations → instant (0ms)
```

---

## Interaction States

```
Buttons:
├─ Default: border-[var(--border)] text-[var(--text-secondary)]
├─ Hover: bg-[var(--bg-elevated)] text-[var(--text)]
└─ Active: bg-[var(--accent)]/10

Toggle Button (Funding Chart):
├─ Collapsed: "Show Funding History"
└─ Expanded: "Hide Funding History"

Info Icon:
├─ Default: text-[var(--text-muted)]
├─ Hover: text-[var(--text-secondary)]
└─ Action: Opens explainer modal

Modal:
├─ Backdrop: Click to close
├─ ESC: Keyboard shortcut
└─ X button: Explicit close
```

---

## Responsive Breakpoints

```
< 640px (Mobile S):
└─ Single column, full-width cards

640px - 1024px (Mobile L / Tablet):
└─ Same as mobile, slightly more padding

≥ 1024px (Desktop):
└─ Two-column layout, right sidebar sticky
```

---

## Conclusion

These mockups provide a visual reference for the implemented components. Actual screenshots will be added once the UI is running in the browser.

**Key Visual Principles:**
1. **Consistency** → Matches existing Percolator design system
2. **Clarity** → Rates and estimates are immediately readable
3. **Education** → Modal explains complex concepts simply
4. **Responsiveness** → Works on all screen sizes
5. **Accessibility** → High contrast, semantic structure

**Ready for screenshot capture** after `pnpm dev` runs successfully.
