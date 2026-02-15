# Simulation Bots Fix - Complete Solution

## Problem Summary
Simulation bots show `initialized: false, funded: false, accountIdx: null` and never trade.

**Root Cause**: Oracle keypair has 0 SOL → can't pay InitUser transaction fees → "AccountNotFound" error

## Railway Logs Showing Failure
```
🪂 Oracle keypair low on SOL (0.000 SOL), requesting airdrop...
Airdrop failed (devnet rate limit?), continuing anyway
🤖 Bot init: vault=3no4huD5... mint=8Mtb7WH4... payer=8x9iDr9A...
🪙 Minted 500000000 tokens to oracle ATA for bot funding
MarketMaker InitUser simulation failed: "AccountNotFound" []
TrendFollower InitUser simulation failed: "AccountNotFound" []
LiquidationBot InitUser simulation failed: "AccountNotFound" []
WhaleBot InitUser simulation failed: "AccountNotFound" []
```

## Solution: Bulletproof Bot Initialization

### 1. **Wait for Frontend SOL Transfer** (CRITICAL - PRIMARY FIX)

**File**: `packages/server/src/services/SimulationService.ts`  
**Method**: `initBots()`  
**Line**: ~745

**Replace**:
```typescript
// Ensure oracle keypair has enough SOL for bot init tx fees
// Each bot needs ~0.01 SOL for InitUser + DepositCollateral fees
// Plus ATA creation, minting, etc. Request 2 SOL to be safe.
try {
  const balance = await this.connection.getBalance(this.oracleKeypair.publicKey);
  const MIN_SOL = 1_000_000_000; // 1 SOL minimum
  if (balance < MIN_SOL) {
    console.log(`🪂 Oracle keypair low on SOL...`);
    // ... airdrop logic ...
  }
} catch (err) {
  console.error("Airdrop failed...");
}
```

**With**:
```typescript
// Check and ensure oracle keypair has enough SOL for bot init tx fees
// Each bot needs ~0.01 SOL for InitUser + DepositCollateral fees
// Plus ATA creation, minting, etc. We need minimum 0.3 SOL total.
const MIN_SOL_REQUIRED = 300_000_000; // 0.3 SOL minimum (5 bots × 0.05 SOL + buffer)

// Wait up to 30s for frontend to transfer SOL (with retries)
let solBalance = 0;
let attempts = 0;
const maxAttempts = 6; // 6 attempts × 5s = 30s max wait

while (attempts < maxAttempts) {
  solBalance = await this.connection.getBalance(this.oracleKeypair.publicKey);
  console.log(`💰 Oracle SOL balance check (attempt ${attempts + 1}/${maxAttempts}): ${(solBalance / 1e9).toFixed(6)} SOL`);
  
  if (solBalance >= MIN_SOL_REQUIRED) {
    console.log(`✅ Oracle has sufficient SOL (${(solBalance / 1e9).toFixed(3)} SOL) — proceeding with bot init`);
    break;
  }
  
  if (attempts === 0) {
    console.log(`⏳ Oracle has ${(solBalance / 1e9).toFixed(6)} SOL (need ${(MIN_SOL_REQUIRED / 1e9).toFixed(3)} SOL) — waiting for frontend transfer...`);
  }
  
  attempts++;
  if (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 5000)); // Wait 5s between checks
  }
}

// If still insufficient after waiting, try airdrop as FALLBACK ONLY
if (solBalance < MIN_SOL_REQUIRED) {
  console.warn(`⚠️  Oracle still has insufficient SOL after ${maxAttempts * 5}s wait (${(solBalance / 1e9).toFixed(6)} SOL) — attempting airdrop fallback...`);
  try {
    const devnetConn = new Connection("https://api.devnet.solana.com", "confirmed");
    const airdropAmount = 500_000_000; // 0.5 SOL
    console.log(`🪂 Requesting ${(airdropAmount / 1e9).toFixed(1)} SOL airdrop to ${this.oracleKeypair.publicKey.toBase58().slice(0, 8)}...`);
    const airdropSig = await devnetConn.requestAirdrop(this.oracleKeypair.publicKey, airdropAmount);
    await devnetConn.confirmTransaction(airdropSig, "confirmed");
    console.log(`✅ Airdrop successful (sig=${airdropSig.slice(0, 16)}...)`);
    await new Promise((r) => setTimeout(r, 3000)); // Wait for propagation
    
    // Re-check balance
    solBalance = await this.connection.getBalance(this.oracleKeypair.publicKey);
    console.log(`💰 Post-airdrop balance: ${(solBalance / 1e9).toFixed(6)} SOL`);
  } catch (airdropErr) {
    console.error(`❌ Airdrop failed (devnet rate limit or network issue):`, airdropErr);
    console.warn(`⚠️  Continuing with ${(solBalance / 1e9).toFixed(6)} SOL — bots WILL LIKELY FAIL`);
    console.warn(`⚠️  ACTION REQUIRED: Frontend must transfer ≥${(MIN_SOL_REQUIRED / 1e9).toFixed(3)} SOL to oracle pubkey: ${this.oracleKeypair.publicKey.toBase58()}`);
  }
}

// Final balance check before proceeding
solBalance = await this.connection.getBalance(this.oracleKeypair.publicKey);
if (solBalance < MIN_SOL_REQUIRED) {
  console.error(`🚨 CRITICAL: Oracle has ${(solBalance / 1e9).toFixed(6)} SOL (need ${(MIN_SOL_REQUIRED / 1e9).toFixed(3)} SOL)`);
  console.error(`🚨 Bot initialization will likely fail. Oracle pubkey: ${this.oracleKeypair.publicKey.toBase58()}`);
  // Don't return — try anyway, individual bots will fail with clear logs
}
```

