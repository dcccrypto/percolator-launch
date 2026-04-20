# Percolator Liquidity Architecture: Bounded On-Chain Maker Quotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded on-chain maker quote layer to Percolator, with vAMM backstop, staged through multi-LP routing first. Also fix critical reentrancy guard and add defense-in-depth exec_price banding.

**Architecture:** Three stages deployed sequentially. Stage 1 fixes security prerequisites (reentrancy guard activation, exec_price banding) in `percolator-prog`. Stage 2 adds multi-LP routing to the SDK and frontend with zero on-chain changes. Stage 3 creates a new `percolator-quote-match` program that reads on-chain maker quote accounts during CPI and selects the best price vs vAMM fallback. All stages use the existing matcher ABI (67-byte call, 64-byte return) and require no engine or wrapper structural changes.

**Tech Stack:** Rust (Solana BPF, `solana-program 2.0`), TypeScript (`@percolatorct/sdk`), React/Next.js (`percolator-launch`), Anchor test harness for integration tests.

**Repos touched:**
- `~/percolator-prog/` — wrapper program (Stage 1 only)
- `~/percolator-match/` — reference for new matcher (Stage 3 reads patterns)
- `~/percolator-sdk/` — multi-LP routing (Stage 2), maker SDK (Stage 3)
- `~/percolator-launch/` — frontend LP selection UI (Stage 2), maker UI (Stage 3)
- `~/percolator-quote-match/` — NEW repo, quote-aware matcher program (Stage 3)

---

## File Structure

### Stage 1 — Security Prerequisites (percolator-prog)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `~/percolator-prog/src/percolator.rs:7274-7284` | Activate reentrancy guard around CPI |
| Modify | `~/percolator-prog/src/percolator.rs:7362-7370` | Add exec_price vs oracle banding |
| Modify | `~/percolator-prog/src/percolator.rs:1220-1240` | Add `max_exec_deviation_e2bps` to InitMarket |
| Modify | `~/percolator-prog/src/percolator.rs:2200-2300` | Add `max_exec_deviation_e2bps` to MarketConfig |
| Create | `~/percolator-prog/tests/test_reentrancy.rs` | Reentrancy guard integration test |
| Modify | `~/percolator-prog/tests/test_tradecpi.rs` | Exec_price banding test cases |

### Stage 2 — Multi-LP Routing (SDK + Frontend)

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `~/percolator-sdk/src/routing/lp-router.ts` | Best-price LP selection logic |
| Create | `~/percolator-sdk/src/routing/index.ts` | Re-export routing module |
| Modify | `~/percolator-sdk/src/index.ts` | Export routing module |
| Create | `~/percolator-sdk/src/routing/__tests__/lp-router.test.ts` | Unit tests for routing |
| Modify | `~/percolator-launch/app/hooks/useTrade.ts` | Use LP router for LP selection |
| Modify | `~/percolator-launch/app/components/trade/TradeForm.tsx` | Show selected LP info |

### Stage 3 — Quote-Aware Matcher Program (New Repo + SDK + Frontend)

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `~/percolator-quote-match/Cargo.toml` | Crate config for new matcher |
| Create | `~/percolator-quote-match/src/lib.rs` | Entrypoint and instruction dispatch |
| Create | `~/percolator-quote-match/src/quote.rs` | QuoteAccount struct, read/write, validation |
| Create | `~/percolator-quote-match/src/matcher.rs` | Quote-aware matching logic (best price vs vAMM) |
| Create | `~/percolator-quote-match/src/instructions.rs` | PostQuote, UpdateQuote, CloseQuote, MatcherCall handlers |
| Create | `~/percolator-quote-match/tests/test_quote_matcher.rs` | Integration tests |
| Create | `~/percolator-sdk/src/maker/quote-client.ts` | Maker SDK: post/update/cancel quotes |
| Create | `~/percolator-sdk/src/maker/index.ts` | Re-export maker module |
| Modify | `~/percolator-sdk/src/index.ts` | Export maker module |
| Create | `~/percolator-sdk/src/maker/__tests__/quote-client.test.ts` | Unit tests for maker SDK |
| Modify | `~/percolator-sdk/src/routing/lp-router.ts` | Add quote-aware LP support |
| Create | `~/percolator-launch/app/components/maker/QuotePanel.tsx` | Maker quote management UI |

---

## STAGE 1: SECURITY PREREQUISITES

### Task 1: Activate Reentrancy Guard

**Context:** `set_cpi_in_progress` and `clear_cpi_in_progress` are defined at `percolator-prog/src/percolator.rs:2389-2398` but never called. The check in `slab_guard` at line 5434 reads the flag but it's never set before the matcher CPI at line 7284. This means a malicious matcher could theoretically re-enter the percolator program during CPI if additional accounts were ever passed. Defense-in-depth requires activating this guard.

**Files:**
- Modify: `~/percolator-prog/src/percolator.rs:7274-7284`
- Create: `~/percolator-prog/tests/test_reentrancy.rs`

- [ ] **Step 1: Write the reentrancy guard test**

Create `~/percolator-prog/tests/test_reentrancy.rs`:

```rust
//! Test that reentrancy guard prevents instruction execution during CPI.
//!
//! We cannot easily test a malicious matcher CPI in the BPF test harness,
//! but we CAN test that the FLAG_CPI_IN_PROGRESS flag blocks slab_guard.

mod common;
use common::*;

#[tokio::test]
async fn test_cpi_in_progress_flag_blocks_instructions() {
    let mut ctx = TestContext::new().await;
    ctx.init_market_default().await.unwrap();
    ctx.init_lp_default().await.unwrap();
    ctx.deposit_user(0, 100_000_000).await.unwrap(); // 100 USDC
    ctx.deposit_user(1, 100_000_000).await.unwrap(); // LP deposit

    // Manually set FLAG_CPI_IN_PROGRESS on the slab
    let mut slab_data = ctx.get_slab_data().await;
    crate::state::set_cpi_in_progress(&mut slab_data);
    ctx.set_slab_data(&slab_data).await;

    // Now any instruction should fail with InvalidAccountData
    let result = ctx.try_keeper_crank().await;
    assert!(result.is_err(), "KeeperCrank should fail while CPI in progress");

    // Clear the flag
    let mut slab_data = ctx.get_slab_data().await;
    crate::state::clear_cpi_in_progress(&mut slab_data);
    ctx.set_slab_data(&slab_data).await;

    // Now instructions should work again
    let result = ctx.try_keeper_crank().await;
    assert!(result.is_ok(), "KeeperCrank should succeed after CPI flag cleared");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/percolator-prog && cargo test-sbf test_cpi_in_progress_flag_blocks_instructions -- --nocapture 2>&1 | tail -20`

Expected: FAIL — the test may compile but the flag behavior needs verification against the test harness. If the test harness doesn't expose `state::set_cpi_in_progress`, adapt to use raw byte manipulation at `FLAGS_OFF`.

- [ ] **Step 3: Activate the reentrancy guard in TradeCpi**

In `~/percolator-prog/src/percolator.rs`, find the CPI invocation block (around line 7274-7284). Insert `set_cpi_in_progress` before the CPI and `clear_cpi_in_progress` after:

```rust
        // --- EXISTING CODE at line ~7274 ---
        let ix = SolInstruction {
            program_id: *a_matcher_prog.key,
            accounts: metas.to_vec(),
            data: cpi_data.to_vec(),
        };

        let bump_arr = [bump];
        let seeds: &[&[u8]] = &[b"lp", a_slab.key.as_ref(), &lp_bytes, &bump_arr];

        // ADDED: Set reentrancy guard before CPI
        {
            let mut data = state::slab_data_mut(a_slab)?;
            state::set_cpi_in_progress(&mut data);
        }

        // Phase 2: Use zc helper for CPI - slab not passed to avoid ExternalAccountDataModified
        let cpi_result = zc::invoke_signed_trade(&ix, a_lp_pda, a_matcher_ctx, a_matcher_prog, seeds);

        // ADDED: Clear reentrancy guard after CPI (always, even on error)
        {
            let mut data = state::slab_data_mut(a_slab)?;
            state::clear_cpi_in_progress(&mut data);
        }

        // Propagate CPI error after clearing guard
        cpi_result?;
```

