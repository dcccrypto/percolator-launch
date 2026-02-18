import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Testable oracle logic (extracted from sim-oracle.ts) ───────────────────

type ScenarioType = "crash" | "squeeze" | "blackswan" | "volatility" | "trend";

interface ScenarioConfig {
  type: ScenarioType;
  magnitude: number;
  durationMs: number;
  recoveryFactor?: number; // crash only
}

const SCENARIO_CONFIGS: Record<ScenarioType, ScenarioConfig> = {
  crash: { type: "crash", magnitude: 0.30, durationMs: 60_000, recoveryFactor: 0.70 },
  squeeze: { type: "squeeze", magnitude: 0.50, durationMs: 120_000 },
  blackswan: { type: "blackswan", magnitude: 0.60, durationMs: 600_000 },
  volatility: { type: "volatility", magnitude: 0.20, durationMs: 300_000 },
  trend: { type: "trend", magnitude: 0.15, durationMs: 1_800_000 },
};

function calcScenarioMultiplier(
  type: ScenarioType,
  elapsedMs: number,
  durationMs: number,
  rng: () => number = Math.random
): number {
  const config = SCENARIO_CONFIGS[type];
  const progress = Math.min(elapsedMs / durationMs, 1.0);

  switch (type) {
    case "crash": {
      // Drop phase: first 30% of duration = full drop
      // Recovery phase: remaining 70% = recover 70% of drop
      const dropPhase = 0.3;
      if (progress < dropPhase) {
        const dropProgress = progress / dropPhase;
        return 1 - config.magnitude * dropProgress;
      } else {
        const recoveryProgress = (progress - dropPhase) / (1 - dropPhase);
        const maxDrop = config.magnitude;
        const recovery = maxDrop * (config.recoveryFactor || 0.70);
        return (1 - maxDrop) + recovery * recoveryProgress;
      }
    }

    case "squeeze": {
      // Linear ramp up
      return 1 + config.magnitude * progress;
    }

    case "blackswan": {
      // Gradual decay
      return 1 - config.magnitude * progress;
    }

    case "volatility": {
      // Random oscillation ±magnitude
      const oscillation = (rng() * 2 - 1) * config.magnitude;
      return 1 + oscillation;
    }

    case "trend": {
      // Linear increase
      return 1 + config.magnitude * progress;
    }
  }
}

