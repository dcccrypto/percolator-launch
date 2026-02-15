# Deployment Status - Hidden Features Fix
**Time:** 2026-02-14 19:50 UTC  
**Issue:** Hidden features fields returning null in production  
**Root Cause:** StatsCollector not writing hidden features fields to database

---

## 🔧 FIX APPLIED (Commit 9131082)

### Changes Made:
1. **Restored working queries.ts** (Supabase-based, from commit 11295b4)
2. **Updated StatsCollector.ts** to write all hidden features:
   - `total_open_interest`
   - `net_lp_pos`
   - `lp_sum_abs`
   - `lp_max_abs`
   - `insurance_balance`
   - `insurance_fee_revenue`
3. **Added funding_history functions** (insertFundingHistory, getFundingHistory, getFundingHistorySince)
4. **Removed broken Express routes** (insurance.ts, oi.ts, warmup.ts)

### Code Verification ✅
```typescript
// StatsCollector.ts now writes hidden features:
total_open_interest: Number(engine.totalOpenInterest),
net_lp_pos: engine.netLpPos.toString(),
lp_sum_abs: Number(engine.lpSumAbs),
lp_max_abs: Number(engine.lpMaxAbs),
insurance_balance: Number(engine.insuranceFund.balance),
insurance_fee_revenue: Number(engine.insuranceFund.feeRevenue),
```

---

## 📊 CURRENT STATUS

### Database State (19:50 UTC):
- **market_stats rows:** 51 markets
- **Hidden features fields:** ALL NULL ❌
- **Last updated:** 2026-02-14 19:50:49 UTC (30s ago)
- **StatsCollector:** RUNNING but with OLD CODE

### Deployment Status:
- **GitHub:** Commit 9131082 pushed to main ✅
- **Railway:** Still running OLD CODE (uptime: 18+ hours) ⏳
- **Vercel:** Deployed commit 9e03503 (has view fix) ✅

### Test Results:
```bash
# Database query (19:50 UTC):
{
  "slab_address": "A4A5qw6ApZyobGUzSPdy1MvdccYUqDDmStDVJhYmzRxE",
  "total_open_interest": null,        ❌
  "insurance_balance": null,          ❌
  "net_lp_pos": null,                 ❌
  "lp_sum_abs": null,                 ❌
  "insurance_fee_revenue": null,      ❌
  "updated_at": "2026-02-14T19:50:49.61729+00:00"  ✅ (recent)
}
```

---

## ⏭️ NEXT STEPS

### 1. **WAIT FOR RAILWAY AUTO-DEPLOY** ⏳
Railway should auto-deploy from GitHub main branch push.

**How to verify:**
```bash
# Check Railway health endpoint for uptime reset
curl https://percolator-api-production.up.railway.app/health | jq '.uptimeMs'
# When deployment happens, uptimeMs will reset to < 60000 (< 1 min)
```

### 2. **MANUAL RAILWAY DEPLOY (if auto-deploy doesn't trigger)**
If Railway doesn't auto-deploy within 10 minutes:
- Log into Railway dashboard
- Navigate to `percolator-api` service
- Click "Deploy" → "Redeploy"

### 3. **VERIFY FIX (after Railway deploys)**
```bash
# Test 1: Check database fields are populated
curl -s 'https://ygvbajglkrwkbjdjyhxi.supabase.co/rest/v1/market_stats?select=slab_address,total_open_interest,insurance_balance&limit=1' \
  -H "apikey: YOUR_ANON_KEY" | jq

# Expected: total_open_interest and insurance_balance should have numbers, not null

# Test 2: Check Next.js API endpoint
curl https://percolator-launch.vercel.app/api/insurance/29J8xQJRvpx5bwqKd11pb8hHBJEJUQqgnn8inJ79DgHb | jq

# Expected: balance > "0", feeRevenue present

# Test 3: Check frontend (hard refresh)
open https://percolator-launch.vercel.app/trade/29J8xQJRvpx5bwqKd11pb8hHBJEJUQqgnn8inJ79DgHb
# Expected: Insurance Dashboard shows real data, not zeros
```

### 4. **MONITOR StatsCollector logs (Railway)**
After deploy, check Railway logs for:
```
[StatsCollector] Collected stats for 51 markets
```
Should run every 30 seconds.

---

## 🐛 TESTING COMPLETED

### Local Build ✅
```bash
cd packages/server && npm run build
# Result: CLEAN BUILD (no TypeScript errors)
```

### Database Schema ✅
- `market_stats` table has all 7 hidden features columns
- `markets_with_stats` view includes all hidden features columns (migration 008)

### API Endpoints ✅
- `/api/insurance/[slab]` - exists in Next.js
- `/api/open-interest/[slab]` - exists in Next.js
- `/api/stats` - working, returns global stats

---

## 📋 MONITORING CHECKLIST

After Railway deploys, verify:
- [ ] Railway uptime < 5 minutes (deployment happened)
- [ ] `total_open_interest` not null in database
- [ ] `insurance_balance` not null in database
- [ ] Insurance Dashboard shows real data on frontend
- [ ] No errors in Railway logs
- [ ] StatsCollector running every 30s

---

## 🚨 CRITICAL NOTES

1. **Railway MUST redeploy** - The fix is in GitHub but not deployed to production
2. **StatsCollector cycle:** Every 30 seconds, so data will populate immediately after deploy
3. **No schema changes needed** - All columns exist, just not populated
4. **Vercel already has the view fix** - Frontend will work once backend populates data

---

## 📦 FILES CHANGED

**Commit:** 9131082  
**Branch:** main  
**Pushed:** 2026-02-14 19:47 UTC

```
packages/server/src/db/queries.ts          (restored + added funding functions)
packages/server/src/services/StatsCollector.ts  (added hidden features writes)
packages/server/src/index.ts               (removed broken route imports)
packages/server/src/routes/insurance.ts    (deleted)
packages/server/src/routes/oi.ts           (deleted)
packages/server/src/routes/warmup.ts       (deleted)
```

---

**Status:** ⏳ WAITING FOR RAILWAY AUTO-DEPLOY  
**ETA:** 5-10 minutes  
**Next Check:** 2026-02-14 20:00 UTC