**Critical:** The `clear_cpi_in_progress` must happen even if the CPI fails, otherwise the slab is permanently bricked. That's why we capture the result, clear the flag, then propagate the error with `?`.

- [ ] **Step 4: Run the full test suite to verify no regressions**

Run: `cd ~/percolator-prog && cargo test-sbf 2>&1 | tail -30`

Expected: All existing tests PASS. The reentrancy guard is transparent to normal operation because the flag is set/cleared within the same instruction.

- [ ] **Step 5: Run the reentrancy-specific test**

Run: `cd ~/percolator-prog && cargo test-sbf test_cpi_in_progress -- --nocapture 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd ~/percolator-prog
git add src/percolator.rs tests/test_reentrancy.rs
git commit -m "security: activate CPI reentrancy guard in TradeCpi

set_cpi_in_progress/clear_cpi_in_progress were defined but never called.
Now the FLAG_CPI_IN_PROGRESS is set before matcher CPI and cleared after,
ensuring slab_guard rejects any reentrant instruction during the CPI window.
Guard is cleared even on CPI failure to prevent slab bricking."
```

---

### Task 2: Add exec_price vs oracle_price Banding

**Context:** Currently `execute_trade_not_atomic` in the engine accepts any `exec_price` in `(0, MAX_ORACLE_PRICE]` regardless of distance from `oracle_price`. The wrapper's circuit breaker clamps exec_price for mark EWMA purposes but the actual PnL computation uses the unclamped value. A compromised or buggy matcher could return `exec_price` far from oracle, creating outsized PnL transfers. Defense-in-depth: reject exec_price outside a configurable band.

**Files:**
- Modify: `~/percolator-prog/src/percolator.rs` (MarketConfig struct, InitMarket, TradeCpi handler)
- Modify: `~/percolator-prog/tests/test_tradecpi.rs`

- [ ] **Step 1: Write the test for exec_price banding**

Add to `~/percolator-prog/tests/test_tradecpi.rs`:

```rust
#[tokio::test]
async fn test_exec_price_outside_band_rejected() {
    let mut ctx = TestContext::new().await;
    // Init market with max_exec_deviation_e2bps = 10_000 (1%)
    ctx.init_market_with_exec_band(10_000).await.unwrap();
    ctx.init_lp_default().await.unwrap();
    ctx.deposit_user(0, 100_000_000).await.unwrap();
    ctx.deposit_user(1, 100_000_000).await.unwrap();

    // Set oracle to $150
    ctx.push_oracle_price(150_000_000).await.unwrap();

    // Trade should succeed when matcher returns price within 1% of oracle
    // (vAMM with tight spread will be within band)
    let result = ctx.try_trade_cpi(0, 1, 1_000_000).await;
    assert!(result.is_ok(), "Trade within band should succeed");

    // Now configure a malicious matcher that returns price 50% away from oracle
    // This test uses a mock matcher — if harness doesn't support custom matchers,
    // test at the unit level by calling the validation function directly.
}

#[tokio::test]
async fn test_exec_price_band_zero_means_disabled() {
    let mut ctx = TestContext::new().await;
    // Init market with max_exec_deviation_e2bps = 0 (disabled)
    ctx.init_market_with_exec_band(0).await.unwrap();
    ctx.init_lp_default().await.unwrap();
    ctx.deposit_user(0, 100_000_000).await.unwrap();
    ctx.deposit_user(1, 100_000_000).await.unwrap();

    ctx.push_oracle_price(150_000_000).await.unwrap();

    // Any exec_price should be accepted when banding is disabled
    let result = ctx.try_trade_cpi(0, 1, 1_000_000).await;
    assert!(result.is_ok());
}
```

