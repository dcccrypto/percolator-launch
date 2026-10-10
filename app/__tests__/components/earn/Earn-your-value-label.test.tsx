/**
 * Discord: a $500 deposit later read "Your Deposit $491.72" and looked like money gone. The figure is
 * what the position is worth now, so the hub labels it "Your Value" (the vault page says "Value").
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VaultGrid } from "@/components/earn/VaultGrid";

const market = {
  slabAddress: "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn", symbol: "SOL", name: "SOL", mainnetCa: null,
  vaultBalance: 500_000_000, totalOI: 0, maxOI: 0, insuranceFund: 0, volume24h: 0, tradingFeeBps: 10,
  maxLeverage: 10, oiUtilPct: 0, decimals: 6, hasVault: true,
};

describe("Earn hub: the position figure is 'Your Value'", () => {
  it("the vault table's column reads Your Value, with what it means on hover", () => {
    render(<VaultGrid markets={[market]} loading={false} selectedSlab={null} onSelect={() => {}} userDeposits={{ [market.slabAddress]: 491.72 }} />);
    const header = screen.getByText("Your Value");
    expect(header.getAttribute("title")).toBe("What your share of the vault is worth now");
    expect(screen.queryByText("Your Deposit")).toBeNull();
  });

  it("the deposit rail's figure is labelled Your Value", () => {
    const rail = readFileSync(resolve(process.cwd(), "components/earn/VaultDepositRail.tsx"), "utf8");
    expect(rail).toContain('label="Your Value"');
    expect(rail).not.toContain('label="Your Deposit"');
  });
});