function priceToE6(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

function buildHermesUrl(feedIds: string[]): string {
  const params = feedIds.map((id) => `ids[]=${id}`).join("&");
  return `https://hermes.pyth.network/v2/updates/price/latest?${params}`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Oracle: calcScenarioMultiplier", () => {
  describe("crash scenario", () => {
    it("starts at 1.0 (no effect at t=0)", () => {
      const m = calcScenarioMultiplier("crash", 0, 60_000);
      expect(m).toBeCloseTo(1.0, 4);
    });

    it("reaches full -30% drop at 30% of duration", () => {
      const m = calcScenarioMultiplier("crash", 18_000, 60_000); // 30% of 60s
      expect(m).toBeCloseTo(0.70, 2);
    });

    it("recovers 70% of drop by end", () => {
      const m = calcScenarioMultiplier("crash", 60_000, 60_000);
      // Full drop = 0.30, recovery = 0.30 * 0.70 = 0.21
      // End = (1 - 0.30) + 0.21 = 0.91
      expect(m).toBeCloseTo(0.91, 2);
    });

    it("halfway through recovery", () => {
      // At 65% progress (halfway through recovery phase)
      const m = calcScenarioMultiplier("crash", 39_000, 60_000);
      expect(m).toBeGreaterThan(0.70);
      expect(m).toBeLessThan(0.91);
    });
  });

  describe("squeeze scenario", () => {
    it("starts at 1.0", () => {
      expect(calcScenarioMultiplier("squeeze", 0, 120_000)).toBeCloseTo(1.0);
    });

    it("reaches +50% at end", () => {
      expect(calcScenarioMultiplier("squeeze", 120_000, 120_000)).toBeCloseTo(1.50, 2);
    });

    it("halfway = +25%", () => {
      expect(calcScenarioMultiplier("squeeze", 60_000, 120_000)).toBeCloseTo(1.25, 2);
    });

    it("is strictly monotonic", () => {
      const m1 = calcScenarioMultiplier("squeeze", 30_000, 120_000);
      const m2 = calcScenarioMultiplier("squeeze", 60_000, 120_000);
      const m3 = calcScenarioMultiplier("squeeze", 90_000, 120_000);
      expect(m2).toBeGreaterThan(m1);
      expect(m3).toBeGreaterThan(m2);
    });
  });

  describe("blackswan scenario", () => {
    it("starts at 1.0", () => {
      expect(calcScenarioMultiplier("blackswan", 0, 600_000)).toBeCloseTo(1.0);
    });

    it("reaches -60% at end", () => {
      expect(calcScenarioMultiplier("blackswan", 600_000, 600_000)).toBeCloseTo(0.40, 2);
    });

    it("halfway = -30%", () => {
      expect(calcScenarioMultiplier("blackswan", 300_000, 600_000)).toBeCloseTo(0.70, 2);
    });

    it("is strictly decreasing", () => {
      const m1 = calcScenarioMultiplier("blackswan", 100_000, 600_000);
      const m2 = calcScenarioMultiplier("blackswan", 300_000, 600_000);
      const m3 = calcScenarioMultiplier("blackswan", 500_000, 600_000);
      expect(m2).toBeLessThan(m1);
      expect(m3).toBeLessThan(m2);
    });
  });

  describe("volatility scenario", () => {
    it("stays within ±20% bounds", () => {
      for (let i = 0; i < 100; i++) {
        const m = calcScenarioMultiplier("volatility", 150_000, 300_000);
        expect(m).toBeGreaterThanOrEqual(0.80);
        expect(m).toBeLessThanOrEqual(1.20);
      }
    });

    it("uses provided RNG", () => {
      // RNG returns 0.5 → oscillation = (0.5*2-1)*0.2 = 0 → multiplier = 1.0
      const m = calcScenarioMultiplier("volatility", 150_000, 300_000, () => 0.5);
      expect(m).toBeCloseTo(1.0, 4);
    });

    it("max with RNG=1.0", () => {
      const m = calcScenarioMultiplier("volatility", 150_000, 300_000, () => 1.0);
      expect(m).toBeCloseTo(1.20, 4);
    });

    it("min with RNG=0.0", () => {
      const m = calcScenarioMultiplier("volatility", 150_000, 300_000, () => 0.0);
      expect(m).toBeCloseTo(0.80, 4);
    });
  });

  describe("trend scenario", () => {
    it("starts at 1.0", () => {
      expect(calcScenarioMultiplier("trend", 0, 1_800_000)).toBeCloseTo(1.0);
    });

    it("reaches +15% at end", () => {
      expect(calcScenarioMultiplier("trend", 1_800_000, 1_800_000)).toBeCloseTo(1.15, 2);
    });

    it("halfway = +7.5%", () => {
      expect(calcScenarioMultiplier("trend", 900_000, 1_800_000)).toBeCloseTo(1.075, 2);
    });

    it("is strictly monotonic", () => {
      const vals = [0, 300_000, 600_000, 900_000, 1_200_000, 1_500_000, 1_800_000].map(
        (t) => calcScenarioMultiplier("trend", t, 1_800_000)
      );
      for (let i = 1; i < vals.length; i++) {
        expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
      }
    });
  });

  describe("edge cases", () => {
    it("clamps progress at 1.0 when elapsed > duration", () => {
      // Squeeze beyond duration should still be 1.5
      const m = calcScenarioMultiplier("squeeze", 200_000, 120_000);
      expect(m).toBeCloseTo(1.50, 2);
    });

    it("handles zero elapsed", () => {
      for (const type of ["crash", "squeeze", "blackswan", "trend"] as ScenarioType[]) {
        const m = calcScenarioMultiplier(type, 0, 60_000);
        expect(m).toBeCloseTo(1.0, 2);
      }
    });
  });
});

describe("Oracle: priceToE6", () => {
  it("converts whole number", () => {
    expect(priceToE6(100)).toBe(100_000_000n);
  });

  it("converts decimal", () => {
    expect(priceToE6(150.25)).toBe(150_250_000n);
  });

  it("converts small price", () => {
    expect(priceToE6(0.001)).toBe(1_000n);
  });

  it("rounds to nearest integer", () => {
    expect(priceToE6(100.0000005)).toBe(100_000_001n);
  });

  it("handles zero", () => {
    expect(priceToE6(0)).toBe(0n);
  });

  it("handles BTC-scale price", () => {
    expect(priceToE6(95000.50)).toBe(95_000_500_000n);
  });
});

describe("Oracle: buildHermesUrl", () => {
  it("builds URL with single feed", () => {
    const url = buildHermesUrl(["abc123"]);
    expect(url).toBe("https://hermes.pyth.network/v2/updates/price/latest?ids[]=abc123");
  });

  it("builds URL with multiple feeds", () => {
    const url = buildHermesUrl(["feed1", "feed2", "feed3"]);
    expect(url).toContain("ids[]=feed1");
    expect(url).toContain("ids[]=feed2");
    expect(url).toContain("ids[]=feed3");
  });

  it("returns base URL with no feeds", () => {
    const url = buildHermesUrl([]);
    expect(url).toBe("https://hermes.pyth.network/v2/updates/price/latest?");
  });
});
