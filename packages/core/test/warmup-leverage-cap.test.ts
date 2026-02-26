/**
 * Warmup leverage cap unit tests — PERC-215
 *
 * Verifies that during the warmup period:
 *   1. Capital unlocks linearly over warmupPeriodSlots
 *   2. Effective leverage is correctly capped based on unlocked capital
 *   3. Maximum position size respects the warmup constraint
 *   4. Edge cases (0 capital, 0 period, overflow, etc.) are handled
 *
 * QA gap flagged before mainnet sign-off.
 */

import {
  computeWarmupUnlockedCapital,
  computeWarmupLeverageCap,
  computeWarmupMaxPositionSize,
  computeMaxLeverage,
} from "../src/math/trading";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function assertEq(actual: bigint | number, expected: bigint | number, msg: string): void {
  if (actual !== expected) {
    console.error(`  ✗ ${msg}: expected ${expected}, got ${actual}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

// =============================================================================
// computeWarmupUnlockedCapital
// =============================================================================

console.log("--- computeWarmupUnlockedCapital ---");

// Basic linear unlock
{
  const total = 1_000_000n; // 1M native units (1 USDC @ 6 decimals)
  const start = 100n;
  const period = 1000n;

  assertEq(
    computeWarmupUnlockedCapital(total, 100n, start, period),
    0n,
    "0% elapsed → 0 unlocked",
  );

  assertEq(
    computeWarmupUnlockedCapital(total, 200n, start, period),
    100_000n,
    "10% elapsed → 10% unlocked",
  );

  assertEq(
    computeWarmupUnlockedCapital(total, 350n, start, period),
    250_000n,
    "25% elapsed → 25% unlocked",
  );

  assertEq(
    computeWarmupUnlockedCapital(total, 600n, start, period),
    500_000n,
    "50% elapsed → 50% unlocked",
  );

  assertEq(
    computeWarmupUnlockedCapital(total, 850n, start, period),
    750_000n,
    "75% elapsed → 75% unlocked",
  );

  assertEq(
    computeWarmupUnlockedCapital(total, 1100n, start, period),
    total,
    "100% elapsed → all unlocked",
  );

  assertEq(
    computeWarmupUnlockedCapital(total, 2000n, start, period),
    total,
    "200% elapsed (past warmup) → all unlocked",
  );
}

// Edge: warmup not started (start slot = 0) → all capital available
assertEq(
  computeWarmupUnlockedCapital(1_000_000n, 500n, 0n, 1000n),
  1_000_000n,
  "warmup not started (start=0) → all unlocked",
);

// Edge: warmup period = 0 → all capital available
assertEq(
  computeWarmupUnlockedCapital(1_000_000n, 500n, 100n, 0n),
  1_000_000n,
  "warmup period=0 → all unlocked",
);

// Edge: zero capital
assertEq(
  computeWarmupUnlockedCapital(0n, 500n, 100n, 1000n),
  0n,
  "zero capital → 0 unlocked",
);

// Edge: negative capital (shouldn't happen, but guard)
assertEq(
  computeWarmupUnlockedCapital(-1n, 500n, 100n, 1000n),
  0n,
  "negative capital → 0 unlocked",
);

// Edge: current slot before warmup start
assertEq(
  computeWarmupUnlockedCapital(1_000_000n, 50n, 100n, 1000n),
  0n,
  "current slot < start slot → 0 unlocked",
);

// Edge: current slot equals warmup start
assertEq(
  computeWarmupUnlockedCapital(1_000_000n, 100n, 100n, 1000n),
  0n,
  "current slot == start slot → 0 unlocked",
);

// Large values — no overflow
{
  const hugeCapital = 10_000_000_000_000_000n; // 10B native (10K USDC @ 9 decimals)
  const start = 280_000_000n;
  const period = 10_000n;
  const midpoint = start + period / 2n;

  assertEq(
    computeWarmupUnlockedCapital(hugeCapital, midpoint, start, period),
    hugeCapital / 2n,
    "large capital at 50% → exact half (no overflow)",
  );
}

// =============================================================================
// computeWarmupLeverageCap
// =============================================================================

console.log("\n--- computeWarmupLeverageCap ---");

// Scenario: 10x market (initialMarginBps = 1000), warmup at various stages
{
  const imbps = 1000n; // 10x max leverage
  const total = 1_000_000n;
  const start = 100n;
  const period = 1000n;

  // Sanity: base max leverage
  assertEq(computeMaxLeverage(imbps), 10, "base max leverage = 10x");

  // 0% warmup → min 1x
  assertEq(
    computeWarmupLeverageCap(imbps, total, 100n, start, period),
    1,
    "0% warmup → 1x (minimum)",
  );

  // 10% warmup → 10x * 0.1 = 1x (floored)
  assertEq(
    computeWarmupLeverageCap(imbps, total, 200n, start, period),
    1,
    "10% warmup (10x base) → 1x",
  );

  // 50% warmup → 10x * 0.5 = 5x
  assertEq(
    computeWarmupLeverageCap(imbps, total, 600n, start, period),
    5,
    "50% warmup (10x base) → 5x",
  );

  // 75% warmup → 10x * 0.75 = 7x (floored from 7.5)
  assertEq(
    computeWarmupLeverageCap(imbps, total, 850n, start, period),
    7,
    "75% warmup (10x base) → 7x (floored)",
  );

  // 100% warmup → full 10x
  assertEq(
    computeWarmupLeverageCap(imbps, total, 1100n, start, period),
    10,
    "100% warmup → full 10x",
  );

  // Past warmup → full 10x
  assertEq(
    computeWarmupLeverageCap(imbps, total, 5000n, start, period),
    10,
    "past warmup → full 10x",
  );
}

// Scenario: 20x market (initialMarginBps = 500)
{
  const imbps = 500n; // 20x max leverage
  const total = 1_000_000n;
  const start = 100n;
  const period = 1000n;

  assertEq(
    computeWarmupLeverageCap(imbps, total, 350n, start, period),
    5,
    "25% warmup (20x base) → 5x",
  );

  assertEq(
    computeWarmupLeverageCap(imbps, total, 600n, start, period),
    10,
    "50% warmup (20x base) → 10x",
  );

  assertEq(
    computeWarmupLeverageCap(imbps, total, 1100n, start, period),
    20,
    "100% warmup (20x base) → 20x",
  );
}

// Scenario: 50x market (initialMarginBps = 200)
{
  const imbps = 200n; // 50x max leverage
  const total = 10_000_000n;
  const start = 280_000_000n;
  const period = 2000n;

  // 1% → 50x * 0.01 = 0.5 → floored to 1 (minimum)
  assertEq(
    computeWarmupLeverageCap(imbps, total, start + 20n, start, period),
    1,
    "1% warmup (50x base) → 1x (minimum)",
  );

  // 10% → 50x * 0.1 = 5x
  assertEq(
    computeWarmupLeverageCap(imbps, total, start + 200n, start, period),
    5,
    "10% warmup (50x base) → 5x",
  );

  // 60% → 50x * 0.6 = 30x
  assertEq(
    computeWarmupLeverageCap(imbps, total, start + 1200n, start, period),
    30,
    "60% warmup (50x base) → 30x",
  );
}

// Edge: no warmup configured → full leverage
assertEq(
  computeWarmupLeverageCap(1000n, 1_000_000n, 500n, 100n, 0n),
  10,
  "no warmup period → full 10x",
);

// Edge: warmup not started → full leverage
assertEq(
  computeWarmupLeverageCap(1000n, 1_000_000n, 500n, 0n, 1000n),
  10,
  "warmup not started → full 10x",
);

// Edge: zero capital → 1x
assertEq(
  computeWarmupLeverageCap(1000n, 0n, 500n, 100n, 1000n),
  1,
  "zero capital → 1x",
);

// Edge: 1x market (initialMarginBps = 10000)
assertEq(
  computeWarmupLeverageCap(10000n, 1_000_000n, 600n, 100n, 1000n),
  1,
  "1x market during warmup → 1x always",
);

// =============================================================================
// computeWarmupMaxPositionSize
// =============================================================================

console.log("\n--- computeWarmupMaxPositionSize ---");

// Basic scenario: 10x market
{
  const imbps = 1000n; // 10x
  const total = 1_000_000n;
  const start = 100n;
  const period = 1000n;

  // 0% → 0 unlocked, so maxPos = 0
  assertEq(
    computeWarmupMaxPositionSize(imbps, total, 100n, start, period),
    0n,
    "0% warmup → 0 position size",
  );

  // 50% → 500K unlocked * 10x = 5M
  assertEq(
    computeWarmupMaxPositionSize(imbps, total, 600n, start, period),
    5_000_000n,
    "50% warmup (10x) → 5M max position",
  );

  // 100% → 1M unlocked * 10x = 10M
  assertEq(
    computeWarmupMaxPositionSize(imbps, total, 1100n, start, period),
    10_000_000n,
    "100% warmup (10x) → 10M max position",
  );
}

// No warmup → full position
assertEq(
  computeWarmupMaxPositionSize(1000n, 1_000_000n, 500n, 0n, 1000n),
  10_000_000n,
  "no warmup → full 10M position",
);

// Zero capital → zero position
assertEq(
  computeWarmupMaxPositionSize(1000n, 0n, 500n, 100n, 1000n),
  0n,
  "zero capital → 0 position",
);

// Large values — no overflow
{
  const hugeCapital = 1_000_000_000_000n; // 1T native
  const imbps = 500n; // 20x
  const start = 1n;
  const period = 100n;

  const maxPos = computeWarmupMaxPositionSize(imbps, hugeCapital, 51n, start, period);
  const expected = (hugeCapital * 50n / 100n) * 20n; // 50% * 20x
  assertEq(maxPos, expected, "large capital: 50% warmup (20x) → correct max position");
}

// =============================================================================
// Consistency checks: leverage cap × total capital = max position size (approx)
// =============================================================================

console.log("\n--- Consistency: leverageCap × total ≈ maxPosition ---");

{
  const imbps = 1000n; // 10x
  const total = 1_000_000n;
  const start = 100n;
  const period = 1000n;

  for (const slotOffset of [100n, 250n, 500n, 750n, 1000n]) {
    const slot = start + slotOffset;
    const cap = computeWarmupLeverageCap(imbps, total, slot, start, period);
    const maxPos = computeWarmupMaxPositionSize(imbps, total, slot, start, period);

    // maxPos should equal unlocked * maxLev
    // leverageCap is floored, so leverageCap * total <= maxPos
    const approxFromCap = BigInt(cap) * total;
    assert(
      approxFromCap <= maxPos,
      `slot +${slotOffset}: capLev(${cap}x) * total(${total}) = ${approxFromCap} ≤ maxPos(${maxPos})`,
    );
  }
}

// =============================================================================
// Monotonicity: leverage cap never decreases as warmup progresses
// =============================================================================

console.log("\n--- Monotonicity: leverage cap is non-decreasing ---");

{
  const imbps = 500n; // 20x
  const total = 10_000_000n;
  const start = 1000n;
  const period = 500n;

  let prevCap = 0;
  let prevPos = 0n;
  for (let s = 0n; s <= period + 100n; s += 10n) {
    const slot = start + s;
    const cap = computeWarmupLeverageCap(imbps, total, slot, start, period);
    const maxPos = computeWarmupMaxPositionSize(imbps, total, slot, start, period);

    assert(cap >= prevCap, `slot +${s}: leverage ${cap}x ≥ prev ${prevCap}x`);
    assert(maxPos >= prevPos, `slot +${s}: maxPos ${maxPos} ≥ prev ${prevPos}`);

    prevCap = cap;
    prevPos = maxPos;
  }

  // Final value should be the full leverage
  assertEq(prevCap, 20, "final leverage cap = full 20x");
  assertEq(prevPos, total * 20n, "final max position = total × 20");
}

// =============================================================================
// Summary
// =============================================================================

console.log(`\n${failed === 0 ? "✅" : "❌"} Warmup leverage cap: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