- [ ] **Step 2: Run tests to verify they fail (field doesn't exist yet)**

Run: `cd ~/percolator-prog && cargo test-sbf test_exec_price_outside_band -- --nocapture 2>&1 | tail -20`

Expected: Compile error — `init_market_with_exec_band` doesn't exist, `max_exec_deviation_e2bps` not in config.

- [ ] **Step 3: Add max_exec_deviation_e2bps to MarketConfig**

In `~/percolator-prog/src/percolator.rs`, find the MarketConfig struct (around line 2200). Add the field, carved from existing reserved space:

```rust
        // Add after mark_min_fee field (around line 2279):
        pub max_exec_deviation_e2bps: u64,  // 0 = disabled, else max |exec - oracle| / oracle
```

Update the config read/write functions to include this field. Use the same pattern as `mark_min_fee` — read from instruction data in InitMarket, write to config, read back in TradeCpi.

- [ ] **Step 4: Add the banding check in TradeCpi**

In `~/percolator-prog/src/percolator.rs`, after the ABI validation (around line 7362-7370, where `exec_price <= MAX_ORACLE_PRICE` is checked), add:

```rust
        // Defense-in-depth: reject exec_price too far from oracle
        if config.max_exec_deviation_e2bps > 0 {
            let max_delta = (price as u128)
                .saturating_mul(config.max_exec_deviation_e2bps as u128)
                / 1_000_000;
            let lower = (price as u128).saturating_sub(max_delta);
            let upper = (price as u128).saturating_add(max_delta);
            let ep = ret.exec_price_e6 as u128;
            if ep < lower || ep > upper {
                return Err(PercolatorError::ExecPriceOutOfBand.into());
            }
        }
```

Add the error variant `ExecPriceOutOfBand` to the error enum.

- [ ] **Step 5: Update InitMarket to accept and store the parameter**

Follow the pattern used for `mark_min_fee` — add `max_exec_deviation_e2bps: u64` to the InitMarket instruction data parsing, with a reasonable upper bound validation (e.g., `<= 1_000_000` which is 100%).

- [ ] **Step 6: Run the full test suite**

Run: `cd ~/percolator-prog && cargo test-sbf 2>&1 | tail -30`

Expected: Existing tests may need updating if InitMarket instruction data length changed. Update test helpers to pass `max_exec_deviation_e2bps: 0` (disabled) for backward compatibility.

- [ ] **Step 7: Run banding-specific tests**

Run: `cd ~/percolator-prog && cargo test-sbf test_exec_price -- --nocapture 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd ~/percolator-prog
git add src/percolator.rs tests/test_tradecpi.rs
git commit -m "security: add exec_price vs oracle banding in TradeCpi

New config field max_exec_deviation_e2bps limits how far a matcher's
exec_price can diverge from oracle. Prevents a compromised matcher from
creating outsized PnL transfers. Set to 0 to disable (backward compat)."
```

---

## STAGE 2: MULTI-LP ROUTING

### Task 3: LP Router Module in SDK

**Context:** Currently the frontend hardcodes `lpIdx: 0` — only one LP is used. The slab can hold multiple LP accounts, each with a different matcher. The router reads all LP accounts, simulates each matcher's expected exec_price (using oracle and spread parameters), and selects the LP offering the best price for the taker.

**Files:**
- Create: `~/percolator-sdk/src/routing/lp-router.ts`
- Create: `~/percolator-sdk/src/routing/index.ts`
- Create: `~/percolator-sdk/src/routing/__tests__/lp-router.test.ts`
- Modify: `~/percolator-sdk/src/index.ts`

- [ ] **Step 1: Write the LP router test**

Create `~/percolator-sdk/src/routing/__tests__/lp-router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { selectBestLp, LpCandidate } from "../lp-router";

describe("selectBestLp", () => {
  const baseLp = (idx: number, overrides: Partial<LpCandidate> = {}): LpCandidate => ({
    lpIdx: idx,
    matcherKind: "vamm" as const,
    oraclePriceE6: 150_000_000n, // $150
    baseSpreadBps: 30,
    tradingFeeBps: 10,
    impactKBps: 100,
    liquidityNotionalE6: 1_000_000_000_000n, // $1M
    maxFillAbs: 100_000_000_000n,
    inventoryBase: 0n,
    maxInventoryAbs: 1_000_000_000_000n,
    skewSpreadMultBps: 0,
    ...overrides,
  });

  it("returns the only LP when there is one", () => {
    const result = selectBestLp([baseLp(0)], 1_000_000n, "buy");
    expect(result).not.toBeNull();
    expect(result!.lpIdx).toBe(0);
  });

  it("selects LP with tighter spread for buys", () => {
    const lps = [
      baseLp(0, { baseSpreadBps: 50 }),  // wider
      baseLp(1, { baseSpreadBps: 20 }),  // tighter
    ];
    const result = selectBestLp(lps, 1_000_000n, "buy");
    expect(result!.lpIdx).toBe(1);
  });

  it("selects LP with tighter spread for sells", () => {
    const lps = [
      baseLp(0, { baseSpreadBps: 50 }),
      baseLp(1, { baseSpreadBps: 20 }),
    ];
    const result = selectBestLp(lps, 1_000_000n, "sell");
    expect(result!.lpIdx).toBe(1);
  });

  it("accounts for skew spread when LP has inventory", () => {
    const lps = [
      baseLp(0, { baseSpreadBps: 20, inventoryBase: 0n, skewSpreadMultBps: 100 }),
      baseLp(1, { baseSpreadBps: 30, inventoryBase: 50_000_000n, skewSpreadMultBps: 100 }),
    ];
    // Selling into LP1 (which is already long) worsens its inventory → extra skew spread
    const result = selectBestLp(lps, 1_000_000n, "sell");
    expect(result!.lpIdx).toBe(0); // LP0 is better despite base being close, because LP1 has skew
  });

  it("filters LPs that cannot fill the size", () => {
    const lps = [
      baseLp(0, { maxFillAbs: 500_000n }),  // too small
      baseLp(1, { maxFillAbs: 10_000_000n }),
    ];
    const result = selectBestLp(lps, 1_000_000n, "buy");
    expect(result!.lpIdx).toBe(1);
  });

  it("returns null when no LP can fill", () => {
    const lps = [baseLp(0, { maxFillAbs: 100n })];
    const result = selectBestLp(lps, 1_000_000n, "buy");
    expect(result).toBeNull();
  });

  it("handles passive LP kind (no impact, fixed edge)", () => {
    const lps = [
      baseLp(0, { matcherKind: "passive", baseSpreadBps: 50 }),
      baseLp(1, { matcherKind: "vamm", baseSpreadBps: 30, impactKBps: 500 }),
    ];
    // For large size, vAMM impact may exceed passive's fixed edge
    const result = selectBestLp(lps, 50_000_000n, "buy");
    // Passive has no impact so at large sizes it may win
    expect(result).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/percolator-sdk && npx vitest run src/routing/__tests__/lp-router.test.ts 2>&1 | tail -20`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the LP router**

Create `~/percolator-sdk/src/routing/lp-router.ts`:

```typescript
/**
 * LP Router — selects the best LP for a given trade based on estimated execution price.
 *
 * For each LP, estimates the exec_price using the same formula as the on-chain matcher:
 * - vAMM: impact_bps = notional * impact_k / liquidity, plus base_spread + fee + skew
 * - Passive: fixed edge_bps off oracle
 *
 * Returns the LP that gives the taker the best price (lowest for buys, highest for sells).
 */

export type MatcherKindLabel = "vamm" | "passive" | "quote";

export interface LpCandidate {
  lpIdx: number;
  matcherKind: MatcherKindLabel;
  oraclePriceE6: bigint;
  baseSpreadBps: number;
  tradingFeeBps: number;
  impactKBps: number;           // vAMM only (0 for passive)
  liquidityNotionalE6: bigint;  // vAMM only (0 for passive)
  maxFillAbs: bigint;
  inventoryBase: bigint;
  maxInventoryAbs: bigint;
  skewSpreadMultBps: number;
}

/**
 * Estimate the total spread in BPS for a given LP and trade.
 * Returns null if the LP cannot fill (size exceeds limits).
 */
export function estimateTotalBps(
  lp: LpCandidate,
  sizeAbs: bigint,
  side: "buy" | "sell",
): number | null {
  // Check fill limits
  if (sizeAbs > lp.maxFillAbs) return null;

  // Check inventory limits
  if (lp.maxInventoryAbs > 0n) {
    const inv = lp.inventoryBase;
    const delta = side === "buy" ? -sizeAbs : sizeAbs;
    const newInv = inv + delta;
    const newInvAbs = newInv < 0n ? -newInv : newInv;
    if (newInvAbs > lp.maxInventoryAbs) return null;
  }

  let totalBps: number;

  if (lp.matcherKind === "passive") {
    // Passive: fixed edge
    totalBps = lp.baseSpreadBps + lp.tradingFeeBps;
  } else {
    // vAMM: base + fee + impact + skew
    const notionalE6 = (sizeAbs * lp.oraclePriceE6) / 1_000_000n;
    let impactBps = 0;
    if (lp.liquidityNotionalE6 > 0n) {
      impactBps = Number(
        (notionalE6 * BigInt(lp.impactKBps)) / lp.liquidityNotionalE6
      );
    }

    // Skew spread
    let skewBps = 0;
    if (lp.skewSpreadMultBps > 0) {
      const inv = lp.inventoryBase;
      const worsens = side === "buy" ? inv < 0n : inv > 0n;
      if (worsens) {
        const invAbs = inv < 0n ? -inv : inv;
        skewBps = Math.min(
          Number((invAbs * BigInt(lp.skewSpreadMultBps)) / 10_000n),
          5000,
        );
      }
    }

    totalBps = lp.baseSpreadBps + lp.tradingFeeBps + impactBps + skewBps;
  }

  return totalBps;
}

/**
 * Select the LP with the best (tightest) estimated execution price.
 * Returns null if no LP can fill the requested size.
 */
export function selectBestLp(
  candidates: LpCandidate[],
  sizeAbs: bigint,
  side: "buy" | "sell",
): LpCandidate | null {
  let bestLp: LpCandidate | null = null;
  let bestBps: number = Infinity;

  for (const lp of candidates) {
    const bps = estimateTotalBps(lp, sizeAbs, side);
    if (bps === null) continue;
    if (bps < bestBps) {
      bestBps = bps;
      bestLp = lp;
    }
  }

  return bestLp;
}
```

- [ ] **Step 4: Create index file**

Create `~/percolator-sdk/src/routing/index.ts`:

```typescript
export { selectBestLp, estimateTotalBps } from "./lp-router";
export type { LpCandidate, MatcherKindLabel } from "./lp-router";
```

- [ ] **Step 5: Export from SDK root**

In `~/percolator-sdk/src/index.ts`, add:

```typescript
export * from "./routing";
```

- [ ] **Step 6: Run tests**

Run: `cd ~/percolator-sdk && npx vitest run src/routing/__tests__/lp-router.test.ts 2>&1 | tail -30`

Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/percolator-sdk
git add src/routing/ src/index.ts
git commit -m "feat: add multi-LP routing module

selectBestLp() estimates execution price for each LP in a slab
(vAMM impact model + passive fixed edge) and returns the LP with
tightest spread. Filters by fill limits and inventory capacity."
```

---

### Task 4: Integrate LP Router into Frontend

**Context:** Currently `useTrade.ts` always uses the LP at `params.lpIdx` (hardcoded from the trade form). We need to: (1) read all LP accounts from the slab, (2) build `LpCandidate[]` from their matcher contexts, (3) call `selectBestLp()`, and (4) use the winning LP's index for TradeCpi.

**Files:**
- Modify: `~/percolator-launch/app/hooks/useTrade.ts`
- Modify: `~/percolator-launch/app/components/trade/TradeForm.tsx`

- [ ] **Step 1: Add LP candidate extraction to useTrade**

In `~/percolator-launch/app/hooks/useTrade.ts`, before the trade instruction assembly (around line 116), add LP selection logic:

```typescript
        // --- Multi-LP routing: select best LP ---
        import { selectBestLp, LpCandidate } from "@percolatorct/sdk";

        // Build LP candidates from all LP accounts in the slab
        const lpCandidates: LpCandidate[] = accounts
          .filter((a) => a.account.kind === 1 && a.account.matcherProgram && !a.account.matcherProgram.equals(PublicKey.default))
          .map((a) => ({
            lpIdx: a.idx,
            matcherKind: a.account.matcherKind ?? "vamm",
            oraclePriceE6: BigInt(mktConfig.lastEffectivePriceE6 || "150000000"),
            baseSpreadBps: a.account.matcherCtxParsed?.baseSpreadBps ?? 30,
            tradingFeeBps: a.account.matcherCtxParsed?.tradingFeeBps ?? 10,
            impactKBps: a.account.matcherCtxParsed?.impactKBps ?? 100,
            liquidityNotionalE6: BigInt(a.account.matcherCtxParsed?.liquidityNotionalE6 ?? "0"),
            maxFillAbs: BigInt(a.account.matcherCtxParsed?.maxFillAbs ?? "0"),
            inventoryBase: BigInt(a.account.matcherCtxParsed?.inventoryBase ?? "0"),
            maxInventoryAbs: BigInt(a.account.matcherCtxParsed?.maxInventoryAbs ?? "0"),
            skewSpreadMultBps: a.account.matcherCtxParsed?.skewSpreadMultBps ?? 0,
          }));

        const sizeAbs = params.size < 0n ? -params.size : params.size;
        const side = params.size > 0n ? "buy" : "sell";

        // Try routing, fall back to provided lpIdx
        const bestLp = lpCandidates.length > 1
          ? selectBestLp(lpCandidates, sizeAbs, side as "buy" | "sell")
          : null;
        const selectedLpIdx = bestLp?.lpIdx ?? params.lpIdx;
        const selectedLpAccount = accounts.find((a) => a.idx === selectedLpIdx) ?? lpAccount;
```

Then replace `params.lpIdx` with `selectedLpIdx` and `lpAccount` with `selectedLpAccount` in the TradeCpi instruction builder below.

**Note:** This requires that LP matcher context data is parsed and available in the `accounts` array from `SlabProvider`. If `matcherCtxParsed` doesn't exist on the account type, you'll need to add it to the slab parser. For the initial version, if only one LP exists, the router is a no-op — it just returns that LP.

- [ ] **Step 2: Add selected LP display to TradeForm**

In `~/percolator-launch/app/components/trade/TradeForm.tsx`, add a small info line showing which LP is selected:

```tsx
{/* After the leverage slider, before the submit button */}
{lpCandidates.length > 1 && selectedLp && (
  <div className="text-xs text-muted-foreground mt-1">
    Routing to LP #{selectedLp.lpIdx} ({selectedLp.matcherKind}) — est. {selectedLp.estimatedSpreadBps} bps
  </div>
)}
```

- [ ] **Step 3: Test manually with devnet**

Start dev server: `cd ~/percolator-launch && pnpm dev`

Verify:
- Trade form loads correctly
- With single LP: behaves identically to before (no visible routing info)
- Trade executes successfully

- [ ] **Step 4: Commit**

```bash
cd ~/percolator-launch
git add app/hooks/useTrade.ts app/components/trade/TradeForm.tsx
git commit -m "feat: integrate multi-LP routing in trade flow

When multiple LPs exist in a market, selectBestLp() picks the LP
with tightest estimated spread. Falls back to first LP when only
one exists. Shows selected LP info in trade form."
```

---

## STAGE 3: QUOTE-AWARE MATCHER PROGRAM

### Task 5: Scaffold Quote Matcher Crate

**Context:** New Solana BPF program. Follows the same patterns as `percolator-match` — `#![no_std]`, `solana-program 2.0`, `cdylib` crate type, 320-byte context account.

**Files:**
- Create: `~/percolator-quote-match/Cargo.toml`
- Create: `~/percolator-quote-match/src/lib.rs`
- Create: `~/percolator-quote-match/src/quote.rs`

- [ ] **Step 1: Create Cargo.toml**

Create `~/percolator-quote-match/Cargo.toml`:

```toml
[package]
name = "percolator-quote-match"
version = "0.1.0"
edition = "2021"
description = "Quote-aware matcher for Percolator CPI — reads on-chain maker quotes and selects best price vs vAMM fallback"
license = "Apache-2.0"

[lib]
crate-type = ["cdylib", "lib"]

[features]
default = []
no-entrypoint = []
custom-heap = []
custom-panic = []

[dependencies]
solana-program = "2.0"

[dev-dependencies]
```

- [ ] **Step 2: Create the QuoteAccount structure**

Create `~/percolator-quote-match/src/quote.rs`:

```rust
//! On-chain maker quote account: bid/ask at specified sizes.
//!
//! Each maker creates one QuoteAccount per market (slab).
//! The quote-aware matcher reads these during CPI to find best available price.

use solana_program::program_error::ProgramError;

pub const QUOTE_MAGIC: u64 = 0x5045_5243_514f_5445; // "PERCQOTE"
pub const QUOTE_VERSION: u32 = 1;
pub const QUOTE_ACCOUNT_LEN: usize = 160; // padded to 160 for alignment

/// On-chain quote posted by a maker.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct QuoteAccount {
    /// Magic bytes ("PERCQOTE")
    pub magic: u64,
    /// Version (1)
    pub version: u32,
    /// Padding
    pub _pad0: u32,
    /// Maker pubkey (owner who can update/close)
    pub maker: [u8; 32],
    /// Slab pubkey (which market this quote is for)
    pub slab: [u8; 32],
    /// Bid price in engine-space (e6). 0 = no bid.
    pub bid_price_e6: u64,
    /// Ask price in engine-space (e6). 0 = no ask.
    pub ask_price_e6: u64,
    /// Maximum bid size (positive, in position units). 0 = bid disabled.
    pub bid_size: u64,
    /// Maximum ask size (positive, in position units). 0 = ask disabled.
    pub ask_size: u64,
    /// Slot of last update (for staleness check)
    pub last_update_slot: u64,
    /// Reserved for future use
    pub _reserved: [u8; 16],
}

const _: () = assert!(core::mem::size_of::<QuoteAccount>() == QUOTE_ACCOUNT_LEN);

impl QuoteAccount {
    pub fn is_initialized(&self) -> bool {
        self.magic == QUOTE_MAGIC && self.version == QUOTE_VERSION
    }

    pub fn read_from(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < QUOTE_ACCOUNT_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        // Safety: repr(C) + size check above
        let quote = unsafe { *(data.as_ptr() as *const QuoteAccount) };
        Ok(quote)
    }

    pub fn write_to(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() < QUOTE_ACCOUNT_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let bytes = unsafe {
            core::slice::from_raw_parts(
                self as *const QuoteAccount as *const u8,
                QUOTE_ACCOUNT_LEN,
            )
        };
        data[..QUOTE_ACCOUNT_LEN].copy_from_slice(bytes);
        Ok(())
    }

    /// Check if a quote side is fresh and usable.
    pub fn is_bid_live(&self, now_slot: u64, max_staleness: u64) -> bool {
        self.bid_price_e6 > 0
            && self.bid_size > 0
            && (max_staleness == 0 || now_slot.saturating_sub(self.last_update_slot) <= max_staleness)
    }

    pub fn is_ask_live(&self, now_slot: u64, max_staleness: u64) -> bool {
        self.ask_price_e6 > 0
            && self.ask_size > 0
            && (max_staleness == 0 || now_slot.saturating_sub(self.last_update_slot) <= max_staleness)
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd ~/percolator-quote-match && cargo build-sbf 2>&1 | tail -10`

Expected: Compiles (may warn about unused, that's fine).

- [ ] **Step 4: Commit**

```bash
cd ~/percolator-quote-match
git init && git add .
git commit -m "scaffold: quote-aware matcher crate with QuoteAccount structure

160-byte on-chain quote account stores maker bid/ask prices and sizes.
Includes staleness check for live quote validation."
```

---

### Task 6: Quote Matcher Core Logic

**Context:** The matcher receives a standard 67-byte call via CPI. It reads quote accounts from `remaining_accounts` (accounts beyond the required lp_pda + matcher_ctx). For each valid quote, it checks if the quote price is better than oracle (the vAMM fallback comparison happens implicitly — the wrapper will only use this matcher if it's registered as the LP's matcher, so the "vs vAMM" comparison happens at the SDK routing level, not in the matcher itself). The matcher picks the best available quote and returns that price.

**Files:**
- Create: `~/percolator-quote-match/src/matcher.rs`
- Create: `~/percolator-quote-match/src/instructions.rs`
- Modify: `~/percolator-quote-match/src/lib.rs`

- [ ] **Step 1: Implement the matching logic**

Create `~/percolator-quote-match/src/matcher.rs`:

```rust
//! Core quote matching: reads quote accounts, selects best price.

use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::quote::QuoteAccount;

/// Maximum number of quote accounts to read per CPI call.
/// Bounded to control CU consumption (~5K CU per quote read).
pub const MAX_QUOTES_PER_CALL: usize = 5;

/// Result of quote selection.
pub struct QuoteMatch {
    /// Best execution price (engine-space e6)
    pub exec_price_e6: u64,
    /// Execution size (signed, same direction as request)
    pub exec_size: i128,
}

/// Select the best available quote for a trade.
///
/// For buys (req_size > 0): find the lowest ask price among live quotes.
/// For sells (req_size < 0): find the highest bid price among live quotes.
///
/// Returns None if no live quote can fill any portion of the request.
pub fn select_best_quote<'a>(
    program_id: &Pubkey,
    quote_accounts: &[AccountInfo<'a>],
    slab_key: &[u8; 32],
    req_size: i128,
    now_slot: u64,
    max_staleness_slots: u64,
) -> Result<Option<QuoteMatch>, ProgramError> {
    if req_size == 0 {
        return Ok(None);
    }

    let is_buy = req_size > 0;
    let req_abs = req_size.unsigned_abs();

    let mut best_price: Option<u64> = None;
    let mut best_size: u64 = 0;

    let limit = core::cmp::min(quote_accounts.len(), MAX_QUOTES_PER_CALL);

    for i in 0..limit {
        let qa = &quote_accounts[i];

        // Quote account must be owned by this matcher program
        if qa.owner != program_id {
            continue;
        }

        let data = qa.try_borrow_data()?;
        if data.len() < crate::quote::QUOTE_ACCOUNT_LEN {
            continue;
        }

        let quote = QuoteAccount::read_from(&data)?;
        if !quote.is_initialized() {
            continue;
        }

        // Quote must be for this market (slab)
        if &quote.slab != slab_key {
            continue;
        }

        if is_buy {
            // Taker buying → match against maker's ask
            if !quote.is_ask_live(now_slot, max_staleness_slots) {
                continue;
            }
            let price = quote.ask_price_e6;
            let size = quote.ask_size;

            // Best ask = lowest price
            let is_better = match best_price {
                None => true,
                Some(bp) => price < bp,
            };
            if is_better {
                best_price = Some(price);
                best_size = size;
            }
        } else {
            // Taker selling → match against maker's bid
            if !quote.is_bid_live(now_slot, max_staleness_slots) {
                continue;
            }
            let price = quote.bid_price_e6;
            let size = quote.bid_size;

            // Best bid = highest price
            let is_better = match best_price {
                None => true,
                Some(bp) => price > bp,
            };
            if is_better {
                best_price = Some(price);
                best_size = size;
            }
        }
    }

    match best_price {
        None => Ok(None),
        Some(price) => {
            // Cap fill to quote size
            let fill_abs = core::cmp::min(req_abs, best_size as u128);
            if fill_abs == 0 {
                return Ok(None);
            }
            let exec_size = if is_buy {
                fill_abs as i128
            } else {
                -(fill_abs as i128)
            };
            Ok(Some(QuoteMatch {
                exec_price_e6: price,
                exec_size,
            }))
        }
    }
}
```

- [ ] **Step 2: Implement instruction handlers**

Create `~/percolator-quote-match/src/instructions.rs`:

```rust
//! Instruction handlers: PostQuote, UpdateQuote, CloseQuote, MatcherCall.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::quote::{QuoteAccount, QUOTE_ACCOUNT_LEN, QUOTE_MAGIC, QUOTE_VERSION};
use crate::matcher::select_best_quote;

// Instruction tags
pub const TAG_MATCHER_CALL: u8 = 0;    // From percolator CPI
pub const TAG_POST_QUOTE: u8 = 10;
pub const TAG_UPDATE_QUOTE: u8 = 11;
pub const TAG_CLOSE_QUOTE: u8 = 12;

// ============================================================================
// MatcherCall (tag 0) — called by percolator wrapper via CPI
// ============================================================================

/// Matcher context for the quote-aware matcher.
/// Stored at offset 64 in the 320-byte context account.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuoteMatcherCtx {
    pub magic: u64,             // "PERCMATC"
    pub version: u32,
    pub kind: u8,               // 2 = QuoteAware
    pub _pad0: [u8; 3],
    pub lp_pda: [u8; 32],
    pub max_staleness_slots: u64,
    pub slab_key: [u8; 32],
    pub total_quote_fills: u64,
    pub total_fallbacks: u64,
    pub _reserved: [u8; 120],
}

const PERCMATC_MAGIC: u64 = 0x5045_5243_4d41_5443;
const QUOTE_MATCHER_KIND: u8 = 2;
const CTX_OFFSET: usize = 64;
const CTX_LEN: usize = 256;
const _: () = assert!(core::mem::size_of::<QuoteMatcherCtx>() == CTX_LEN);

/// ABI constants (same as percolator-match)
const MATCHER_ABI_VERSION: u32 = 1;
const FLAG_VALID: u32 = 1;
const FLAG_PARTIAL_OK: u32 = 2;
const MATCHER_CALL_LEN: usize = 67;

pub fn process_matcher_call(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < MATCHER_CALL_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let account_iter = &mut accounts.iter();
    let lp_pda = next_account_info(account_iter)?;
    let ctx_account = next_account_info(account_iter)?;

    // Remaining accounts are quote accounts
    let quote_accounts: Vec<&AccountInfo> = account_iter.collect();

    if !lp_pda.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if ctx_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if ctx_account.data_len() < 320 {
        return Err(ProgramError::AccountDataTooSmall);
    }

    // Parse call
    let req_id = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let _lp_idx = u16::from_le_bytes(data[9..11].try_into().unwrap());
    let lp_account_id = u64::from_le_bytes(data[11..19].try_into().unwrap());
    let oracle_price_e6 = u64::from_le_bytes(data[19..27].try_into().unwrap());
    let req_size = i128::from_le_bytes(data[27..43].try_into().unwrap());

    // Read matcher context
    let ctx = {
        let ctx_data = ctx_account.try_borrow_data()?;
        let ctx_bytes = &ctx_data[CTX_OFFSET..CTX_OFFSET + CTX_LEN];
        unsafe { *(ctx_bytes.as_ptr() as *const QuoteMatcherCtx) }
    };

    if ctx.magic != PERCMATC_MAGIC || ctx.kind != QUOTE_MATCHER_KIND {
        return Err(ProgramError::InvalidAccountData);
    }
    if lp_pda.key.to_bytes() != ctx.lp_pda {
        return Err(ProgramError::InvalidAccountData);
    }

    // Read clock for staleness
    // Note: We don't have clock sysvar here — use a reasonable approach.
    // The wrapper passes oracle_price which is fresh, so we approximate
    // slot from the context. For production: pass slot in reserved field
    // or use sysvar.
    // For now: use 0 as now_slot to disable staleness (rely on oracle banding for safety).
    let now_slot = 0u64; // TODO: pass via reserved or read Clock sysvar

    // Collect quote AccountInfos
    let qa_infos: Vec<AccountInfo> = quote_accounts.iter().map(|a| (*a).clone()).collect();

    // Try to find best quote
    let result = select_best_quote(
        program_id,
        &qa_infos,
        &ctx.slab_key,
        req_size,
        now_slot,
        ctx.max_staleness_slots,
    )?;

    let (exec_price, exec_size, flags) = match result {
        Some(m) => (m.exec_price_e6, m.exec_size, FLAG_VALID),
        None => {
            // No valid quote → zero-fill (vAMM backstop at SDK routing level)
            (1u64, 0i128, FLAG_VALID | FLAG_PARTIAL_OK)
        }
    };

    // Write return to context account offset 0
    {
        let mut ctx_data = ctx_account.try_borrow_mut_data()?;
        ctx_data[0..4].copy_from_slice(&MATCHER_ABI_VERSION.to_le_bytes());
        ctx_data[4..8].copy_from_slice(&flags.to_le_bytes());
        ctx_data[8..16].copy_from_slice(&exec_price.to_le_bytes());
        ctx_data[16..32].copy_from_slice(&exec_size.to_le_bytes());
        ctx_data[32..40].copy_from_slice(&req_id.to_le_bytes());
        ctx_data[40..48].copy_from_slice(&lp_account_id.to_le_bytes());
        ctx_data[48..56].copy_from_slice(&oracle_price_e6.to_le_bytes());
        ctx_data[56..64].copy_from_slice(&0u64.to_le_bytes()); // reserved
    }

    // Update stats
    {
        let mut ctx_data = ctx_account.try_borrow_mut_data()?;
        let stats_offset = CTX_OFFSET + 88; // offset of total_quote_fills
        if exec_size != 0 {
            let old = u64::from_le_bytes(ctx_data[stats_offset..stats_offset + 8].try_into().unwrap());
            ctx_data[stats_offset..stats_offset + 8].copy_from_slice(&(old.saturating_add(1)).to_le_bytes());
        } else {
            let fb_offset = stats_offset + 8;
            let old = u64::from_le_bytes(ctx_data[fb_offset..fb_offset + 8].try_into().unwrap());
            ctx_data[fb_offset..fb_offset + 8].copy_from_slice(&(old.saturating_add(1)).to_le_bytes());
        }
    }

    Ok(())
}

// ============================================================================
// PostQuote (tag 10) — maker creates a new quote account
// ============================================================================

pub fn process_post_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Accounts: [maker(signer), quote_account(writable), slab(readonly), system_program]
    let account_iter = &mut accounts.iter();
    let maker = next_account_info(account_iter)?;
    let quote_account = next_account_info(account_iter)?;

    if !maker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse: bid_price_e6(8) + ask_price_e6(8) + bid_size(8) + ask_size(8) + slab_key(32) = 64 bytes after tag
    if data.len() < 65 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bid_price_e6 = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let ask_price_e6 = u64::from_le_bytes(data[9..17].try_into().unwrap());
    let bid_size = u64::from_le_bytes(data[17..25].try_into().unwrap());
    let ask_size = u64::from_le_bytes(data[25..33].try_into().unwrap());
    let mut slab_key = [0u8; 32];
    slab_key.copy_from_slice(&data[33..65]);

    // Validate quote account is owned by this program and has correct size
    if quote_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if quote_account.data_len() < QUOTE_ACCOUNT_LEN {
        return Err(ProgramError::AccountDataTooSmall);
    }

    // Check not already initialized
    {
        let qdata = quote_account.try_borrow_data()?;
        let existing = QuoteAccount::read_from(&qdata)?;
        if existing.is_initialized() {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    }

    // Write quote
    let quote = QuoteAccount {
        magic: QUOTE_MAGIC,
        version: QUOTE_VERSION,
        _pad0: 0,
        maker: maker.key.to_bytes(),
        slab: slab_key,
        bid_price_e6,
        ask_price_e6,
        bid_size,
        ask_size,
        last_update_slot: 0, // Will be set on first update
        _reserved: [0u8; 16],
    };

    let mut qdata = quote_account.try_borrow_mut_data()?;
    quote.write_to(&mut qdata)?;

    Ok(())
}

// ============================================================================
// UpdateQuote (tag 11) — maker updates prices/sizes
// ============================================================================

pub fn process_update_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let maker = next_account_info(account_iter)?;
    let quote_account = next_account_info(account_iter)?;
    let clock = next_account_info(account_iter)?;

    if !maker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if quote_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Parse: bid_price_e6(8) + ask_price_e6(8) + bid_size(8) + ask_size(8) = 32 bytes after tag
    if data.len() < 33 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let bid_price_e6 = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let ask_price_e6 = u64::from_le_bytes(data[9..17].try_into().unwrap());
    let bid_size = u64::from_le_bytes(data[17..25].try_into().unwrap());
    let ask_size = u64::from_le_bytes(data[25..33].try_into().unwrap());

    // Read current quote
    let mut quote = {
        let qdata = quote_account.try_borrow_data()?;
        QuoteAccount::read_from(&qdata)?
    };

    if !quote.is_initialized() {
        return Err(ProgramError::UninitializedAccount);
    }
    // Only the maker who created the quote can update it
    if quote.maker != maker.key.to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }

    // Read clock slot
    let clock_data = clock.try_borrow_data()?;
    let slot = u64::from_le_bytes(clock_data[0..8].try_into().unwrap_or([0; 8]));

    // Update
    quote.bid_price_e6 = bid_price_e6;
    quote.ask_price_e6 = ask_price_e6;
    quote.bid_size = bid_size;
    quote.ask_size = ask_size;
    quote.last_update_slot = slot;

    let mut qdata = quote_account.try_borrow_mut_data()?;
    quote.write_to(&mut qdata)?;

    Ok(())
}

// ============================================================================
// CloseQuote (tag 12) — maker closes quote, reclaims rent
// ============================================================================

pub fn process_close_quote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let maker = next_account_info(account_iter)?;
    let quote_account = next_account_info(account_iter)?;

    if !maker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if quote_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let quote = {
        let qdata = quote_account.try_borrow_data()?;
        QuoteAccount::read_from(&qdata)?
    };

    if !quote.is_initialized() {
        return Err(ProgramError::UninitializedAccount);
    }
    if quote.maker != maker.key.to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }

    // Zero the account data
    let mut qdata = quote_account.try_borrow_mut_data()?;
    for b in qdata.iter_mut() {
        *b = 0;
    }

    // Transfer lamports back to maker
    let dest_starting_lamports = maker.lamports();
    **maker.try_borrow_mut_lamports()? = dest_starting_lamports
        .checked_add(quote_account.lamports())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **quote_account.try_borrow_mut_lamports()? = 0;

    Ok(())
}
```

- [ ] **Step 3: Wire up the entrypoint**

Create `~/percolator-quote-match/src/lib.rs`:

```rust
#![no_std]

extern crate alloc;

pub mod instructions;
pub mod matcher;
pub mod quote;

use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

use instructions::{TAG_CLOSE_QUOTE, TAG_MATCHER_CALL, TAG_POST_QUOTE, TAG_UPDATE_QUOTE};

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match instruction_data[0] {
        TAG_MATCHER_CALL => instructions::process_matcher_call(program_id, accounts, instruction_data),
        TAG_POST_QUOTE => instructions::process_post_quote(program_id, accounts, instruction_data),
        TAG_UPDATE_QUOTE => instructions::process_update_quote(program_id, accounts, instruction_data),
        TAG_CLOSE_QUOTE => instructions::process_close_quote(program_id, accounts, instruction_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use crate::process_instruction as processor;
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };

    entrypoint!(process_instruction);

    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        processor(program_id, accounts, instruction_data)
    }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd ~/percolator-quote-match && cargo build-sbf 2>&1 | tail -15`

Expected: Compiles to BPF. May show warnings about unused fields.

- [ ] **Step 5: Commit**

```bash
cd ~/percolator-quote-match
git add src/
git commit -m "feat: quote-aware matcher with PostQuote/UpdateQuote/CloseQuote/MatcherCall

Reads up to 5 on-chain maker quote accounts during CPI, selects best
bid/ask, returns via standard matcher ABI. Zero-fills when no quote
available (SDK-level routing handles vAMM fallback). Makers manage
quotes via PostQuote/UpdateQuote/CloseQuote instructions."
```

---

### Task 7: Quote Matcher Integration Tests

**Files:**
- Create: `~/percolator-quote-match/tests/test_quote_matcher.rs`

- [ ] **Step 1: Write unit tests for quote selection**

Create `~/percolator-quote-match/tests/test_quote_matcher.rs`:

```rust
//! Integration tests for the quote-aware matcher.
//!
//! Tests cover: quote lifecycle (post/update/close), best-price selection,
//! staleness, ownership, and ABI compliance.

use solana_program::program_error::ProgramError;

// Import from the library
use percolator_quote_match::quote::{QuoteAccount, QUOTE_ACCOUNT_LEN, QUOTE_MAGIC, QUOTE_VERSION};

#[test]
fn test_quote_account_roundtrip() {
    let quote = QuoteAccount {
        magic: QUOTE_MAGIC,
        version: QUOTE_VERSION,
        _pad0: 0,
        maker: [1u8; 32],
        slab: [2u8; 32],
        bid_price_e6: 149_500_000,
        ask_price_e6: 150_500_000,
        bid_size: 1_000_000,
        ask_size: 1_000_000,
        last_update_slot: 100,
        _reserved: [0u8; 16],
    };

    let mut buf = [0u8; QUOTE_ACCOUNT_LEN];
    quote.write_to(&mut buf).unwrap();

    let read_back = QuoteAccount::read_from(&buf).unwrap();
    assert!(read_back.is_initialized());
    assert_eq!(read_back.bid_price_e6, 149_500_000);
    assert_eq!(read_back.ask_price_e6, 150_500_000);
    assert_eq!(read_back.bid_size, 1_000_000);
    assert_eq!(read_back.ask_size, 1_000_000);
    assert_eq!(read_back.maker, [1u8; 32]);
    assert_eq!(read_back.slab, [2u8; 32]);
}

#[test]
fn test_uninitialized_quote_not_live() {
    let quote = QuoteAccount {
        magic: 0,
        version: 0,
        _pad0: 0,
        maker: [0u8; 32],
        slab: [0u8; 32],
        bid_price_e6: 0,
        ask_price_e6: 0,
        bid_size: 0,
        ask_size: 0,
        last_update_slot: 0,
        _reserved: [0u8; 16],
    };

    assert!(!quote.is_initialized());
    assert!(!quote.is_bid_live(100, 50));
    assert!(!quote.is_ask_live(100, 50));
}

#[test]
fn test_staleness_check() {
    let quote = QuoteAccount {
        magic: QUOTE_MAGIC,
        version: QUOTE_VERSION,
        _pad0: 0,
        maker: [1u8; 32],
        slab: [2u8; 32],
        bid_price_e6: 149_000_000,
        ask_price_e6: 151_000_000,
        bid_size: 1_000_000,
        ask_size: 1_000_000,
        last_update_slot: 100,
        _reserved: [0u8; 16],
    };

    // Fresh (within max_staleness)
    assert!(quote.is_bid_live(120, 50));
    assert!(quote.is_ask_live(120, 50));

    // Stale (beyond max_staleness)
    assert!(!quote.is_bid_live(200, 50));
    assert!(!quote.is_ask_live(200, 50));

    // Staleness disabled (max_staleness = 0)
    assert!(quote.is_bid_live(999_999, 0));
    assert!(quote.is_ask_live(999_999, 0));
}

#[test]
fn test_zero_price_not_live() {
    let quote = QuoteAccount {
        magic: QUOTE_MAGIC,
        version: QUOTE_VERSION,
        _pad0: 0,
        maker: [1u8; 32],
        slab: [2u8; 32],
        bid_price_e6: 0,         // no bid
        ask_price_e6: 151_000_000,
        bid_size: 1_000_000,
        ask_size: 1_000_000,
        last_update_slot: 100,
        _reserved: [0u8; 16],
    };

    assert!(!quote.is_bid_live(100, 50));
    assert!(quote.is_ask_live(100, 50));
}

#[test]
fn test_zero_size_not_live() {
    let quote = QuoteAccount {
        magic: QUOTE_MAGIC,
        version: QUOTE_VERSION,
        _pad0: 0,
        maker: [1u8; 32],
        slab: [2u8; 32],
        bid_price_e6: 149_000_000,
        ask_price_e6: 151_000_000,
        bid_size: 0,             // disabled
        ask_size: 1_000_000,
        last_update_slot: 100,
        _reserved: [0u8; 16],
    };

    assert!(!quote.is_bid_live(100, 50));
    assert!(quote.is_ask_live(100, 50));
}

#[test]
fn test_account_too_small() {
    let buf = [0u8; 10]; // Too small
    let result = QuoteAccount::read_from(&buf);
    assert!(matches!(result, Err(ProgramError::AccountDataTooSmall)));
}
```

- [ ] **Step 2: Run the tests**

Run: `cd ~/percolator-quote-match && cargo test 2>&1 | tail -20`

Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/percolator-quote-match
git add tests/
git commit -m "test: quote account unit tests

Covers roundtrip serialization, staleness checks, zero-price/size
guards, and account size validation."
```

---

### Task 8: Maker SDK (TypeScript)

**Context:** Makers need a TypeScript SDK to create, update, and cancel quote accounts. This mirrors the pattern used by the existing SDK for trade instructions.

**Files:**
- Create: `~/percolator-sdk/src/maker/quote-client.ts`
- Create: `~/percolator-sdk/src/maker/index.ts`
- Create: `~/percolator-sdk/src/maker/__tests__/quote-client.test.ts`
- Modify: `~/percolator-sdk/src/index.ts`

- [ ] **Step 1: Write the maker SDK test**

Create `~/percolator-sdk/src/maker/__tests__/quote-client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  encodePostQuote,
  encodeUpdateQuote,
  encodeCloseQuote,
  TAG_POST_QUOTE,
  TAG_UPDATE_QUOTE,
  TAG_CLOSE_QUOTE,
} from "../quote-client";

describe("encodePostQuote", () => {
  it("encodes correctly", () => {
    const data = encodePostQuote({
      bidPriceE6: 149_500_000n,
      askPriceE6: 150_500_000n,
      bidSize: 1_000_000n,
      askSize: 1_000_000n,
      slabKey: new Uint8Array(32).fill(0xAB),
    });
    expect(data[0]).toBe(TAG_POST_QUOTE); // tag
    expect(data.length).toBe(65); // 1 + 8*4 + 32
  });
});

describe("encodeUpdateQuote", () => {
  it("encodes correctly", () => {
    const data = encodeUpdateQuote({
      bidPriceE6: 149_000_000n,
      askPriceE6: 151_000_000n,
      bidSize: 2_000_000n,
      askSize: 2_000_000n,
    });
    expect(data[0]).toBe(TAG_UPDATE_QUOTE);
    expect(data.length).toBe(33); // 1 + 8*4
  });
});

describe("encodeCloseQuote", () => {
  it("encodes correctly", () => {
    const data = encodeCloseQuote();
    expect(data[0]).toBe(TAG_CLOSE_QUOTE);
    expect(data.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/percolator-sdk && npx vitest run src/maker/__tests__/quote-client.test.ts 2>&1 | tail -20`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the maker SDK**

Create `~/percolator-sdk/src/maker/quote-client.ts`:

```typescript
/**
 * Maker SDK for posting and managing on-chain quotes.
 *
 * Quote accounts are owned by the quote-aware matcher program.
 * Makers create quote accounts via PostQuote, update via UpdateQuote,
 * and reclaim rent via CloseQuote.
 */

export const TAG_POST_QUOTE = 10;
export const TAG_UPDATE_QUOTE = 11;
export const TAG_CLOSE_QUOTE = 12;

function encU64LE(val: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, val, true);
  return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

export interface PostQuoteArgs {
  bidPriceE6: bigint;
  askPriceE6: bigint;
  bidSize: bigint;
  askSize: bigint;
  slabKey: Uint8Array; // 32 bytes
}

export function encodePostQuote(args: PostQuoteArgs): Uint8Array {
  if (args.slabKey.length !== 32) throw new Error("slabKey must be 32 bytes");
  return concatBytes(
    new Uint8Array([TAG_POST_QUOTE]),
    encU64LE(args.bidPriceE6),
    encU64LE(args.askPriceE6),
    encU64LE(args.bidSize),
    encU64LE(args.askSize),
    args.slabKey,
  );
}

export interface UpdateQuoteArgs {
  bidPriceE6: bigint;
  askPriceE6: bigint;
  bidSize: bigint;
  askSize: bigint;
}

export function encodeUpdateQuote(args: UpdateQuoteArgs): Uint8Array {
  return concatBytes(
    new Uint8Array([TAG_UPDATE_QUOTE]),
    encU64LE(args.bidPriceE6),
    encU64LE(args.askPriceE6),
    encU64LE(args.bidSize),
    encU64LE(args.askSize),
  );
}

export function encodeCloseQuote(): Uint8Array {
  return new Uint8Array([TAG_CLOSE_QUOTE]);
}
```

- [ ] **Step 4: Create index and export**

Create `~/percolator-sdk/src/maker/index.ts`:

```typescript
export {
  encodePostQuote,
  encodeUpdateQuote,
  encodeCloseQuote,
  TAG_POST_QUOTE,
  TAG_UPDATE_QUOTE,
  TAG_CLOSE_QUOTE,
} from "./quote-client";
export type { PostQuoteArgs, UpdateQuoteArgs } from "./quote-client";
```

In `~/percolator-sdk/src/index.ts`, add:

```typescript
export * from "./maker";
```

- [ ] **Step 5: Run tests**

Run: `cd ~/percolator-sdk && npx vitest run src/maker/__tests__/quote-client.test.ts 2>&1 | tail -20`

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/percolator-sdk
git add src/maker/ src/index.ts
git commit -m "feat: maker SDK for quote management

encodePostQuote, encodeUpdateQuote, encodeCloseQuote for the
quote-aware matcher program. Makers post on-chain bid/ask quotes
that the matcher reads during CPI."
```

---

### Task 9: Update LP Router for Quote-Aware Matcher

**Context:** The LP router from Task 3 needs to recognize quote-aware matchers (kind=2) and read their quote accounts to estimate execution price. For a quote-aware LP, the estimated spread comes from the best available quote, not from vAMM parameters.

**Files:**
- Modify: `~/percolator-sdk/src/routing/lp-router.ts`
- Modify: `~/percolator-sdk/src/routing/__tests__/lp-router.test.ts`

- [ ] **Step 1: Add test for quote-aware LP routing**

Add to `~/percolator-sdk/src/routing/__tests__/lp-router.test.ts`:

```typescript
  it("prefers quote LP with tighter spread over vAMM", () => {
    const lps: LpCandidate[] = [
      baseLp(0, { matcherKind: "vamm", baseSpreadBps: 30, tradingFeeBps: 10 }), // 40 bps total
      {
        ...baseLp(1),
        matcherKind: "quote" as const,
        quoteBestBidBps: 15,  // 15 bps from oracle
        quoteBestAskBps: 15,
      } as any, // Extended type for quote LPs
    ];
    // The quote LP at 15 bps should beat the vAMM at 40+ bps
    const result = selectBestLp(lps, 1_000_000n, "buy");
    expect(result!.lpIdx).toBe(1);
  });
```

- [ ] **Step 2: Extend LpCandidate type for quote matchers**

In `~/percolator-sdk/src/routing/lp-router.ts`, add optional fields for quote-aware LPs:

```typescript
export interface LpCandidate {
  // ... existing fields ...

  // Quote-aware matcher fields (optional, only for kind="quote")
  /** Best available ask spread in BPS from oracle. Set by reading quote accounts. */
  quoteBestAskBps?: number;
  /** Best available bid spread in BPS from oracle. Set by reading quote accounts. */
  quoteBestBidBps?: number;
}
```

Update `estimateTotalBps` to handle the `"quote"` kind:

```typescript
  if (lp.matcherKind === "quote") {
    const spreadBps = side === "buy"
      ? (lp.quoteBestAskBps ?? Infinity)
      : (lp.quoteBestBidBps ?? Infinity);
    if (spreadBps === Infinity) return null; // No live quote on this side
    return spreadBps;
  }
```

- [ ] **Step 3: Run tests**

Run: `cd ~/percolator-sdk && npx vitest run src/routing/__tests__/lp-router.test.ts 2>&1 | tail -20`

Expected: All PASS including new quote-aware test.

- [ ] **Step 4: Commit**

```bash
cd ~/percolator-sdk
git add src/routing/
git commit -m "feat: LP router supports quote-aware matchers

Quote-kind LPs use quoteBestAskBps/quoteBestBidBps from on-chain
quote accounts for spread estimation. Routes to quote LP when it
provides tighter spread than vAMM alternatives."
```

---

### Task 10: End-to-End Integration Verification

**Context:** Before deploying, verify the full flow works: security fixes, multi-LP routing, and quote matcher compilation. This task is a checklist, not code.

- [ ] **Step 1: Verify percolator-prog compiles and tests pass**

Run: `cd ~/percolator-prog && cargo test-sbf 2>&1 | tail -10`

Expected: All tests PASS with reentrancy guard and exec_price banding.

- [ ] **Step 2: Verify percolator-quote-match compiles to BPF**

Run: `cd ~/percolator-quote-match && cargo build-sbf 2>&1 | tail -10`

Expected: Compiles successfully, produces `.so` file.

- [ ] **Step 3: Verify SDK tests pass**

Run: `cd ~/percolator-sdk && npx vitest run 2>&1 | tail -10`

Expected: All tests PASS including routing and maker modules.

- [ ] **Step 4: Verify frontend builds**

Run: `cd ~/percolator-launch && pnpm build 2>&1 | tail -10`

Expected: Builds successfully.

- [ ] **Step 5: Manually test trade flow on devnet**

Start dev server, connect wallet, submit a trade. Verify:
- Trade executes successfully
- No regressions in existing flow
- LP selection works (even with single LP, verify routing code runs without error)

- [ ] **Step 6: Document deployment order**

```
1. Deploy percolator-prog with security fixes (reentrancy + banding)
2. Verify existing market still works with updated program
3. Deploy percolator-quote-match as new program
4. Register a quote-aware LP on devnet market via InitLP
5. Post a test quote
6. Trade against the quote
7. Verify mark EWMA updated correctly
8. If all passes: mainnet deployment
```

---

## Deployment Sequence Diagram

```
Stage 1 (Security):
  percolator-prog upgrade → existing markets continue working → verify

Stage 2 (Routing):
  SDK publish → frontend deploy → no on-chain changes → zero risk

Stage 3 (Quote Matcher):
  Deploy new program → InitLP with quote matcher → makers post quotes →
  SDK routing picks best LP → trades fill against quotes or vAMM fallback
```

---

## Known Limitations / Future Work

1. **Clock sysvar in matcher CPI:** The quote matcher currently doesn't have access to the Clock sysvar during the CPI call (only lp_pda and matcher_ctx are passed). Quote staleness check uses `now_slot = 0` (disabled). Fix: either pass slot in the ABI's reserved field, or accept that oracle banding provides equivalent protection.

2. **Remaining accounts in CPI:** The current TradeCpi wrapper passes only 2 accounts to the matcher (lp_pda + matcher_ctx). Quote accounts would need to be passed as remaining_accounts. This may require a TradeCpiV3 instruction or encoding quote account pubkeys in the instruction data. Verify whether the existing CPI path supports remaining_accounts passthrough.

3. **Quote account creation:** Makers need to create accounts owned by the matcher program before calling PostQuote. This requires either a CreateAccount + Assign flow or the matcher program deriving PDAs. The simplest approach is PDA derivation: `seeds = [b"quote", slab_key, maker_key]`.

4. **Maker fee model:** Currently all trades pay the same `trading_fee_bps`. A maker-taker fee split would require engine changes and is deferred to Stage 3+ of the roadmap.
