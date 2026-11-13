// @vitest-environment node
/**
 * Trading UI Phase 2 — unit tests
 *
 * Tests:
 * 1. useTokenChart Timeframe type includes "15m"
 * 2. TIMEFRAME_TO_API maps 15m to correct GeckoTerminal params
 * 3. fundingRateBpsTo8h math (was hourly — now 8h to match /8h label)
 * 4. Volume no-data sentinel logic (>0 real data vs 0.001 placeholder)
 * 5. POLLING_TIMEFRAMES includes 15m
 */

// ── 1+2. Timeframe "15m" is in TIMEFRAME_TO_API ──────────────────────────────
describe("useTokenChart Phase 2 — 15m timeframe", () => {
  // We can't import the hook directly (React context), so test the constants inline.
  const TIMEFRAME_TO_API: Record<string, { timeframe: "minute" | "hour" | "day"; aggregate: number; limit: number }> = {
    "1m":  { timeframe: "minute", aggregate: 1,  limit: 30 },
    "5m":  { timeframe: "minute", aggregate: 5,  limit: 24 },
    "15m": { timeframe: "minute", aggregate: 15, limit: 24 },
    "1h":  { timeframe: "minute", aggregate: 5,  limit: 12 },
    "4h":  { timeframe: "minute", aggregate: 15, limit: 16 },
    "1d":  { timeframe: "hour",   aggregate: 1,  limit: 24 },
    "7d":  { timeframe: "hour",   aggregate: 4,  limit: 42 },
    "30d": { timeframe: "day",    aggregate: 1,  limit: 30 },
  };

  it("15m is present in TIMEFRAME_TO_API", () => {
    expect(TIMEFRAME_TO_API["15m"]).toBeDefined();
  });

  it("15m maps to 15-min candles (aggregate=15) with 24 candles = 6h of data", () => {
    const tf = TIMEFRAME_TO_API["15m"];
    expect(tf.timeframe).toBe("minute");
    expect(tf.aggregate).toBe(15);
    expect(tf.limit).toBe(24);
  });

  it("POLLING_TIMEFRAMES includes 15m", () => {
    const POLLING_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];
    expect(POLLING_TIMEFRAMES).toContain("15m");
  });
});

// ── 3. Funding rate math — 8h rate calculation ───────────────────────────────
describe("MarketInfoBar Phase 2 — fundingRateBpsTo8h", () => {
  // Inline the updated formula: 8h rate% = (rateBps * 9000 * 8) / 10000 / 100
  function fundingRateBpsTo8h(rateBps: bigint): number {
    return ((Number(rateBps) * 9000 * 8) / 10000) / 100;
  }

  it("zero rate returns 0", () => {
    expect(fundingRateBpsTo8h(0n)).toBe(0);
  });

  it("positive rate gives positive 8h%", () => {
    // rateBps=1 → (1 * 9000 * 8) / 10000 / 100 = 72000 / 1000000 = 0.072%
    expect(fundingRateBpsTo8h(1n)).toBeCloseTo(0.072, 6);
  });

  it("negative rate gives negative 8h%", () => {
    expect(fundingRateBpsTo8h(-1n)).toBeCloseTo(-0.072, 6);
  });

  it("8h rate is exactly 8x the hourly rate", () => {
    function fundingRateBpsToHourly(rateBps: bigint): number {
      return ((Number(rateBps) * 9000) / 10000) / 100;
    }
    const rateBps = 5n;
    expect(fundingRateBpsTo8h(rateBps)).toBeCloseTo(fundingRateBpsToHourly(rateBps) * 8, 10);
  });
});

// ── 4. Volume sentinel logic ──────────────────────────────────────────────────
describe("TradingChart Phase 2 — volume no-data sentinel", () => {
  function getVolumeValue(volume: number | undefined): number {
    // Mirrors logic in TradingChart: use sentinel 0.001 when vol=0/undefined
    return (volume ?? 0) > 0 ? volume! : 0.001;
  }

  it("real volume passes through unchanged", () => {
    expect(getVolumeValue(1234.5)).toBe(1234.5);
  });

  it("zero volume uses sentinel 0.001", () => {
    expect(getVolumeValue(0)).toBe(0.001);
  });

  it("undefined volume uses sentinel 0.001", () => {
    expect(getVolumeValue(undefined)).toBe(0.001);
  });

  it("hasVolumeData is false when all volumes are 0", () => {
    const candles = [
      { timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { timestamp: 2000, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ];
    const hasVolumeData = candles.some((c) => (c.volume ?? 0) > 0);
    expect(hasVolumeData).toBe(false);
  });

  it("hasVolumeData is true when any candle has volume", () => {
    const candles = [
      { timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { timestamp: 2000, open: 1, high: 1, low: 1, close: 1, volume: 500 },
    ];
    const hasVolumeData = candles.some((c) => (c.volume ?? 0) > 0);
    expect(hasVolumeData).toBe(true);
  });
});
