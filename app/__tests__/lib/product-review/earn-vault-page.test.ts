/** Product review 2026-10-28 (E-4 / E-6): settled markets block Earn deposits up front; the vault page carries the loss line. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EARN_LOSS_LINE, EARN_SETTLED_DEPOSIT_BLOCK, earnMarketSettled, earnPageDepositBlock, earnVaultStatusLabel } from "@/lib/earn-vault-page";

const src = (rel: string) => readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");

describe("earn vault page", () => {
  it("settled = health lock reason 'resolved'; unknown health is not settled", () => {
    expect(earnMarketSettled({ lockReasons: ["resolved"] })).toBe(true);
    expect(earnMarketSettled({ lockReasons: [] })).toBe(false);
    expect(earnMarketSettled(null)).toBe(false);
  });
  it("a settled market blocks deposits with its own line; otherwise the vault's reason passes through", () => {
    expect(earnPageDepositBlock({ lockReasons: ["resolved"] }, null)).toBe(EARN_SETTLED_DEPOSIT_BLOCK);
    expect(earnPageDepositBlock({ lockReasons: [] }, null)).toBeNull();
    expect(earnPageDepositBlock(null, "paused")).toBe("paused");
  });
  it("status reads Settled, not Active, on a settled market", () => {
    expect(earnVaultStatusLabel(true, true)).toBe("Settled");
    expect(earnVaultStatusLabel(true, false)).toBe("Active");
    expect(earnVaultStatusLabel(false, false)).toBe("Unavailable");
  });
  it("the vault page wires all three and shows the loss line; the hub header uses the same line", () => {
    const page = src("app/earn/[slab]/page.tsx");
    expect(page).toContain("depositBlockedReason={earnPageDepositBlock(marketHealth, null)}");
    expect(page).toContain("earnVaultStatusLabel(vaultAvailable, earnMarketSettled(marketHealth))");
    expect(page).toContain('data-testid="earn-vault-loss-line"');
    expect(src("components/earn/EarnHeader.tsx")).toContain("EARN_LOSS_LINE}");
    expect(EARN_LOSS_LINE).toMatch(/afford to lose/);
  });
});

describe("insurance explainer example (product review D-15)", () => {
  it("the shortfall is the loss minus the trader's collateral ($1,500 - $1,000 = $500)", () => {
    const s = src("components/market/InsuranceExplainerModal.tsx");
    expect(s).toContain("Insurance fund covers the $500 shortfall");
    expect(s).not.toContain("covers the $1,500 shortfall");
  });
});
