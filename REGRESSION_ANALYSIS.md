# Percolator Frontend Regression Analysis
**Date:** 2026-02-11  
**PRs Analyzed:** #97-102 (Market Discovery Backend Migration)  
**Analyst:** Cobra (Subagent)

---

## Executive Summary

**CRITICAL REGRESSIONS FOUND:**

1. ✅ **apiToDiscovered() mapping is INCOMPLETE** - Missing ~70% of required fields
2. ⚠️ **tokenMetas useEffect has potential stale closure issue** - Low risk but exists
3. ✅ **RPC URL config looks correct** - No issues found
4. ✅ **WalletProvider fallback is correct** - No issues found  
5. ✅ **No Helius-specific API dependencies found** - Safe to use other RPC providers

---

## 1. useMarketDiscovery.ts - apiToDiscovered() Mapping

### CRITICAL ISSUE: Incomplete Field Mapping

The `apiToDiscovered()` function converts backend API response to `DiscoveredMarket` type, but is **missing the majority of required fields**.

#### Required Fields by Interface:

**SlabHeader (9 fields):**
- ✅ magic (mocked as 0n)
- ✅ version (mocked as 0)
- ❌ **bump** - MISSING
- ❌ **flags** - MISSING
- ✅ resolved
- ❌ **paused** - MISSING
- ✅ admin
- ❌ **nonce** - MISSING
- ❌ **lastThrUpdateSlot** - MISSING

**MarketConfig (16+ fields):**
- ✅ collateralMint
- ✅ vaultPubkey
- ✅ indexFeedId
- ❌ **maxStalenessSlots** - MISSING
- ❌ **confFilterBps** - MISSING
- ❌ **vaultAuthorityBump** - MISSING
- ❌ **invert** - MISSING
- ❌ **unitScale** - MISSING
- ❌ **fundingHorizonSlots** - MISSING
- ❌ **fundingKBps** - MISSING
- ❌ **fundingInvScaleNotionalE6** - MISSING
- ❌ **fundingMaxPremiumBps** - MISSING
- ❌ **fundingMaxBpsPerSlot** - MISSING
- ⚠️ **oracleAuthority** - EXTRA field (not in MarketConfig interface)
- ⚠️ **authorityPriceE6** - EXTRA field (not in MarketConfig interface)
- ⚠️ **lastEffectivePriceE6** - EXTRA field (not in MarketConfig interface)

**EngineState (26 fields):**
- ✅ vault
- ✅ totalOpenInterest
- ✅ cTot
- ✅ numUsedAccounts
- ✅ lastCrankSlot
- ✅ insuranceFund.balance
- ❌ **insuranceFund.feeRevenue** - MISSING
- ❌ **currentSlot** - MISSING
- ❌ **fundingIndexQpbE6** - MISSING
- ❌ **lastFundingSlot** - MISSING
- ❌ **fundingRateBpsPerSlotLast** - MISSING
- ❌ **maxCrankStalenessSlots** - MISSING
- ❌ **pnlPosTot** - MISSING
- ❌ **liqCursor** - MISSING
- ❌ **gcCursor** - MISSING
- ❌ **lastSweepStartSlot** - MISSING
- ❌ **lastSweepCompleteSlot** - MISSING
- ❌ **crankCursor** - MISSING
- ❌ **sweepStartIdx** - MISSING
- ❌ **lifetimeLiquidations** - MISSING
- ❌ **lifetimeForceCloses** - MISSING
- ❌ **netLpPos** - MISSING
- ❌ **lpSumAbs** - MISSING
- ❌ **lpMaxAbs** - MISSING
- ❌ **lpMaxAbsSweep** - MISSING
- ❌ **nextAccountId** - MISSING

**RiskParams (13 fields):**
- ✅ initialMarginBps
- ✅ maintenanceMarginBps
- ❌ **warmupPeriodSlots** - MISSING
- ❌ **tradingFeeBps** - MISSING
- ❌ **maxAccounts** - MISSING
- ❌ **newAccountFee** - MISSING
- ❌ **riskReductionThreshold** - MISSING
- ❌ **maintenanceFeePerSlot** - MISSING
- ❌ **maxCrankStalenessSlots** - MISSING
- ❌ **liquidationFeeBps** - MISSING
- ❌ **liquidationFeeCap** - MISSING
- ❌ **liquidationBufferBps** - MISSING
- ❌ **minLiquidationAbs** - MISSING

### Impact Analysis:

**Currently Working (Low Risk):**
- ✅ Markets page only uses: `totalOpenInterest`, `cTot`, `insuranceFund.balance`
- ✅ `computeMarketHealth()` only needs these 3 fields
- ✅ Market sorting/filtering works with available fields

**Potentially Broken (High Risk):**
- ❌ Any future component that accesses missing engine/config/params fields will crash
- ❌ Type safety is violated - `as unknown as DiscoveredMarket` masks the problem
- ❌ Backend API doesn't provide funding rate data, so funding display would fail
- ❌ Components expecting full slab state from discovered markets will fail

### Recommendation:

**Option 1 (Quick Fix):** Document that `useMarketDiscovery` returns **partial** market data suitable only for listing/browsing. Components needing full state should use `SlabProvider` which fetches directly from RPC.

**Option 2 (Proper Fix):** Extend backend API `/markets` endpoint to return ALL required fields, then update `apiToDiscovered()` mapping.

**Option 3 (Hybrid):** Keep current API for performance, but mark the returned type as `Partial<DiscoveredMarket>` and update consumers to handle missing fields gracefully.

