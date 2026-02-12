# Bug Bounties #11-13 — @sharpmetaa Backend Issues

**Date:** Feb 12, 2026 20:08-20:15 UTC  
**Reporter:** @sharpmetaa (Discord)  
**Bounty Wallet:** 3S1Q4FeAHabTgPqfYyVhQ85FPicGUizJhJEwFZEMZaTs  
**Total Bugs:** 3 (1 HIGH, 2 MEDIUM)

---

## 🔴 Bug #11: Hard-coded PROGRAM_ID Values (HIGH)

**Reported:** Feb 12 20:08 UTC  
**Severity:** HIGH  
**Status:** ⚠️ NEEDS FIX

### Description
Multiple files embed explicit PROGRAM_ID values directly in source code instead of consistently loading from environment or centralized configuration.

### Problem
This creates risk of:
- Sending transactions to unintended program IDs
- Accidentally interacting with mainnet instead of devnet
- Operational misconfiguration
- Hard to update across codebase when deploying new versions

### Files Affected

**1. Hard-coded without fallback:**
- `tests/devnet-e2e.ts:40`
  ```typescript
  const PROGRAM_ID = new PublicKey("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD");
  ```

- `services/oracle/src/index.ts:19`
  ```typescript
  const PROGRAM_ID = new PublicKey("GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24");
  ```

- `services/keeper/src/index.ts:19`
  ```typescript
  const PROGRAM_ID = new PublicKey("GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24");
  ```

**2. Has env fallback but still hardcoded default:**
- `scripts/create-market.ts:96`
- `scripts/crank-generic.ts:43`
- `tests/t6-risk-gate.ts:59`
- `tests/t7-market-pause.ts:61`
- `tests/t4-liquidation.ts:65`

### Recommended Fix

**Create centralized config:**
```typescript
// packages/core/src/config.ts
export const PROGRAM_IDS = {
  devnet: {
    percolator: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcher: "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy",
  },
  mainnet: {
    percolator: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcher: "...",
  },
};

export function getProgramId(network: "devnet" | "mainnet" = "devnet"): PublicKey {
  const id = process.env.PROGRAM_ID || PROGRAM_IDS[network].percolator;
  return new PublicKey(id);
}
```

**Then update all files:**
```typescript
import { getProgramId } from "@/config";
const PROGRAM_ID = getProgramId(process.env.NETWORK as "devnet" | "mainnet");
```

### Priority
🔥 **HIGH** - Affects operational safety, especially in production

---

## 🟡 Bug #12: skipPreflight: true Increases Risk (MEDIUM)

**Reported:** Feb 12 20:11 UTC  
**Severity:** MEDIUM  
**Status:** ⚠️ NEEDS REVIEW

### Description
Transactions are submitted with `skipPreflight: true`, which disables preflight simulation checks.

### Problem
Without preflight:
- Malformed transactions are submitted on-chain
- Failures occur on-chain instead of being caught locally
- Debugging becomes harder
- Transaction fees wasted on failed transactions
- Poor UX (user sees failure after waiting for confirmation)

### Files Affected
- `packages/server/src/index.ts` (likely in transaction submission logic)
- Any service that uses `connection.sendTransaction(tx, signers, { skipPreflight: true })`

### Analysis

**When skipPreflight: true is acceptable:**
- High-throughput scenarios (priority fees)
- Time-sensitive transactions
- Known to work (tested extensively)

**When it's dangerous:**
- User-submitted transactions
- Complex multi-step operations
- Untested transaction types

### Recommended Fix

**Option A: Remove skipPreflight entirely (safest)**
```typescript
const sig = await connection.sendTransaction(tx, signers); // preflight enabled by default
```

**Option B: Make it configurable**
```typescript
const skipPreflight = process.env.SKIP_PREFLIGHT === "true" || false;
const sig = await connection.sendTransaction(tx, signers, { skipPreflight });
```

**Option C: Use selectively**
```typescript
// Use preflight for user transactions
const userSig = await connection.sendTransaction(userTx, signers);

// Skip for automated/tested operations
const crankSig = await connection.sendTransaction(crankTx, signers, { skipPreflight: true });
```

### Priority
🟡 **MEDIUM** - Affects reliability and UX, but not security

---

## 🟡 Bug #13: Infinite while(true) Loops Without Graceful Shutdown (MEDIUM)

