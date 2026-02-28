/**
 * Dynamic fee helpers unit tests — PERC-283
 *
 * Verifies:
 *   1. computeDynamicFeeBps selects correct tier based on notional
 *   2. computeDynamicTradingFee uses ceiling division (matches on-chain)
 *   3. computeFeeSplit preserves total and handles edge cases
 */

import {
  computeDynamicFeeBps,
  computeDynamicTradingFee,
  computeFeeSplit,
  type FeeTierConfig,
  type FeeSplitConfig,
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
// computeDynamicFeeBps
// =============================================================================

console.log("--- computeDynamicFeeBps ---");

{
  const config: FeeTierConfig = {
    baseBps: 5n,
    tier2Bps: 8n,
    tier3Bps: 12n,
    tier2Threshold: 500_000n,
    tier3Threshold: 5_000_000n,
  };

  assertEq(
    computeDynamicFeeBps(100_000n, config),
    5n,
    "notional below tier2 threshold → baseBps (Tier 1)",
  );

  assertEq(
    computeDynamicFeeBps(499_999n, config),
    5n,
    "notional just below tier2 threshold → baseBps",
  );

  assertEq(
    computeDynamicFeeBps(500_000n, config),
    8n,
    "notional exactly at tier2 threshold → tier2Bps",
  );

  assertEq(
    computeDynamicFeeBps(1_000_000n, config),
    8n,
    "notional between tier2 and tier3 → tier2Bps",
  );

  assertEq(
    computeDynamicFeeBps(4_999_999n, config),
    8n,
    "notional just below tier3 threshold → tier2Bps",
  );

  assertEq(
    computeDynamicFeeBps(5_000_000n, config),
    12n,
    "notional exactly at tier3 threshold → tier3Bps",
  );

  assertEq(
    computeDynamicFeeBps(100_000_000n, config),
    12n,
    "notional well above tier3 → tier3Bps",
  );
}

// Tiered fees disabled (tier2Threshold = 0)
{
  const flatConfig: FeeTierConfig = {
    baseBps: 10n,
    tier2Bps: 20n,
    tier3Bps: 30n,
    tier2Threshold: 0n,
    tier3Threshold: 5_000_000n,
  };

  assertEq(
    computeDynamicFeeBps(100_000_000n, flatConfig),
    10n,
    "tier2Threshold=0 disables tiers → always baseBps",
  );

  assertEq(
    computeDynamicFeeBps(0n, flatConfig),
    10n,
    "zero notional with disabled tiers → baseBps",
  );
}

// Two tiers only (tier3Threshold = 0, meaning no tier 3)
{
  const twoTierConfig: FeeTierConfig = {
    baseBps: 5n,
    tier2Bps: 10n,
    tier3Bps: 15n,
    tier2Threshold: 1_000_000n,
    tier3Threshold: 0n,
  };

  assertEq(
    computeDynamicFeeBps(500_000n, twoTierConfig),
    5n,
    "two-tier: below tier2 → baseBps",
  );

  assertEq(
    computeDynamicFeeBps(1_000_000n, twoTierConfig),
    10n,
    "two-tier: at tier2 → tier2Bps",
  );

  assertEq(
    computeDynamicFeeBps(999_999_999n, twoTierConfig),
    10n,
    "two-tier: huge notional stays at tier2 (no tier3 active)",
  );
}

// Zero notional
{
  const config: FeeTierConfig = {
    baseBps: 5n,
    tier2Bps: 8n,
    tier3Bps: 12n,
    tier2Threshold: 500_000n,
    tier3Threshold: 5_000_000n,
  };

  assertEq(
    computeDynamicFeeBps(0n, config),
    5n,
    "zero notional → baseBps (Tier 1)",
  );
}

// =============================================================================
// computeDynamicTradingFee
// =============================================================================

console.log("\n--- computeDynamicTradingFee ---");

{
  const config: FeeTierConfig = {
    baseBps: 5n,
    tier2Bps: 8n,
    tier3Bps: 12n,
    tier2Threshold: 500_000n,
    tier3Threshold: 5_000_000n,
  };

  // Tier 1: ceil(100_000 * 5 / 10_000) = ceil(50) = 50
  assertEq(
    computeDynamicTradingFee(100_000n, config),
    50n,
    "Tier 1 fee: ceil(100k * 5 / 10k) = 50",
  );

  // Tier 2: ceil(1_000_000 * 8 / 10_000) = ceil(800) = 800
  assertEq(
    computeDynamicTradingFee(1_000_000n, config),
    800n,
    "Tier 2 fee: ceil(1M * 8 / 10k) = 800",
  );

  // Tier 3: ceil(10_000_000 * 12 / 10_000) = ceil(12000) = 12000
  assertEq(
    computeDynamicTradingFee(10_000_000n, config),
    12000n,
    "Tier 3 fee: ceil(10M * 12 / 10k) = 12000",
  );
}

// Ceiling division verification — fee that doesn't divide evenly
{
  const config: FeeTierConfig = {
    baseBps: 3n,
    tier2Bps: 0n,
    tier3Bps: 0n,
    tier2Threshold: 0n,
    tier3Threshold: 0n,
  };

  // 1 * 3 / 10000 = 0.0003 → ceil = 1
  assertEq(
    computeDynamicTradingFee(1n, config),
    1n,
    "ceiling division: tiny notional rounds up to 1",
  );

  // 3333 * 3 / 10000 = 0.9999 → ceil = 1
  assertEq(
    computeDynamicTradingFee(3333n, config),
    1n,
    "ceiling division: 3333 * 3bps → ceil(0.9999) = 1",
  );

  // 3334 * 3 / 10000 = 1.0002 → ceil = 2
  assertEq(
    computeDynamicTradingFee(3334n, config),
    2n,
    "ceiling division: 3334 * 3bps → ceil(1.0002) = 2",
  );
}

// Zero and negative notional
{
  const config: FeeTierConfig = {
    baseBps: 10n,
    tier2Bps: 0n,
    tier3Bps: 0n,
    tier2Threshold: 0n,
    tier3Threshold: 0n,
  };

  assertEq(
    computeDynamicTradingFee(0n, config),
    0n,
    "zero notional → 0 fee",
  );

  assertEq(
    computeDynamicTradingFee(-100n, config),
    0n,
    "negative notional → 0 fee",
  );
}

// Zero bps config
{
  const zeroBpsConfig: FeeTierConfig = {
    baseBps: 0n,
    tier2Bps: 0n,
    tier3Bps: 0n,
    tier2Threshold: 0n,
    tier3Threshold: 0n,
  };

  assertEq(
    computeDynamicTradingFee(1_000_000n, zeroBpsConfig),
    0n,
    "zero bps → 0 fee regardless of notional",
  );
}

// Large values — no overflow
{
  const config: FeeTierConfig = {
    baseBps: 30n,
    tier2Bps: 0n,
    tier3Bps: 0n,
    tier2Threshold: 0n,
    tier3Threshold: 0n,
  };

  // 10^18 * 30 / 10000 = 3 * 10^15
  const huge = 1_000_000_000_000_000_000n;
  assertEq(
    computeDynamicTradingFee(huge, config),
    3_000_000_000_000_000n,
    "large notional: no overflow",
  );
}

// =============================================================================
// computeFeeSplit
// =============================================================================

console.log("\n--- computeFeeSplit ---");

// Standard 70/20/10 split
{
  const config: FeeSplitConfig = {
    lpBps: 7000n,
    protocolBps: 2000n,
    creatorBps: 1000n,
  };

  const [lp, protocol, creator] = computeFeeSplit(10000n, config);
  assertEq(lp, 7000n, "70/20/10: LP gets 7000");
  assertEq(protocol, 2000n, "70/20/10: protocol gets 2000");
  assertEq(creator, 1000n, "70/20/10: creator gets 1000");
  assertEq(lp + protocol + creator, 10000n, "70/20/10: total preserved");
}

// Rounding: creator absorbs remainder
{
  const config: FeeSplitConfig = {
    lpBps: 7000n,
    protocolBps: 2000n,
    creatorBps: 1000n,
  };

  const [lp, protocol, creator] = computeFeeSplit(33n, config);
  // lp = floor(33 * 7000 / 10000) = floor(23.1) = 23
  // protocol = floor(33 * 2000 / 10000) = floor(6.6) = 6
  // creator = 33 - 23 - 6 = 4
  assertEq(lp, 23n, "rounding: LP gets 23");
  assertEq(protocol, 6n, "rounding: protocol gets 6");
  assertEq(creator, 4n, "rounding: creator absorbs remainder (4)");
  assertEq(lp + protocol + creator, 33n, "rounding: total preserved");
}

// All zeros → 100% to LP (legacy behavior)
{
  const config: FeeSplitConfig = {
    lpBps: 0n,
    protocolBps: 0n,
    creatorBps: 0n,
  };

  const [lp, protocol, creator] = computeFeeSplit(5000n, config);
  assertEq(lp, 5000n, "all-zero config: 100% to LP");
  assertEq(protocol, 0n, "all-zero config: 0 to protocol");
  assertEq(creator, 0n, "all-zero config: 0 to creator");
}

// Zero fee amount
{
  const config: FeeSplitConfig = {
    lpBps: 7000n,
    protocolBps: 2000n,
    creatorBps: 1000n,
  };

  const [lp, protocol, creator] = computeFeeSplit(0n, config);
  assertEq(lp, 0n, "zero fee: LP = 0");
  assertEq(protocol, 0n, "zero fee: protocol = 0");
  assertEq(creator, 0n, "zero fee: creator = 0");
}

// 100% to protocol
{
  const config: FeeSplitConfig = {
    lpBps: 0n,
    protocolBps: 10000n,
    creatorBps: 0n,
  };

  const [lp, protocol, creator] = computeFeeSplit(999n, config);
  assertEq(lp, 0n, "100% protocol: LP = 0");
  assertEq(protocol, 999n, "100% protocol: protocol gets all");
  assertEq(creator, 0n, "100% protocol: creator = 0");
}

// 50/50 LP/protocol with odd total (rounding test)
{
  const config: FeeSplitConfig = {
    lpBps: 5000n,
    protocolBps: 5000n,
    creatorBps: 0n,
  };

  const [lp, protocol, creator] = computeFeeSplit(101n, config);
  // lp = floor(101 * 5000 / 10000) = 50
  // protocol = floor(101 * 5000 / 10000) = 50
  // creator = 101 - 50 - 50 = 1
  assertEq(lp, 50n, "50/50 odd total: LP = 50");
  assertEq(protocol, 50n, "50/50 odd total: protocol = 50");
  assertEq(creator, 1n, "50/50 odd total: creator absorbs rounding (1)");
  assertEq(lp + protocol + creator, 101n, "50/50 odd total: total preserved");
}

// Large fee amounts — no overflow
{
  const config: FeeSplitConfig = {
    lpBps: 6000n,
    protocolBps: 3000n,
    creatorBps: 1000n,
  };

  const hugeFee = 1_000_000_000_000_000n;
  const [lp, protocol, creator] = computeFeeSplit(hugeFee, config);
  assertEq(lp, 600_000_000_000_000n, "large fee: LP correct");
  assertEq(protocol, 300_000_000_000_000n, "large fee: protocol correct");
  assertEq(creator, 100_000_000_000_000n, "large fee: creator correct");
  assertEq(lp + protocol + creator, hugeFee, "large fee: total preserved");
}

// =============================================================================
// Integration: computeDynamicTradingFee → computeFeeSplit
// =============================================================================

console.log("\n--- Integration: fee → split ---");

{
  const tierConfig: FeeTierConfig = {
    baseBps: 10n,
    tier2Bps: 15n,
    tier3Bps: 20n,
    tier2Threshold: 1_000_000n,
    tier3Threshold: 10_000_000n,
  };

  const splitConfig: FeeSplitConfig = {
    lpBps: 7000n,
    protocolBps: 2000n,
    creatorBps: 1000n,
  };

  const notional = 5_000_000n; // Tier 2: 15 bps
  const fee = computeDynamicTradingFee(notional, tierConfig);
  // ceil(5_000_000 * 15 / 10_000) = ceil(7500) = 7500
  assertEq(fee, 7500n, "integration: Tier 2 fee = 7500");

  const [lp, protocol, creator] = computeFeeSplit(fee, splitConfig);
  assertEq(lp, 5250n, "integration: LP share = 5250");
  assertEq(protocol, 1500n, "integration: protocol share = 1500");
  assertEq(creator, 750n, "integration: creator share = 750");
  assertEq(lp + protocol + creator, fee, "integration: split preserves total");
}

// =============================================================================
// Summary
// =============================================================================

console.log(`\n${failed === 0 ? "✅" : "❌"} Dynamic fees: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
