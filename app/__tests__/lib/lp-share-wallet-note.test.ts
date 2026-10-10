/**
 * percolator-prog#542 interim note: the LP share mint has 0 decimals and no metadata,
 * so a wallet shows raw share units under an unnamed token. The note must state the
 * exact raw-units conversion the app's own formatShares uses (collateral decimals).
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { lpShareWalletNote, DEFAULT_COLLATERAL_DECIMALS } from "@/lib/lp-share-wallet-note";

describe("lpShareWalletNote", () => {
  it("states the raw-unit conversion for 6-decimal collateral (Sim-USDC / USDC)", () => {
    const s = lpShareWalletNote(6);
    expect(s).toContain("1 share here is 1,000,000 in your wallet");
    expect(s).toContain("1,000 shares read as 1,000,000,000");
    expect(s).toContain("nothing extra was minted");
  });

  it("defaults to the 6-decimal collateral", () => {
    expect(DEFAULT_COLLATERAL_DECIMALS).toBe(6);
    expect(lpShareWalletNote()).toBe(lpShareWalletNote(6));
  });

  it("follows the collateral's decimals and ignores invalid input", () => {
    expect(lpShareWalletNote(9)).toContain("1 share here is 1,000,000,000 in your wallet");
    expect(lpShareWalletNote(-1)).toBe(lpShareWalletNote(6));
    expect(lpShareWalletNote(2.5)).toBe(lpShareWalletNote(6));
  });

  it("is shown on launch success and under the Earn deposit preview", () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");
    expect(read("../../components/create/LaunchSuccess.tsx")).toMatch(/data-testid="launch-lp-wallet-note"[\s\S]*?\{lpShareWalletNote\(\)\}/);
    expect(read("../../components/earn/DepositWithdrawPanel.tsx")).toMatch(/data-testid="earn-lp-wallet-note"[\s\S]*?\{lpShareWalletNote\(decimals\)\}/);
  });
});
