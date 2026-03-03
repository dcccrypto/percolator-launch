/**
 * PERC-372: Verify all MM fleet profiles quote within 1% of oracle
 *
 * All profiles must have spreadBps ≤ 100 (1.00%) to meet the PERC-372
 * requirement of "seed orderbook within 1% of oracle."
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROFILES,
  PROFILE_WIDE,
  PROFILE_TIGHT_A,
  PROFILE_TIGHT_B,
  calculateProfileQuotes,
} from "../../scripts/mm-profiles.js";

const MAX_SPREAD_BPS = 100; // 1.00% — hard requirement from PERC-372

describe("PERC-372: MM profile spreads within 1% of oracle", () => {
  it("WIDE spreadBps should be ≤ 100", () => {
    expect(PROFILE_WIDE.spreadBps).toBeLessThanOrEqual(MAX_SPREAD_BPS);
    expect(PROFILE_WIDE.spreadBps).toBe(40); // PERC-372 default
  });

  it("TIGHT_A spreadBps should be ≤ 100", () => {
    expect(PROFILE_TIGHT_A.spreadBps).toBeLessThanOrEqual(MAX_SPREAD_BPS);
    expect(PROFILE_TIGHT_A.spreadBps).toBe(12); // PERC-372 default
  });

  it("TIGHT_B spreadBps should be ≤ 100", () => {
    expect(PROFILE_TIGHT_B.spreadBps).toBeLessThanOrEqual(MAX_SPREAD_BPS);
    expect(PROFILE_TIGHT_B.spreadBps).toBe(18); // PERC-372 default
  });

  it("all DEFAULT_PROFILES should be within 1%", () => {
    for (const profile of DEFAULT_PROFILES) {
      expect(profile.spreadBps).toBeLessThanOrEqual(MAX_SPREAD_BPS);
    }
  });

  it("calculateProfileQuotes should produce bid/ask within 1% of oracle for flat position", () => {
    const oraclePrice = 100.0;
    const collateral = 10_000_000_000n; // $10K

    for (const profile of DEFAULT_PROFILES) {
      const quotes = calculateProfileQuotes(profile, oraclePrice, 0n, collateral);
      // Bid should be within 1% below oracle
      expect(quotes.bidPrice).toBeGreaterThan(oraclePrice * 0.99);
      // Ask should be within 1% above oracle
      expect(quotes.askPrice).toBeLessThan(oraclePrice * 1.01);
    }
  });

  it("even with max noise, effective spread stays within 1%", () => {
    const oraclePrice = 50000.0; // BTC-like price
    const collateral = 25_000_000_000n;

    // Run multiple iterations to account for random noise
    for (let i = 0; i < 100; i++) {
      for (const profile of DEFAULT_PROFILES) {
        const quotes = calculateProfileQuotes(profile, oraclePrice, 0n, collateral);
        const bidPct = (oraclePrice - quotes.bidPrice) / oraclePrice * 100;
        const askPct = (quotes.askPrice - oraclePrice) / oraclePrice * 100;

        expect(bidPct).toBeLessThan(1.0);
        expect(askPct).toBeLessThan(1.0);
      }
    }
  });
});
