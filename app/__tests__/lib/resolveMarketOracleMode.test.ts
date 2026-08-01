import { describe, expect, it } from "vitest";
import {
  resolveMarketOracleMode,
  type MarketOracleMode,
} from "../../lib/resolveMarketOracleMode";

describe("resolveMarketOracleMode", () => {
  it("preserves Hyperp mode on mainnet when mainnetCA is present", () => {
    expect(
      resolveMarketOracleMode({
        requestedMode: "hyperp",
        network: "mainnet",
        hasMainnetCA: true,
      }),
    ).toBe("hyperp");
  });

  it("falls back from Hyperp to Admin for a devnet mirror", () => {
    expect(
      resolveMarketOracleMode({
        requestedMode: "hyperp",
        network: "devnet",
        hasMainnetCA: true,
      }),
    ).toBe("admin");
  });

  it("preserves Hyperp mode on devnet when mainnetCA is absent", () => {
    expect(
      resolveMarketOracleMode({
        requestedMode: "hyperp",
        network: "devnet",
        hasMainnetCA: false,
      }),
    ).toBe("hyperp");
  });

  it.each<MarketOracleMode>([
    "pyth",
    "admin",
    "keeper",
  ])("does not alter %s mode", (requestedMode) => {
    expect(
      resolveMarketOracleMode({
        requestedMode,
        network: "mainnet",
        hasMainnetCA: true,
      }),
    ).toBe(requestedMode);
  });
});
