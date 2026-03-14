import { describe, it, expect } from "vitest";
import {
  SLAB_TIERS,
  SLAB_TIERS_V0,
  SLAB_TIERS_V1D,
  slabDataSize,
  slabDataSizeV1,
  type SlabTierKey,
} from "../src/solana/discovery.js";

// ============================================================================
// SLAB_TIERS constants
// ============================================================================

describe("SLAB_TIERS", () => {
  it("has exactly 3 tiers: small, medium, large", () => {
    const tierNames = Object.keys(SLAB_TIERS);
    expect(tierNames).toEqual(["small", "medium", "large"]);
  });

  it("small tier has 256 max accounts", () => {
    expect(SLAB_TIERS.small.maxAccounts).toBe(256);
  });

  it("medium tier has 1024 max accounts", () => {
    expect(SLAB_TIERS.medium.maxAccounts).toBe(1024);
  });

  it("large tier has 4096 max accounts", () => {
    expect(SLAB_TIERS.large.maxAccounts).toBe(4096);
  });

  it("data sizes are in ascending order", () => {
    expect(SLAB_TIERS.small.dataSize).toBeLessThan(SLAB_TIERS.medium.dataSize);
    expect(SLAB_TIERS.medium.dataSize).toBeLessThan(SLAB_TIERS.large.dataSize);
  });

  it("all tiers have labels and descriptions", () => {
    for (const [key, tier] of Object.entries(SLAB_TIERS)) {
      expect(tier.label, `${key} label`).toBeTruthy();
      expect(tier.description, `${key} description`).toBeTruthy();
    }
  });

  it("tier data sizes are positive integers", () => {
    for (const tier of Object.values(SLAB_TIERS)) {
      expect(tier.dataSize).toBeGreaterThan(0);
      expect(Number.isInteger(tier.dataSize)).toBe(true);
    }
  });
});

// ============================================================================
// slabDataSize calculation
// ============================================================================