---

## 2. app/markets/page.tsx - tokenMetas useEffect

### Issue: Potential Stale Closure (Low Risk)

```typescript
useEffect(() => {
  // ... fetch logic ...
  Promise.all(...).then((results) => {
    if (cancelled) return;
    const newMap = new Map(tokenMetas); // ⚠️ Reads tokenMetas from closure
    for (const r of results) {
      if (r) newMap.set(r.mint, r.meta);
    }
    setTokenMetas(newMap);
  });
  return () => { cancelled = true; };
}, [discovered, supabaseMarkets, connection]); // ⚠️ tokenMetas not in deps
```

### Analysis:

**No Infinite Loop Risk:**
- Effect only runs when `discovered` or `supabaseMarkets` change
- Early return if `mintsToFetch.length === 0` prevents unnecessary fetches
- Cleanup function (`cancelled = true`) prevents state updates after unmount

**Stale Closure Risk (Low):**
- `tokenMetas` is read from closure but not in dependency array
- If effect re-runs while previous fetch is pending, the second fetch will merge with stale `tokenMetas`
- This would only cause missing metadata if:
  1. New markets are discovered mid-fetch
  2. First fetch completes after second fetch starts
  3. Very unlikely race condition

**No Memory Leak:**
- Cleanup function properly cancels pending work
- No event listeners or subscriptions without cleanup

### Recommendation:

**Low priority fix:** Use functional setState to avoid stale closure:

```typescript
setTokenMetas(prev => {
  const newMap = new Map(prev);
  for (const r of results) {
    if (r) newMap.set(r.mint, r.meta);
  }
  return newMap;
});
```

---

## 3. lib/config.ts - RPC URL Configuration

### Status: ✅ CORRECT

**Devnet:**
```typescript
rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com",
```
- ✅ Uses env var with public Solana RPC fallback
- ✅ Comment correctly notes Helius is rate-limited on devnet
- ✅ No hardcoded Helius dependency

**Mainnet:**
```typescript
rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`,
```
- ✅ Helius for mainnet is intentional (higher rate limits)
- ⚠️ Security warning correctly notes client-side exposure
- ✅ Env var allows override for production proxy

### No Issues Found

---

## 4. WalletProvider.tsx - Fallback Logic

### Status: ✅ CORRECT

```typescript
const rpcUrl = useMemo(() => {
  const url = getConfig().rpcUrl;
  // Fallback for SSG/build time when env vars may be unavailable
  if (!url || !url.startsWith("http")) return "https://api.devnet.solana.com";
  return url;
}, []);
```

**Analysis:**
- ✅ Handles SSG/build-time when env vars unavailable
- ✅ Validates URL before use
- ✅ Safe fallback to public devnet RPC
- ✅ useMemo prevents unnecessary recalculations

### No Issues Found

---

## 5. Helius-Specific Dependencies

### Grep Results:

Found in:
- `app/scripts/` - Dev/test scripts (not production code)
- `app/app/api/` - Server-side API routes (not frontend)
- `app/middleware.ts` - CSP headers (allows Helius in connect-src)
- `app/lib/config.ts` - RPC URLs (addressed above)
- `app/devnet-mint/devnet-mint-content.tsx` - Devnet faucet tool

### Analysis:

**No Helius-Specific APIs Used:**
- ❌ No DAS (Digital Asset Standard) calls
- ❌ No `getPriorityFeeEstimate()` calls  
- ❌ No Helius webhooks or subscriptions
- ❌ No enhanced transaction APIs

**Standard Solana RPC Only:**
- ✅ `getProgramAccounts` (standard)
- ✅ `getAccountInfo` (standard)
- ✅ `sendTransaction` (standard)
- ✅ Token metadata from on-chain accounts (standard)

### Recommendation:

✅ **Safe to switch RPC providers** - Frontend uses only standard Solana RPC methods. Helius can be replaced with QuickNode, Triton, or public RPCs without code changes.

---

## Summary of Regressions

| Issue | Severity | Impact | Status |
|-------|----------|--------|--------|
| apiToDiscovered() incomplete mapping | 🔴 **CRITICAL** | Future components may crash accessing missing fields | **MUST FIX** |
| tokenMetas stale closure | 🟡 **LOW** | Rare race condition could lose metadata | Optional |
| RPC config | 🟢 **OK** | No issues | ✅ |
| WalletProvider fallback | 🟢 **OK** | No issues | ✅ |
| Helius dependencies | 🟢 **OK** | No vendor lock-in | ✅ |

---

## Recommended Actions

1. **IMMEDIATE:** Document `useMarketDiscovery` limitations - it returns partial data only suitable for listing, not full market operations
2. **SHORT TERM:** Fix `apiToDiscovered()` type to `Partial<DiscoveredMarket>` to prevent silent failures
3. **MEDIUM TERM:** Extend backend API to return all required fields OR deprecate backend API in favor of direct RPC discovery
4. **OPTIONAL:** Fix tokenMetas useEffect to use functional setState

---

## Test Coverage Gaps

The following scenarios should be tested:

1. ✅ Markets page renders with API data (currently works)
2. ❌ Component tries to access `engine.fundingIndexQpbE6` from discovered market (will crash)
3. ❌ Component tries to access `params.tradingFeeBps` from discovered market (will crash)
4. ❌ Backend API returns partial data (currently happens, masked by `as unknown`)
5. ✅ RPC fallback when backend API fails (currently works)

---

**End of Report**
