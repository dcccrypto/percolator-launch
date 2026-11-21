import { afterEach, describe, expect, it, vi } from "vitest";
import { isPortfolioPnlHistoryEnabled } from "@/lib/portfolio-pnl-history-flag";

const FLAG = "NEXT_PUBLIC_ENABLE_PORTFOLIO_PNL_HISTORY";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Portfolio PnL History feature flag", () => {
  it("defaults to disabled when unset", () => {
    vi.stubEnv(FLAG, undefined);
    expect(isPortfolioPnlHistoryEnabled()).toBe(false);
  });

  it("remains disabled for non-opt-in values", () => {
    for (const value of ["", "0", "false", "true"]) {
      vi.stubEnv(FLAG, value);
      expect(isPortfolioPnlHistoryEnabled()).toBe(false);
    }
  });

  it("enables only with explicit opt-in", () => {
    vi.stubEnv(FLAG, "1");
    expect(isPortfolioPnlHistoryEnabled()).toBe(true);
  });
});
