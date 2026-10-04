import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/earn/OiCapMeter", () => ({ OiCapMeter: () => null }));

import { VaultRow } from "@/components/earn/VaultRow";
import type { MarketVaultInfo } from "@/hooks/useEarnStats";

const base: MarketVaultInfo = {
  slabAddress: "S", symbol: "OTC", name: "OTC", mainnetCa: null, vaultBalance: 9_564_523, totalOI: 0, maxOI: 0,
  insuranceFund: 0, volume24h: 0, tradingFeeBps: 5, maxLeverage: 10, oiUtilPct: 0, decimals: 6,
};
const row = (v: Partial<MarketVaultInfo>) => render(<VaultRow vault={{ ...base, ...v }} selected={false} userDepositUsd={null} onSelect={() => undefined} />);

describe("Earn vault row: withdraw flags", () => {
  it("a vault that cannot pay out now carries a plain chip and a tooltip with the three numbers", () => {
    row({ earnWithdraw: { claimAdjustedNavUsd: 0, maxWithdrawableNowUsd: 0, status: "blocked", blockedBy: "claims" } });
    const chip = screen.getByTestId("vault-withdraw-chip");
    expect(chip.textContent).toBe("Can't withdraw now");
    expect(chip.getAttribute("data-status")).toBe("blocked");
    expect(chip.getAttribute("title")).toMatch(/unavailable now/);
    const tvl = screen.getByText("$9.56");
    expect(tvl.getAttribute("title")).toBe(
      "Vault value $9.56. After open winner claims $0.00. Withdrawable now $0.00. Withdrawals unavailable now: the vault's money is backing open winners. Paid out after the redemption cooldown.",
    );
  });

  it("a worthless vault reads 'Worth ~0'", () => {
    row({ vaultBalance: 1, earnWithdraw: { claimAdjustedNavUsd: 0, maxWithdrawableNowUsd: 0, status: "worthless", blockedBy: null } });
    expect(screen.getByTestId("vault-withdraw-chip").textContent).toBe("Worth ~0");
  });

  it("NEGATIVE CONTROL: an open vault shows no chip, only the numbers in the tooltip", () => {
    row({ vaultBalance: 2_000_000_000, earnWithdraw: { claimAdjustedNavUsd: 2000, maxWithdrawableNowUsd: 2000, status: "open", blockedBy: null } });
    expect(screen.queryByTestId("vault-withdraw-chip")).toBeNull();
  });

  it("NEGATIVE CONTROL: a bound / unreadable vault (no view) shows no chip and no tooltip", () => {
    row({});
    expect(screen.queryByTestId("vault-withdraw-chip")).toBeNull();
  });
});