describe("slabDataSize", () => {
  // slabDataSize() computes V0 layout — compare against SLAB_TIERS_V0 (GH #1109)
  it("returns V0 data size for small tier (256 accounts)", () => {
    expect(slabDataSize(256)).toBe(SLAB_TIERS_V0.small.dataSize);
  });

  it("returns V0 data size for medium tier (1024 accounts)", () => {
    expect(slabDataSize(1024)).toBe(SLAB_TIERS_V0.medium.dataSize);
  });

  it("returns V0 data size for large tier (4096 accounts)", () => {
    expect(slabDataSize(4096)).toBe(SLAB_TIERS_V0.large.dataSize);
  });

  it("is monotonically increasing with account count", () => {
    const sizes = [64, 128, 256, 512, 1024, 2048, 4096].map(slabDataSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("returns positive result for minimum account count (1)", () => {
    expect(slabDataSize(1)).toBeGreaterThan(0);
  });

  it("data size is always 8-byte aligned (due to account alignment)", () => {
    for (const n of [64, 128, 256, 512, 1024, 2048, 4096]) {
      const size = slabDataSize(n);
      // V0 layout: ENGINE_OFF=480, ACCOUNT_SIZE=240
      expect(size).toBeGreaterThan(480 + n * 240);
      expect(size % 8).toBe(0);
    }
  });

  it("accounts for bitmap, next_free array, and padding overhead", () => {
    // V0 layout for 256 accounts:
    // ENGINE_OFF=480, ENGINE_BITMAP_OFF=320
    // bitmap = ceil(256/64) * 8 = 32 bytes
    // postBitmap = 18, nextFree = 512
    // preAccountsLen = 320 + 32 + 18 + 512 = 882
    // accountsOff = ceil(882/8)*8 = 888
    // total = 480 + 888 + 256*240 = 480 + 888 + 61440 = 62808
    expect(slabDataSize(256)).toBe(62808);
  });
});

// ============================================================================
// slabDataSizeV1 calculation — V1 layout (ENGINE_OFF=640, ACCOUNT_SIZE=248)
// Values match SLAB_TIERS (empirically verified on-chain, GH #1109)
// ============================================================================

describe("slabDataSizeV1", () => {
  it("matches V1 SLAB_TIERS.small for 256 accounts", () => {
    expect(slabDataSizeV1(256)).toBe(SLAB_TIERS.small.dataSize); // 65_352
  });

  it("matches V1 SLAB_TIERS.medium for 1024 accounts", () => {
    expect(slabDataSizeV1(1024)).toBe(SLAB_TIERS.medium.dataSize); // 257_448
  });

  it("matches SLAB_TIERS.large for 4096 accounts (GH #1112: deployed FxfD37s1 uses formula value)", () => {
    // FxfD37s1 (large, pre-PERC-118) has SLAB_LEN=1,025,832 — matches the formula exactly.
    // Previous value of 1,025,848 was sourced from wrong binary (FwfBKZXb compiled as 4096-acct).
    const formula = slabDataSizeV1(4096);
    expect(formula).toBe(1_025_832);
    expect(SLAB_TIERS.large.dataSize).toBe(1_025_832);
    expect(SLAB_TIERS.large.dataSize).toBe(formula);
  });

  it("is monotonically increasing with account count", () => {
    const sizes = [64, 128, 256, 512, 1024, 2048, 4096].map(slabDataSizeV1);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it("produces larger values than V0 slabDataSize for same account count", () => {
    for (const n of [256, 1024, 4096]) {
      expect(slabDataSizeV1(n)).toBeGreaterThan(slabDataSize(n));
    }
  });
});

// ============================================================================
// SLAB_TIERS_V1D — GH#1205: V1D tiers must be exported and present for discovery
// ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248
// ============================================================================

describe("SLAB_TIERS_V1D (GH#1205)", () => {
  it("is exported from discovery.ts", () => {
    expect(SLAB_TIERS_V1D).toBeDefined();
  });

  it("has micro, small, medium, large tiers", () => {
    expect(Object.keys(SLAB_TIERS_V1D)).toEqual(["micro", "small", "medium", "large"]);
  });

  it("micro tier: 64 accounts, dataSize=17080", () => {
    expect(SLAB_TIERS_V1D.micro.maxAccounts).toBe(64);
    expect(SLAB_TIERS_V1D.micro.dataSize).toBe(17_080);
  });

  it("small tier: 256 accounts, dataSize=65104", () => {
    expect(SLAB_TIERS_V1D.small.maxAccounts).toBe(256);
    expect(SLAB_TIERS_V1D.small.dataSize).toBe(65_104);
  });

  it("medium tier: 1024 accounts, dataSize=257200", () => {
    expect(SLAB_TIERS_V1D.medium.maxAccounts).toBe(1024);
    expect(SLAB_TIERS_V1D.medium.dataSize).toBe(257_200);
  });

  it("large tier: 4096 accounts, dataSize=1025584", () => {
    expect(SLAB_TIERS_V1D.large.maxAccounts).toBe(4096);
    expect(SLAB_TIERS_V1D.large.dataSize).toBe(1_025_584);
  });

  it("V1D sizes are distinct from V1 and V0 sizes (no collision)", () => {
    const v1Sizes = new Set(Object.values(SLAB_TIERS).map(t => t.dataSize));
    const v0Sizes = new Set(Object.values(SLAB_TIERS_V0).map(t => t.dataSize));
    for (const tier of Object.values(SLAB_TIERS_V1D)) {
      expect(v1Sizes.has(tier.dataSize), `V1D ${tier.dataSize} collides with V1`).toBe(false);
      expect(v0Sizes.has(tier.dataSize), `V1D ${tier.dataSize} collides with V0`).toBe(false);
    }
  });

  it("data sizes are in ascending order", () => {
    const sizes = Object.values(SLAB_TIERS_V1D).map(t => t.dataSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });
});
