# Funding Rate UI - Design Decisions

## Research Summary (Feb 14, 2026)

### Competitor Analysis

**dYdX:**
- Location: Top bar, next to market price
- Format: Hourly % (e.g., "0.0042%/h")
- Countdown: "Next funding in 2h 34m"
- Color: Green (receiving) / Red (paying)
- Additional: Click for historical chart

**Drift:**
- Location: Dedicated section in market stats
- Format: Hourly + APR (e.g., "0.01% / 88% APR")
- Shows: "Longs pay" or "Shorts pay"
- Position estimate: "Est. funding: +$5.12/day"
- Chart: Historical 24h funding rate with tooltips

**Jupiter Perps:**
- Location: Market info panel
- Format: Hourly %
- Simple tooltip on hover
- Less prominent than Drift/dYdX

### Design Principles Applied

1. **Clarity over Clutter**
   - Show current rate prominently
   - Collapse historical data into tab/modal
   - Use plain language ("Longs pay shorts")

2. **Color Coding (Universal Standard)**
   - Green = You receive funding
   - Red = You pay funding
   - Gray = No position / neutral

3. **Show Dollar Amounts**
   - Traders care about "$" not just "%"
   - Position estimate: "You'll pay ~$5.12 over 24h"
   - More intuitive than "0.0042%/h"

4. **Educational First**
   - Info icon → explainer modal
   - Don't assume traders know what funding rates are
   - Explain Percolator's inventory-based mechanism

5. **Mobile Responsive**
   - Collapsible on mobile
   - Essential info always visible
   - Chart in separate tab

## Implementation Decisions

### Component Structure

```
FundingRateCard.tsx       → Main display (current rate, countdown, estimate)
FundingRateChart.tsx      → Historical 24h chart
FundingExplainerModal.tsx → Educational modal
PositionPanel.tsx         → Updated with funding estimate
```

### Layout Choice: **Market Stats Tab**

**Why not top bar?**
- Top bar already crowded (price, health badge, USD toggle)
- Mobile space constraints
- Percolator has tab-based info panels already

**Why Market Stats tab?**
✅ Consistent with existing UI patterns
✅ Room for detailed breakdown
✅ Can show chart inline
✅ Desktop: always visible in right panel
✅ Mobile: available in tabs

**Alternative considered:** Dedicated "Funding" tab alongside "Stats"/"Trades"
- Decided against: Increases tab count, fragments info
- Better: Integrate into Stats tab with toggle

### Data Format

**Display:**
- Current rate: `±0.0042%/h`
- Annualized: `±36.79% APR` (in tooltip)
- Direction: "Longs pay shorts" (explicit text)
- Countdown: "Next funding in 3h 24m"
- Position estimate: "You'll pay ~$5.12 over 24h"

**Color Logic:**
```
If no position:
  - Gray text
  - Show rate neutrally

If LONG position:
  - Rate > 0 → RED (you pay)
  - Rate < 0 → GREEN (you receive)
  
If SHORT position:
  - Rate > 0 → GREEN (you receive)
  - Rate < 0 → RED (you pay)
```

### Chart Design

- SVG line chart (match TradingChart.tsx style)
- X-axis: Time (last 24h)
- Y-axis: Rate %
- Positive zone: Light red background
- Negative zone: Light green background
- Zero line: Dashed gray
- Hover tooltip: Exact rate + timestamp

### API Endpoint

Expected: `GET /api/funding/:slab`

Response:
```json
{
  "currentRateBpsPerSlot": 5,
  "hourlyRatePercent": 0.0042,
  "aprPercent": 36.79,
  "direction": "long_pays_short",
  "nextFundingSlot": 123456789,
  "netLpPosition": 1500000,
  "history24h": [
    { "slot": 123400000, "rateBpsPerSlot": 3, "timestamp": 1707926400 },
    ...
  ]
}
```

## Mobile Adaptations

1. **Collapsible by default** (save space)
2. **Chart in separate modal** (tap "View History")
3. **Simplified display:**
   - Rate + direction only
   - Position estimate (if applicable)
   - No chart inline

## Accessibility

- ARIA labels for rate direction
- Tooltip keyboard accessible
- Chart screen reader text
- High contrast colors maintained

## Performance

- Fetch funding data every 30s (not every render)
- Cache historical data (5min TTL)
- No layout shift (skeleton loader)
- Lazy load chart component

## Next Steps

1. ✅ Create mockup documentation (this file)
2. → Build FundingRateCard component
3. → Build FundingRateChart component
4. → Build FundingExplainerModal component
5. → Update PositionPanel
6. → Integrate into MarketStatsCard
7. → Test with mock data
8. → Screenshot for demo

---

**Note:** Backend endpoint may not exist yet - use mock data initially, then switch to real API once available.
