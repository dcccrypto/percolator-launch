# Simulation Dashboard Fix — Summary

**Date:** 2026-02-15  
**Branch:** cobra/fix/sim-dashboard  
**Status:** ✅ FIXED

---

## Problem
When simulation is in "running" phase, the dashboard showed:
- ❌ $1.00 price (never updating)
- ❌ No bot activity
- ❌ No trade counts, liquidations, or stats

---

## Root Causes Identified

### 1. Stats Parsing Bug
**Issue:** Railway returns stats in nested object with bigints as strings:
```json
{
  "price": 150.25,
  "stats": {
    "tradesCount": 42,
    "fundingRate": "150",        // bps as string
    "openInterest": "15000000"   // E6 as string
  }
}
```

Frontend was trying to read:
```typescript
data.totalTrades    // ❌ Doesn't exist
data.fundingRate    // ❌ Doesn't exist
```

**Fix:** Parse from nested stats object and convert types:
```typescript
const totalTrades = data.stats?.tradesCount ?? 0;
const fundingRate = parseFloat(data.stats?.fundingRate || "0") / 10000;
const openInterest = parseFloat(data.stats?.openInterest || "0") / 1e6;
```

### 2. Environment Variable Mismatch
**Issue:** `app/lib/railway.ts` used wrong env var name
```typescript
// WRONG - not set anywhere
process.env.NEXT_PUBLIC_RAILWAY_URL

// CORRECT - set in .env.local  
process.env.NEXT_PUBLIC_API_URL
```

**Fix:** Updated railway.ts to use `NEXT_PUBLIC_API_URL`

### 3. CORS Blocking Vercel Previews
**Issue:** Railway backend only allowed:
- `https://percolatorlaunch.com`
- `http://localhost:3000`

Preview URLs like `percolator-launch-git-*.vercel.app` were blocked.

**Fix:** Added auto-allow for `*.vercel.app` domains:
```typescript
origin: (origin) => {
  if (!origin || allowedOrigins.includes(origin)) return origin;
  if (origin.endsWith('.vercel.app')) return origin;
  return allowedOrigins[0];
}
```

### 4. Duplicate API Routes
**Issue:** Local `/app/app/api/simulation/*` routes existed alongside Railway endpoints, creating confusion.

**Fix:** Deleted local routes — all simulation calls now go directly to Railway.

### 5. Silent Failures
**Issue:** Network errors were swallowed with `catch { /* ignore */ }`

**Fix:** Added error logging and user-facing error messages:
```typescript
if (!res.ok) {
  console.error(`Railway API error: ${res.status}`);
  setError(`Simulation backend unreachable (${res.status})`);
  return;
}
```

---

## Changes Made

### Files Modified:
1. ✅ `app/lib/railway.ts` — Use correct env var
2. ✅ `app/app/simulation/page.tsx` — Parse stats, add error handling
3. ✅ `packages/server/src/index.ts` — Allow Vercel preview URLs
4. ✅ `packages/server/.env.example` — Document CORS config

### Files Deleted:
5. ✅ `app/app/api/simulation/` — Removed duplicate local routes

---

## Testing Checklist

### Local Testing ✅
- [x] Price updates every 3 seconds
- [x] Bot leaderboard populates with 5 bots
- [x] Trade count increments
- [x] Liquidations tracked
- [x] Funding rate displays
- [x] Open interest shows
- [x] Scenario selector works (crash/squeeze/volatile/calm)
- [x] Error message shown if Railway down

### Production Testing
- [ ] Deploy to Vercel preview
- [ ] Create simulation from preview URL
- [ ] Verify no CORS errors in console
- [ ] Monitor for 60 seconds, verify price updates
- [ ] Check bot activity appears
- [ ] Test scenario changes

---

## Architecture Verified

```
Frontend (Vercel)                    Railway Backend
┌─────────────────────┐             ┌──────────────────────┐
│ simulation/page.tsx │   GET /api/ │ SimulationService    │
│                     ├────────────►│                      │
│ railwayFetch()      │  simulation │ - Oracle price push  │
│ Poll every 3s       │             │ - 5 trading bots     │
│                     │◄────────────┤ - Stats tracking     │
│ Parse response:     │   JSON      │ - On-chain state     │
│ - price             │             │                      │
│ - stats.trades      │             │ Returns:             │
│ - stats.funding     │             │ {                    │
│ - stats.openInterest│             │   price,             │
│ - bots[]            │             │   stats: { ... },    │
└─────────────────────┘             │   bots: [ ... ]      │
                                    │ }                    │
                                    └──────────────────────┘
```

**Key Points:**
- ✅ Frontend correctly calls Railway (not local routes)
- ✅ Railway returns full state snapshot every poll
- ✅ Stats tracked on-chain AND in Railway
- ✅ Bot system works independently
- ✅ CORS allows all necessary origins

---

## Performance Impact
- **Before:** Dashboard frozen (no updates)
- **After:** Real-time updates every 3s
- **Network:** ~500 bytes per poll (minimal)
- **CPU:** Negligible (simple JSON parsing)

---

## Future Improvements
1. WebSocket for real-time updates (reduce polling)
2. Bot PnL calculation on frontend (instead of raw strings)
3. Historical scenario performance comparison
4. Export simulation results as JSON
5. Replay simulation from saved state

---

## Commit Messages
```
fix: simulation dashboard data flow

- Parse stats from nested Railway response (stats.tradesCount, etc)
- Convert bigint strings to numbers (fundingRate bps → decimal)
- Add error handling for Railway connection failures
- Standardize on NEXT_PUBLIC_API_URL env var
- Allow Vercel preview URLs in CORS
- Delete duplicate local API routes

Fixes: Dashboard showing $1 price and no activity
```

---

## Lessons Learned
1. **Always log API responses during debugging** — silent failures hide bugs
2. **Environment variables should be consistent** — standardize naming
3. **CORS must account for preview environments** — not just production
4. **Bigint serialization requires explicit handling** — JSON.stringify converts to strings
5. **Duplicate routes are tech debt** — remove as soon as redundant

---

## References
- Railway SimulationService: `/packages/server/src/services/SimulationService.ts`
- Frontend polling: `/app/app/simulation/page.tsx` line 708
- CORS config: `/packages/server/src/index.ts` line 43
- Environment vars: `/.env.local` + `/packages/server/.env`
