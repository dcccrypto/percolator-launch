# Bug Bounty Verification Report

**Date:** Feb 12, 2026 21:13 UTC  
**Action:** Verified remaining bug reports after major fixes

---

## ✅ Bug #4: Token Names Missing (ALREADY FIXED)

**Reporter:** @Famer_2025  
**Wallet:** `AWjBNnqxmTEFnWgbcWLWrmvo1622pqXgRvdoQmahRAUf`  
**Severity:** LOW (UX enhancement)  
**Status:** ✅ **ALREADY FIXED** (no PR needed)

### Issue
Markets page showed token addresses instead of names.

### Verification
**File:** `app/app/markets/page.tsx` lines 447-454

**Symbol display:**
```typescript
{m.symbol ? `${m.symbol}/USD` 
  : tokenMetaMap.get(m.mintAddress)?.symbol 
    ? `${tokenMetaMap.get(m.mintAddress)!.symbol}/USD` 
    : shortenAddress(m.slabAddress)}
```

**Name display:**
```typescript
{m.name ? `${m.name} · ${shortenAddress(m.mintAddress)}` 
  : tokenMetaMap.get(m.mintAddress)?.name 
    ? `${tokenMetaMap.get(m.mintAddress)!.name} · ${shortenAddress(m.mintAddress)}` 
    : shortenAddress(m.mintAddress)}
```

**Current behavior:**
1. ✅ Shows token symbol from Supabase if available
2. ✅ Falls back to on-chain metadata via `useMultiTokenMeta` hook
3. ✅ Shows full token name below symbol
4. ✅ Displays mint address (shortened) as fallback

**Conclusion:** Token metadata is properly fetched and displayed. Bug #4 is already resolved.

---

## ✅ Bug #5: Width Misalignment (FIXED BY PR #133)

**Reporter:** @vipultr  
**Wallet:** `Af5bTkfT7wW8UTEcaJHWB9vmkBmpPB8P9UGzwifBci7H`  
**Severity:** LOW (cosmetic)  
**Status:** ✅ **FIXED BY PR #133** (Bloomberg UI overhaul)

### Issue
Trade panel width extended beyond container, broke layout alignment.

### Verification
**File:** `app/app/trade/[slab]/page.tsx`

**Main container (line 124):**
```typescript
<div ref={pageRef} className="mx-auto max-w-7xl overflow-x-hidden gsap-fade">
```

**Desktop layout (line 242):**
```typescript
<div className="hidden lg:grid grid-cols-[1fr_340px] gap-1.5 px-3 pb-3 pt-1.5">
  {/* Left column: Chart + tabs */}
  <div className="min-w-0 space-y-1.5">...</div>
  
  {/* Right column: TradeForm (fixed 340px width) */}
  <div className="min-w-0 space-y-1.5">
    <div className="sticky top-0 z-20">
      <ErrorBoundary label="TradeForm">
        <TradeForm slabAddress={slab} />
      </ErrorBoundary>
    </div>
  </div>
</div>
```

**Current layout constraints:**
1. ✅ Main container: `max-w-7xl` with `overflow-x-hidden`
2. ✅ Desktop 2-column grid: left `1fr`, right `340px` fixed width
3. ✅ Trade form constrained by parent `340px` column
4. ✅ All child elements use `w-full` (100% of parent), no overflow

**Conclusion:** PR #133 (merged Feb 12 18:03 UTC) completely refactored the trade page layout with proper width constraints. Bug #5 is resolved.

---

## ❌ Bug #6: Devnet Faucet Issues (EXTERNAL - NOT OUR BUG)

**Reporter:** @matchamaxxer  
**Wallet:** `5mWPpC4xbT91F7P6yyHTMsq7WiqzCHVbdLUFW7SEovcC`  
**Severity:** N/A (external dependency)  
**Status:** ❌ **NOT ACTIONABLE**

### Issue
"Confirm Airdrop" button shows no feedback or infinite loading.

### Clarification
Per Khubair:
> "the devnet faucet is not ours its the main solana faucet"

This is **faucet.solana.com**, not Percolator's faucet.

**Recommendation:** 
- Mark bug report as EXTERNAL
- Cannot fix (we don't control Solana's faucet)
- Suggest reporter use alternative devnet faucets if faucet.solana.com is down

---

## ⚠️ Bug #7: Bitget "Risk Token" Warning (EXTERNAL - WALLET-SPECIFIC)

**Reporter:** @coinhunter0022  
**Wallet:** `Fg8AK7mx6sWnS2oJd8RusCdf3ux2eccKkPg48m15GeEe`  
**Severity:** MEDIUM (affects Bitget wallet users only)  
**Status:** ⚠️ **REQUIRES INVESTIGATION**

### Issue
Bitget wallet shows "Suspected risk token" warning, hides value/PnL data.

Reporter mentions: "@liquid had same issue but they fix it."

### Analysis

**Possible causes:**
1. Missing token verification with Bitget
2. Missing token metadata (name, symbol, logo)
3. Token contract not recognized by Bitget's risk scanner
4. New tokens automatically flagged until verified

**Not directly fixable on our end because:**
- Bitget maintains internal risk assessment database
- Wallets apply their own token screening
- May require direct communication with Bitget

**Potential solutions to investigate:**
1. **Token metadata verification**
   - Ensure Percolator token has proper Metaplex metadata
   - Verify logo URI is accessible
   - Check if token is in Jupiter token list

2. **Contact Bitget**
   - Research Bitget's token verification process
   - Submit token for verification (if process exists)
   - Reference MemeLiquid's fix (what did they do?)

3. **Workaround documentation**
   - Document issue in FAQ
   - Provide steps for users to dismiss warning (if possible)
   - Recommend alternative wallets for testing

**Recommendation:** LOW PRIORITY
- Wallet-specific issue (only affects Bitget users)
- No security risk (just a UX warning)
- Investigate MemeLiquid's solution when time allows
- May not be fixable without Bitget cooperation

---

## 📊 Summary

### Bugs Fixed Today (5 total)
1. ✅ Bug #1: LP initialize fails (PR #130) - CRITICAL
2. ✅ Bug #2: "You'll receive" wrong (PR #130) - CRITICAL
3. ✅ Bug #3: Margin 1000x wrong (PR #130) - CRITICAL
4. ✅ Bug #8: RPC URL template literal (PR #138) - HIGH
5. ✅ Bug #9: encodeInitMarket API drift (PR #139) - CRITICAL

### Bugs Already Fixed (2 total)
6. ✅ Bug #4: Token names missing - ALREADY RESOLVED (no PR needed)
7. ✅ Bug #5: Width misalignment - FIXED BY PR #133 (Feb 12 18:03 UTC)

### External/Not Actionable (2 total)
8. ❌ Bug #6: Devnet faucet - EXTERNAL (Solana's faucet, not ours)
9. ⚠️ Bug #7: Bitget warning - EXTERNAL (wallet-specific, requires investigation)

---

## 🎯 Final Status

**All actionable bugs:** ✅ **FIXED**  
**All bounties:** ⏳ **MARKED UNPAID** (awaiting payment approval)

**Reporters to pay:**
- @vip_ultr (Bug #1)
- @RealCypherDuck (Bugs #2, #3)
- @Famer_2025 (Bug #4 - already fixed, may choose not to pay)
- @vipultr (Bug #5 - fixed by PR #133, may choose not to pay)
- @sharpmetaa (Bugs #8, #9)

**Bounty recommendations:**
- CRITICAL bugs: $100-150 each
- HIGH bugs: $50-75 each
- LOW bugs (if paying): $25-50 each

---

*Verification complete. All user-reported actionable bugs resolved.*
