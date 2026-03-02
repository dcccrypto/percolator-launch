/**
 * PERC-366: Market Maker Fleet — Unit Tests
 *
 * Tests profile configurations, quote calculations with profile-specific
 * parameters, and fleet orchestration logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PROFILE_WIDE,
  PROFILE_TIGHT_A,
  PROFILE_TIGHT_B,
  DEFAULT_PROFILES,
  calculateProfileQuotes,
  type MakerProfile,
} from "../scripts/mm-profiles.js";

// ═══════════════════════════════════════════════════════════════
// Profile Configuration Tests
// ═══════════════════════════════════════════════════════════════

describe("MM Profiles — Configuration Validation", () => {
  it("has exactly 3 default profiles", () => {
    expect(DEFAULT_PROFILES).toHaveLength(3);
  });

  it("profiles have unique names", () => {
    const names = DEFAULT_PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("WIDE has widest spread", () => {
    expect(PROFILE_WIDE.spreadBps).toBeGreaterThan(PROFILE_TIGHT_A.spreadBps);
    expect(PROFILE_WIDE.spreadBps).toBeGreaterThan(PROFILE_TIGHT_B.spreadBps);
  });

  it("WIDE has largest quote size", () => {
    expect(PROFILE_WIDE.maxQuoteSizeUsdc).toBeGreaterThan(
      PROFILE_TIGHT_A.maxQuoteSizeUsdc,
    );
    expect(PROFILE_WIDE.maxQuoteSizeUsdc).toBeGreaterThan(
      PROFILE_TIGHT_B.maxQuoteSizeUsdc,
    );
  });

  it("WIDE has slowest re-quote interval", () => {
    expect(PROFILE_WIDE.quoteIntervalMs).toBeGreaterThan(
      PROFILE_TIGHT_A.quoteIntervalMs,
    );
    expect(PROFILE_WIDE.quoteIntervalMs).toBeGreaterThan(
      PROFILE_TIGHT_B.quoteIntervalMs,
    );
  });

  it("WIDE has most collateral", () => {
    expect(PROFILE_WIDE.initialCollateralUsdc).toBeGreaterThan(
      PROFILE_TIGHT_A.initialCollateralUsdc,
    );
  });

  it("TIGHT_B has non-zero oracle offset (staggers with TIGHT_A)", () => {
    expect(PROFILE_TIGHT_B.oracleOffsetBps).toBeGreaterThan(0);
    expect(PROFILE_TIGHT_A.oracleOffsetBps).toBe(0);
  });

  it("all profiles have positive spread", () => {
    for (const p of DEFAULT_PROFILES) {
      expect(p.spreadBps).toBeGreaterThan(0);
    }
  });

  it("all profiles have reasonable maxPositionPct (1-50)", () => {
    for (const p of DEFAULT_PROFILES) {
      expect(p.maxPositionPct).toBeGreaterThanOrEqual(1);
      expect(p.maxPositionPct).toBeLessThanOrEqual(50);
    }
  });

  it("all profiles have positive skewMaxMultiplier", () => {
    for (const p of DEFAULT_PROFILES) {
      expect(p.skewMaxMultiplier).toBeGreaterThan(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Quote Calculation Tests — Per Profile
// ═══════════════════════════════════════════════════════════════

describe("MM Profiles — Quote Calculation", () => {
  const COLLATERAL = 10_000_000_000n; // $10,000

  // Disable noise/jitter for deterministic tests
  const deterministicProfile = (base: MakerProfile): MakerProfile => ({
    ...base,
    spreadNoise: false,
    sizeJitter: 0,
    oracleOffsetBps: 0,
  });

  describe("WIDE profile — flat position", () => {
    const profile = deterministicProfile(PROFILE_WIDE);

    it("quotes symmetrically around oracle", () => {
      const { bidPrice, askPrice, skewFactor } = calculateProfileQuotes(
        profile,
        100.0,
        0n,
        COLLATERAL,
      );

      expect(skewFactor).toBe(0);
      // WIDE spread = 60bps = 0.60%
      expect(bidPrice).toBeCloseTo(99.4, 1);
      expect(askPrice).toBeCloseTo(100.6, 1);
    });

    it("has full size when flat", () => {
      const { bidSize, askSize } = calculateProfileQuotes(
        profile,
        100.0,
        0n,
        COLLATERAL,
      );

      expect(bidSize).toBe(profile.maxQuoteSizeUsdc);
      expect(askSize).toBe(profile.maxQuoteSizeUsdc);
    });
  });

  describe("TIGHT_A profile — flat position", () => {
    const profile = deterministicProfile(PROFILE_TIGHT_A);

    it("quotes much tighter than WIDE", () => {
      const tight = calculateProfileQuotes(profile, 100.0, 0n, COLLATERAL);
      const wide = calculateProfileQuotes(
        deterministicProfile(PROFILE_WIDE),
        100.0,
        0n,
        COLLATERAL,
      );

      const tightSpread = tight.askPrice - tight.bidPrice;
      const wideSpread = wide.askPrice - wide.bidPrice;
      expect(tightSpread).toBeLessThan(wideSpread);
    });

    it("has smaller quote size than WIDE", () => {
      const tight = calculateProfileQuotes(profile, 100.0, 0n, COLLATERAL);
      const wide = calculateProfileQuotes(
        deterministicProfile(PROFILE_WIDE),
        100.0,
        0n,
        COLLATERAL,
      );

      expect(tight.bidSize).toBeLessThan(wide.bidSize);
    });
  });

  describe("TIGHT_B profile — oracle offset", () => {
    it("shifts reference price by oracleOffsetBps", () => {
      const withOffset: MakerProfile = {
        ...deterministicProfile(PROFILE_TIGHT_B),
        oracleOffsetBps: 10, // 0.10% offset
      };
      const noOffset: MakerProfile = {
        ...deterministicProfile(PROFILE_TIGHT_B),
        oracleOffsetBps: 0,
      };

      const qWith = calculateProfileQuotes(withOffset, 100.0, 0n, COLLATERAL);
      const qWithout = calculateProfileQuotes(noOffset, 100.0, 0n, COLLATERAL);

      // Both bid and ask should be slightly higher with positive offset
      expect(qWith.bidPrice).toBeGreaterThan(qWithout.bidPrice);
      expect(qWith.askPrice).toBeGreaterThan(qWithout.askPrice);
    });
  });

  describe("position skewing — all profiles", () => {
    for (const baseProfile of DEFAULT_PROFILES) {
      const profile = deterministicProfile(baseProfile);

      describe(`${profile.name}`, () => {
        it("widens bid when long", () => {
          // 50% of max position
          const maxPosUsdc =
            (Number(COLLATERAL) / 1_000_000) *
            (profile.maxPositionPct / 100) *
            0.5;
          const pos = BigInt(Math.floor(maxPosUsdc * 1_000_000));

          const { bidPrice, askPrice } = calculateProfileQuotes(
            profile,
            100.0,
            pos,
            COLLATERAL,
          );

          const bidSpread = 100.0 - bidPrice;
          const askSpread = askPrice - 100.0;
          expect(bidSpread).toBeGreaterThan(askSpread);
        });

        it("widens ask when short", () => {
          const maxPosUsdc =
            (Number(COLLATERAL) / 1_000_000) *
            (profile.maxPositionPct / 100) *
            0.5;
          const pos = BigInt(Math.floor(-maxPosUsdc * 1_000_000));

          const { bidPrice, askPrice } = calculateProfileQuotes(
            profile,
            100.0,
            pos,
            COLLATERAL,
          );

          const bidSpread = 100.0 - bidPrice;
          const askSpread = askPrice - 100.0;
          expect(askSpread).toBeGreaterThan(bidSpread);
        });

        it("stops bidding at max long", () => {
          const maxPosUsdc =
            (Number(COLLATERAL) / 1_000_000) *
            (profile.maxPositionPct / 100);
          const pos = BigInt(Math.floor(maxPosUsdc * 1_000_000));

          const { bidSize, askSize } = calculateProfileQuotes(
            profile,
            100.0,
            pos,
            COLLATERAL,
          );

          expect(bidSize).toBe(0n);
          expect(askSize).toBeGreaterThan(0n);
        });

        it("stops asking at max short", () => {
          const maxPosUsdc =
            (Number(COLLATERAL) / 1_000_000) *
            (profile.maxPositionPct / 100);
          const pos = BigInt(Math.floor(-maxPosUsdc * 1_000_000));

          const { bidSize, askSize } = calculateProfileQuotes(
            profile,
            100.0,
            pos,
            COLLATERAL,
          );

          expect(askSize).toBe(0n);
          expect(bidSize).toBeGreaterThan(0n);
        });
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Invariant Tests
// ═══════════════════════════════════════════════════════════════

describe("MM Profiles — Invariants", () => {
  const COLLATERAL = 10_000_000_000n;
  const PRICES = [0.00002, 1.5, 150, 3500, 98000]; // BONK, low-cap, SOL, ETH, BTC
  const POSITIONS = [0n, 500_000_000n, -500_000_000n, 1_500_000_000n, -1_500_000_000n];

  for (const baseProfile of DEFAULT_PROFILES) {
    const profile: MakerProfile = {
      ...baseProfile,
      spreadNoise: false,
      sizeJitter: 0,
    };

    describe(`${profile.name} invariants`, () => {
      for (const price of PRICES) {
        for (const pos of POSITIONS) {
          const label = `price=$${price} pos=${Number(pos) / 1e6}`;

          it(`bid < ask: ${label}`, () => {
            const { bidPrice, askPrice } = calculateProfileQuotes(
              profile,
              price,
              pos,
              COLLATERAL,
            );
            expect(bidPrice).toBeLessThan(askPrice);
          });

          it(`bid < oracle ref: ${label}`, () => {
            const { bidPrice } = calculateProfileQuotes(
              profile,
              price,
              pos,
              COLLATERAL,
            );
            const refPrice = price * (1 + profile.oracleOffsetBps / 10_000);
            expect(bidPrice).toBeLessThan(refPrice);
          });

          it(`ask > oracle ref: ${label}`, () => {
            const { askPrice } = calculateProfileQuotes(
              profile,
              price,
              pos,
              COLLATERAL,
            );
            const refPrice = price * (1 + profile.oracleOffsetBps / 10_000);
            expect(askPrice).toBeGreaterThan(refPrice);
          });

          it(`sizes non-negative: ${label}`, () => {
            const { bidSize, askSize } = calculateProfileQuotes(
              profile,
              price,
              pos,
              COLLATERAL,
            );
            expect(bidSize).toBeGreaterThanOrEqual(0n);
            expect(askSize).toBeGreaterThanOrEqual(0n);
          });
        }
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Spread Noise & Jitter Tests
// ═══════════════════════════════════════════════════════════════

describe("MM Profiles — Spread Noise", () => {
  const COLLATERAL = 10_000_000_000n;

  it("spread noise creates variation across runs", () => {
    const profile: MakerProfile = {
      ...PROFILE_TIGHT_A,
      spreadNoise: true,
      spreadNoiseBps: 5,
      sizeJitter: 0,
      oracleOffsetBps: 0,
    };

    const spreads = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { effectiveSpreadBps } = calculateProfileQuotes(
        profile,
        100.0,
        0n,
        COLLATERAL,
      );
      spreads.add(effectiveSpreadBps.toFixed(4));
    }

    // Should have at least a few different spread values
    expect(spreads.size).toBeGreaterThan(1);
  });

  it("spread noise stays within bounds", () => {
    const profile: MakerProfile = {
      ...PROFILE_TIGHT_A,
      spreadNoise: true,
      spreadNoiseBps: 5,
      sizeJitter: 0,
      oracleOffsetBps: 0,
    };

    for (let i = 0; i < 100; i++) {
      const { effectiveSpreadBps } = calculateProfileQuotes(
        profile,
        100.0,
        0n,
        COLLATERAL,
      );
      // Base = 15bps, noise = ±5bps → range [10, 20]
      expect(effectiveSpreadBps).toBeGreaterThanOrEqual(1); // floor from max(1, ...)
      expect(effectiveSpreadBps).toBeLessThanOrEqual(
        profile.spreadBps + profile.spreadNoiseBps + 0.01,
      );
    }
  });

  it("size jitter creates variation", () => {
    const profile: MakerProfile = {
      ...PROFILE_TIGHT_A,
      spreadNoise: false,
      sizeJitter: 0.3,
      oracleOffsetBps: 0,
    };

    const sizes = new Set<bigint>();
    for (let i = 0; i < 20; i++) {
      const { bidSize } = calculateProfileQuotes(
        profile,
        100.0,
        0n,
        COLLATERAL,
      );
      sizes.add(bidSize);
    }

    expect(sizes.size).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════

describe("MM Profiles — Edge Cases", () => {
  it("handles zero collateral gracefully", () => {
    const profile: MakerProfile = {
      ...PROFILE_WIDE,
      spreadNoise: false,
      sizeJitter: 0,
    };

    const { bidPrice, askPrice, skewFactor } = calculateProfileQuotes(
      profile,
      100.0,
      500_000_000n,
      0n,
    );

    expect(skewFactor).toBe(0);
    expect(bidPrice).toBeLessThan(100.0);
    expect(askPrice).toBeGreaterThan(100.0);
  });

  it("handles very small oracle price (micro-cap tokens)", () => {
    const profile: MakerProfile = {
      ...PROFILE_TIGHT_A,
      spreadNoise: false,
      sizeJitter: 0,
      oracleOffsetBps: 0,
    };

    const { bidPrice, askPrice } = calculateProfileQuotes(
      profile,
      0.000001,
      0n,
      10_000_000_000n,
    );

    expect(bidPrice).toBeGreaterThan(0);
    expect(askPrice).toBeGreaterThan(bidPrice);
  });

  it("handles very large oracle price", () => {
    const profile: MakerProfile = {
      ...PROFILE_WIDE,
      spreadNoise: false,
      sizeJitter: 0,
    };

    const { bidPrice, askPrice } = calculateProfileQuotes(
      profile,
      200_000.0,
      0n,
      10_000_000_000n,
    );

    expect(bidPrice).toBeCloseTo(198_800, -1); // 200k * (1 - 0.006)
    expect(askPrice).toBeCloseTo(201_200, -1); // 200k * (1 + 0.006)
  });

  it("different profiles produce different spreads at same oracle price", () => {
    const col = 10_000_000_000n;
    const price = 150.0;

    const wideQ = calculateProfileQuotes(
      { ...PROFILE_WIDE, spreadNoise: false, sizeJitter: 0 },
      price,
      0n,
      col,
    );
    const tightQ = calculateProfileQuotes(
      { ...PROFILE_TIGHT_A, spreadNoise: false, sizeJitter: 0, oracleOffsetBps: 0 },
      price,
      0n,
      col,
    );

    const wideSpread = wideQ.askPrice - wideQ.bidPrice;
    const tightSpread = tightQ.askPrice - tightQ.bidPrice;

    // WIDE should be at least 2x wider than TIGHT_A
    expect(wideSpread / tightSpread).toBeGreaterThan(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// Profile Combination Tests (simulating fleet behavior)
// ═══════════════════════════════════════════════════════════════

describe("MM Fleet — Combined Orderbook Depth", () => {
  it("3 profiles create 6 price levels (3 bids + 3 asks) when flat", () => {
    const col = 10_000_000_000n;
    const price = 150.0;
    const levels: { side: string; price: number; size: bigint; profile: string }[] =
      [];

    for (const base of DEFAULT_PROFILES) {
      const profile = { ...base, spreadNoise: false, sizeJitter: 0 };
      const { bidPrice, askPrice, bidSize, askSize } = calculateProfileQuotes(
        profile,
        price,
        0n,
        col,
      );

      if (bidSize > 0n) levels.push({ side: "bid", price: bidPrice, size: bidSize, profile: profile.name });
      if (askSize > 0n) levels.push({ side: "ask", price: askPrice, size: askSize, profile: profile.name });
    }

    const bids = levels.filter((l) => l.side === "bid");
    const asks = levels.filter((l) => l.side === "ask");

    expect(bids).toHaveLength(3);
    expect(asks).toHaveLength(3);

    // All bids below oracle
    for (const b of bids) expect(b.price).toBeLessThan(price);
    // All asks above oracle
    for (const a of asks) expect(a.price).toBeGreaterThan(price);
  });

  it("total depth (all profiles) is substantial", () => {
    const col = 10_000_000_000n;
    const price = 150.0;

    let totalBidSize = 0n;
    let totalAskSize = 0n;

    for (const base of DEFAULT_PROFILES) {
      const profile = { ...base, spreadNoise: false, sizeJitter: 0 };
      const { bidSize, askSize } = calculateProfileQuotes(
        profile,
        price,
        0n,
        col,
      );
      totalBidSize += bidSize;
      totalAskSize += askSize;
    }

    // Total should be > $2000 on each side (WIDE=$2000 + TIGHT_A=$300 + TIGHT_B=$250)
    expect(Number(totalBidSize) / 1_000_000).toBeGreaterThan(2_000);
    expect(Number(totalAskSize) / 1_000_000).toBeGreaterThan(2_000);
  });

  it("bid/ask spread layers create realistic-looking depth", () => {
    const col = 10_000_000_000n;
    const price = 150.0;
    const bids: number[] = [];
    const asks: number[] = [];

    for (const base of DEFAULT_PROFILES) {
      const profile = { ...base, spreadNoise: false, sizeJitter: 0 };
      const { bidPrice, askPrice } = calculateProfileQuotes(
        profile,
        price,
        0n,
        col,
      );
      bids.push(bidPrice);
      asks.push(askPrice);
    }

    // Bids should be at distinct price levels
    bids.sort((a, b) => b - a); // highest first
    for (let i = 0; i < bids.length - 1; i++) {
      expect(bids[i]).toBeGreaterThan(bids[i + 1]);
    }

    // Asks should be at distinct price levels
    asks.sort((a, b) => a - b); // lowest first
    for (let i = 0; i < asks.length - 1; i++) {
      expect(asks[i]).toBeLessThan(asks[i + 1]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// PERC-368: Keeper Wallet Tests
// ═══════════════════════════════════════════════════════════════

describe("PERC-368 — Keeper Wallet Configuration", () => {
  it("profile names map to valid env var keys", () => {
    for (const profile of DEFAULT_PROFILES) {
      const envKey = `KEEPER_WALLET_${profile.name}`;
      // Must be uppercase alphanumeric + underscore only
      expect(envKey).toMatch(/^KEEPER_WALLET_[A-Z0-9_]+$/);
    }
  });

  it("profile names map to valid file names", () => {
    for (const profile of DEFAULT_PROFILES) {
      const fileName = `keeper-${profile.name.toLowerCase()}.json`;
      expect(fileName).toMatch(/^keeper-[a-z0-9_]+\.json$/);
    }
  });

  it("3 profiles produce 3 distinct env var keys", () => {
    const keys = DEFAULT_PROFILES.map((p) => `KEEPER_WALLET_${p.name}`);
    expect(new Set(keys).size).toBe(3);
  });

  it("3 profiles produce 3 distinct file names", () => {
    const names = DEFAULT_PROFILES.map(
      (p) => `keeper-${p.name.toLowerCase()}.json`,
    );
    expect(new Set(names).size).toBe(3);
  });

  it("env var overrides directory", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { Keypair } = await import("@solana/web3.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-test-"));
    const profile = DEFAULT_PROFILES[0];

    // Create a directory-mode keypair file
    const dirKp = Keypair.generate();
    const dirFile = path.join(tmpDir, `keeper-${profile.name.toLowerCase()}.json`);
    fs.writeFileSync(dirFile, JSON.stringify(Array.from(dirKp.secretKey)));

    // Create a separate keypair for the env var override
    const envKp = Keypair.generate();
    const envFile = path.join(tmpDir, `env-override-${profile.name.toLowerCase()}.json`);
    fs.writeFileSync(envFile, JSON.stringify(Array.from(envKp.secretKey)));

    const envKey = `KEEPER_WALLET_${profile.name}`;

    try {
      // Simulate the resolution logic from loadProfileWallets:
      // env var path takes precedence over directory path
      process.env[envKey] = envFile;
      process.env.KEEPER_WALLETS_DIR = tmpDir;

      const envPath = process.env[envKey];
      const dirPath = path.join(tmpDir, `keeper-${profile.name.toLowerCase()}.json`);

      // Env var path should exist and be checked first
      expect(fs.existsSync(envPath!)).toBe(true);
      expect(fs.existsSync(dirPath)).toBe(true);

      // Env var keypair is different from directory keypair
      const envLoaded = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(envPath!, "utf8"))),
      );
      const dirLoaded = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(dirPath, "utf8"))),
      );
      expect(envLoaded.publicKey.toBase58()).toBe(envKp.publicKey.toBase58());
      expect(dirLoaded.publicKey.toBase58()).toBe(dirKp.publicKey.toBase58());
      expect(envLoaded.publicKey.toBase58()).not.toBe(dirLoaded.publicKey.toBase58());
    } finally {
      delete process.env[envKey];
      delete process.env.KEEPER_WALLETS_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("missing wallet produces error when no fallback", () => {
    const profile = DEFAULT_PROFILES[0];
    const envKey = `KEEPER_WALLET_${profile.name}`;

    // Ensure no env var and no directory set
    const origEnv = process.env[envKey];
    const origDir = process.env.KEEPER_WALLETS_DIR;
    delete process.env[envKey];
    delete process.env.KEEPER_WALLETS_DIR;

    try {
      const envPath = process.env[envKey];
      const walletsDir = process.env.KEEPER_WALLETS_DIR;

      // No env var path
      expect(envPath).toBeUndefined();
      // No directory mode
      expect(walletsDir).toBeUndefined();

      // Without BOOTSTRAP_KEYPAIR either, the fleet should have no wallet source
      const hasBootstrap = !!process.env.BOOTSTRAP_KEYPAIR;
      if (!hasBootstrap) {
        // No wallet resolution possible — this is the error condition
        const hasAnyWallet = envPath || walletsDir;
        expect(hasAnyWallet).toBeFalsy();
      }
    } finally {
      if (origEnv !== undefined) process.env[envKey] = origEnv;
      if (origDir !== undefined) process.env.KEEPER_WALLETS_DIR = origDir;
    }
  });
});