**Why This Works**:
- Frontend transfers 0.3 SOL to oracle in `app/app/api/launch/route.ts`
- Backend now **waits up to 30s** for that transfer to confirm
- Checks balance every 5s (6 attempts × 5s = 30s max)
- Only uses airdrop as fallback if frontend transfer fails
- Comprehensive logging shows exact SOL balance at each step

---

### 2. **Add Retry Logic to initSingleBot** (IMPORTANT)

**File**: `packages/server/src/services/SimulationService.ts`  
**Method**: `initSingleBot()`  
**Line**: ~860

**Changes**:
1. Add pre-flight SOL balance check before attempting init
2. Wrap InitUser in retry loop (3 attempts with exponential backoff)
3. Wrap DepositCollateral in retry loop  
4. Add comprehensive logging at each step
5. Wait longer for account index lookup (retry 4 times with 2s intervals)

**Key additions**:
```typescript
// Pre-flight check
const preInitBalance = await this.connection.getBalance(payer.publicKey);
console.log(`🤖 [${bot.name}] Pre-init SOL balance: ${(preInitBalance / 1e9).toFixed(6)} SOL`);

if (preInitBalance < 50_000_000) { // Less than 0.05 SOL
  console.error(`❌ [${bot.name}] Insufficient SOL — skipping init`);
  return;
}

// InitUser with retry
const MAX_RETRIES = 3;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`🔄 [${bot.name}] InitUser attempt ${attempt}/${MAX_RETRIES}`);
  // ... build tx ...
  
  const simResult = await this.connection.simulateTransaction(tx);
  if (simResult.value.err) {
    const errStr = JSON.stringify(simResult.value.err);
    const logs = simResult.value.logs?.slice(-5) || [];
    console.error(`❌ [${bot.name}] InitUser simulation failed (attempt ${attempt}):`, errStr);
    
    if (errStr.includes("AccountNotFound")) {
      const currentBalance = await this.connection.getBalance(payer.publicKey);
      console.error(`   💸 Payer SOL balance: ${(currentBalance / 1e9).toFixed(6)} SOL`);
      
      if (attempt < MAX_RETRIES) {
        const waitMs = attempt * 3000; // Exponential backoff
        console.log(`   ⏳ Waiting ${waitMs / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }
    
    if (attempt >= MAX_RETRIES) {
      console.error(`❌ [${bot.name}] InitUser failed after ${MAX_RETRIES} attempts`);
      return;
    }
  }
  
  const sig = await this.connection.sendTransaction(tx, [payer], { skipPreflight: true });
  console.log(`✅ [${bot.name}] InitUser successful (sig=${sig.slice(0, 16)}..., attempt ${attempt})`);
  break;
}
```

---

### 3. **Add Bot Initialization Summary** (NICE TO HAVE)

**File**: `packages/server/src/services/SimulationService.ts`  
**Method**: `initBots()` - at the END of the method  
**Line**: ~850 (after bot loop)

**Add**:
```typescript
// Summary
const initialized = this.state.bots.filter(b => b.initialized).length;
const funded = this.state.bots.filter(b => b.funded).length;
const ready = this.state.bots.filter(b => b.initialized && b.funded).length;