**Reported:** Feb 12 20:15 UTC  
**Severity:** MEDIUM  
**Status:** ⚠️ NEEDS FIX

### Description
Services use `while (true)` loops without:
- Signal handling (SIGINT/SIGTERM)
- Graceful shutdown logic
- Retry backoff on failure

### Problem
This can result in:
- Tight retry loops consuming resources
- Resource exhaustion
- Unclean shutdown (data loss, incomplete transactions)
- Hard to stop gracefully in production
- Difficult to debug infinite error loops

### Files Affected
Likely in:
- `services/oracle/src/index.ts`
- `services/keeper/src/index.ts`
- Any crank/bot services

**Typical pattern:**
```typescript
while (true) {
  try {
    await doWork();
    await sleep(1000);
  } catch (e) {
    console.error(e);
    // Immediately retries without backoff
  }
}
```

### Recommended Fix

**Add graceful shutdown + backoff:**

```typescript
let running = true;
let backoffMs = 1000;
const MAX_BACKOFF = 60000; // 60 seconds

// Signal handlers
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  running = false;
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  running = false;
});

while (running) {
  try {
    await doWork();
    backoffMs = 1000; // Reset on success
    await sleep(backoffMs);
  } catch (e) {
    console.error('Error:', e);
    // Exponential backoff
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    console.log(\`Retrying in \${backoffMs}ms...\`);
    await sleep(backoffMs);
  }
}

console.log('Service stopped gracefully');
process.exit(0);
```

### Additional Improvements

**1. Add health checks:**
```typescript
let lastSuccessTime = Date.now();
const HEALTH_TIMEOUT = 300000; // 5 minutes

setInterval(() => {
  if (Date.now() - lastSuccessTime > HEALTH_TIMEOUT) {
    console.error('Service unhealthy, exiting...');
    process.exit(1);
  }
}, 60000); // Check every minute
```

**2. Add circuit breaker:**
```typescript
let consecutiveFailures = 0;
const MAX_FAILURES = 10;

while (running) {
  try {
    await doWork();
    consecutiveFailures = 0;
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      console.error('Too many failures, exiting...');
      process.exit(1);
    }
  }
}
```

### Priority
🟡 **MEDIUM** - Affects operational stability, but not immediate security risk

---

## 📋 Summary

| Bug | Severity | Files Affected | Effort | Priority |
|-----|----------|----------------|--------|----------|
| #11: Hard-coded PROGRAM_ID | HIGH | 8+ files | Medium | 🔥 High |
| #12: skipPreflight: true | MEDIUM | 1-2 files | Low | 🟡 Medium |
| #13: Infinite loops | MEDIUM | 2-3 files | Medium | 🟡 Medium |

---

## Recommended Action Plan

### Phase 1: Critical (Bug #11)
1. Create centralized config for PROGRAM_IDs
2. Update all files to use config
3. Test on devnet
4. Deploy

**Time:** 2-3 hours

### Phase 2: Important (Bug #13)
1. Add signal handlers to all services
2. Implement exponential backoff
3. Add health checks
4. Test graceful shutdown

**Time:** 3-4 hours

### Phase 3: Review (Bug #12)
1. Audit all `skipPreflight: true` usage
2. Decide strategy (remove, configure, or selective)
3. Implement chosen approach
4. Test transaction submission

**Time:** 1-2 hours

---

## Bounty Payment

**Reporter:** @sharpmetaa  
**Wallet:** 3S1Q4FeAHabTgPqfYyVhQ85FPicGUizJhJEwFZEMZaTs  
**Status:** ⏳ UNPAID (awaiting fixes)

**Severity breakdown:**
- Bug #11 (HIGH): $75-100
- Bug #12 (MEDIUM): $50-75
- Bug #13 (MEDIUM): $50-75

**Total recommendation:** $175-250 in SOL

---

## Notes

These are **backend/infrastructure** issues requiring:
- Careful testing (can't break production services)
- Coordination across multiple files
- Understanding of operational requirements

Unlike frontend bugs, these need more deliberate approach.

**Recommendation:** Schedule dedicated time for backend fixes, test thoroughly on devnet before deploying.

---

*Excellent static analysis by @sharpmetaa. All 3 bugs are legitimate operational/safety issues.*
