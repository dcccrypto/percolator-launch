/**
 * PERC-377: Unit tests for config loading.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Inline minimal config loader for testing without @solana/web3.js
// (avoids needing full Solana stack in test env)

type BotMode = "filler" | "maker" | "both";

interface MinimalConfig {
  mode: BotMode;
  dryRun: boolean;
  healthPort: number;
  spreadBps: number;
  maxQuoteSizeUsdc: number;
  maxPositionPct: number;
  crankIntervalMs: number;
  crankBatchSize: number;
  skewMaxMultiplier: number;
  spreadNoiseBps: number;
  sizeJitter: number;
  marketsFilter: string[] | null;
  pushOraclePrices: boolean;
}

function loadMinimalConfig(): MinimalConfig {
  return {
    mode: (process.env.BOT_MODE ?? "both") as BotMode,
    dryRun: process.env.DRY_RUN === "true",
    healthPort: Number(process.env.HEALTH_PORT ?? "18820"),
    spreadBps: Number(process.env.SPREAD_BPS ?? "25"),
    maxQuoteSizeUsdc: Number(process.env.MAX_QUOTE_SIZE_USDC ?? "500"),
    maxPositionPct: Number(process.env.MAX_POSITION_PCT ?? "10"),
    crankIntervalMs: Number(process.env.CRANK_INTERVAL_MS ?? "5000"),
    crankBatchSize: Number(process.env.CRANK_BATCH_SIZE ?? "3"),
    skewMaxMultiplier: Number(process.env.SKEW_MAX_MULTIPLIER ?? "3.0"),
    spreadNoiseBps: Number(process.env.SPREAD_NOISE_BPS ?? "4"),
    sizeJitter: Number(process.env.SIZE_JITTER ?? "0.25"),
    marketsFilter: process.env.MARKETS_FILTER
      ? process.env.MARKETS_FILTER.split(",").map((s) => s.trim().toUpperCase())
      : null,
    pushOraclePrices: process.env.PUSH_ORACLE !== "false",
  };
}

describe("config loading", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "BOT_MODE", "DRY_RUN", "HEALTH_PORT", "SPREAD_BPS",
    "MAX_QUOTE_SIZE_USDC", "MAX_POSITION_PCT", "CRANK_INTERVAL_MS",
    "CRANK_BATCH_SIZE", "SKEW_MAX_MULTIPLIER", "SPREAD_NOISE_BPS",
    "SIZE_JITTER", "MARKETS_FILTER", "PUSH_ORACLE",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it("uses sensible defaults", () => {
    const config = loadMinimalConfig();

    expect(config.mode).toBe("both");
    expect(config.dryRun).toBe(false);
    expect(config.healthPort).toBe(18820);
    expect(config.spreadBps).toBe(25);
    expect(config.maxQuoteSizeUsdc).toBe(500);
    expect(config.maxPositionPct).toBe(10);
    expect(config.crankIntervalMs).toBe(5000);
    expect(config.crankBatchSize).toBe(3);
    expect(config.skewMaxMultiplier).toBe(3.0);
    expect(config.marketsFilter).toBeNull();
    expect(config.pushOraclePrices).toBe(true);
  });

  it("reads BOT_MODE from env", () => {
    process.env.BOT_MODE = "filler";
    expect(loadMinimalConfig().mode).toBe("filler");

    process.env.BOT_MODE = "maker";
    expect(loadMinimalConfig().mode).toBe("maker");
  });

  it("DRY_RUN must be exactly 'true'", () => {
    process.env.DRY_RUN = "true";
    expect(loadMinimalConfig().dryRun).toBe(true);

    process.env.DRY_RUN = "1";
    expect(loadMinimalConfig().dryRun).toBe(false);

    process.env.DRY_RUN = "yes";
    expect(loadMinimalConfig().dryRun).toBe(false);
  });

  it("parses MARKETS_FILTER as comma-separated uppercase", () => {
    process.env.MARKETS_FILTER = "sol, btc, Eth";
    const config = loadMinimalConfig();

    expect(config.marketsFilter).toEqual(["SOL", "BTC", "ETH"]);
  });

  it("PUSH_ORACLE defaults to true, disabled with 'false'", () => {
    expect(loadMinimalConfig().pushOraclePrices).toBe(true);

    process.env.PUSH_ORACLE = "false";
    expect(loadMinimalConfig().pushOraclePrices).toBe(false);

    process.env.PUSH_ORACLE = "0";
    expect(loadMinimalConfig().pushOraclePrices).toBe(true); // only 'false' disables
  });

  it("numeric env vars parse correctly", () => {
    process.env.SPREAD_BPS = "50";
    process.env.MAX_QUOTE_SIZE_USDC = "1000";
    process.env.MAX_POSITION_PCT = "20";
    process.env.CRANK_INTERVAL_MS = "10000";

    const config = loadMinimalConfig();
    expect(config.spreadBps).toBe(50);
    expect(config.maxQuoteSizeUsdc).toBe(1000);
    expect(config.maxPositionPct).toBe(20);
    expect(config.crankIntervalMs).toBe(10000);
  });
});