console.log(`\n📊 Bot initialization complete:`);
console.log(`   ✅ Initialized: ${initialized}/${this.state.bots.length}`);
console.log(`   💰 Funded: ${funded}/${this.state.bots.length}`);
console.log(`   🚀 Ready to trade: ${ready}/${this.state.bots.length}`);

if (ready < this.state.bots.length) {
  console.warn(`\n⚠️  WARNING: Only ${ready}/${this.state.bots.length} bots are ready!`);
  console.warn(`   Check logs above for initialization errors.`);
  console.warn(`   Oracle pubkey: ${this.oracleKeypair.publicKey.toBase58()}`);
} else {
  console.log(`\n🎉 All bots ready! Simulation starting...\n`);
}
```

---

### 4. **Improve sendTrade Safety** (NICE TO HAVE)

**File**: `packages/server/src/services/SimulationService.ts`  
**Method**: `sendTrade()`  
**Line**: ~1045

**Add checks**:
```typescript
if (!bot.initialized || !bot.funded) {
  console.warn(`⚠️  [${bot.name}] Skipping trade: initialized=${bot.initialized}, funded=${bot.funded}`);
  return;
}

// Log trades periodically (every 10th) to avoid spam
if (bot.trades % 10 === 0) {
  console.log(`📊 [${bot.name}] Trade #${bot.trades}: ${direction} ~$${notionalUsd.toFixed(0)}`);
}
```

---

## Testing the Fix

After applying fixes:

1. Deploy to Railway
2. Create a new simulation market
3. Check logs for:
   - `💰 Oracle SOL balance check (attempt 1/6): X.XXXXXX SOL`
   - `✅ Oracle has sufficient SOL`
   - `✅ [BotName] InitUser successful`
   - `✅ [BotName] Funded`
   - `📊 Bot initialization complete: 🚀 Ready to trade: 5/5`

4. Verify bots show `initialized: true, funded: true, accountIdx: <number>` in `/api/simulation/state`

---

## Priority

1. **CRITICAL**: SOL balance retry logic (Fix #1) - Without this, nothing works
2. **IMPORTANT**: initSingleBot retry logic (Fix #2) - Handles edge cases and network issues
3. **NICE TO HAVE**: Summary logging (Fix #3) - Better debugging
4. **NICE TO HAVE**: sendTrade improvements (Fix #4) - Prevents spam errors

---

## Commit Message Template

```
fix(sim): bulletproof bot init with SOL funding retry window

PROBLEM: Bots fail with "AccountNotFound" — oracle has 0 SOL, can't pay fees

ROOT CAUSE: Backend tries to init bots immediately; frontend SOL transfer
not confirmed yet. Devnet airdrop unreliable (rate-limited).

FIX:
- Wait up to 30s for frontend 0.3 SOL transfer (6 × 5s retry)
- Reduce MIN_SOL from 1.0 → 0.3 SOL (matches frontend)
- Keep airdrop as fallback only
- Add retry logic to InitUser (3 attempts, exponential backoff)
- Comprehensive logging with SOL balance at each step
- Bot init summary shows ready count

Fixes #<issue-number>
```
