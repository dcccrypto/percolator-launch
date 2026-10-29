// @vitest-environment node
/**
 * GH prog#627 family (2026-10-29): a share price over a near-zero base. The Earn deposit preview
 * must say what tag 75 actually mints, at the edges where the base is zero or dust:
 *  - genesis (no shares): 1:1 MINUS the 1,000 dead shares (LP_VAULT_MINIMUM_LIQUIDITY), and
 *    refused when the deposit does not exceed them;
 *  - shares outstanding but a zero value: refused (the panel used to show a 1:1 mint here);
 *  - a deposit that floors to 0 shares: refused (LpVaultZeroSharesMinted), never "0 shares".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LP_VAULT_MINIMUM_LIQUIDITY, previewDepositSharesMinted } from "@/lib/limits/earn-withdraw";

describe("previewDepositSharesMinted mirrors tag 75 at a zero / dust base", () => {
  it("genesis mints 1:1 minus the dead shares, and refuses at or below them", () => {
    expect(LP_VAULT_MINIMUM_LIQUIDITY).toBe(1_000n);
    expect(previewDepositSharesMinted(1_000_000n, 0n, 0n)).toBe(999_000n);
    expect(previewDepositSharesMinted(1_001n, 0n, 0n)).toBe(1n);
    expect(previewDepositSharesMinted(1_000n, 0n, 0n)).toBeNull();
    expect(previewDepositSharesMinted(1n, 0n, 0n)).toBeNull();
  });
  it("refuses a zero value with shares outstanding (no 1:1 fallback)", () => {
    expect(previewDepositSharesMinted(1_000_000n, 5_000n, 0n)).toBeNull();
  });
  it("refuses a deposit that floors to zero shares", () => {
    // 1 share is worth 1e6 atoms: 999,999 atoms mint floor(0.999999) = 0 -> refused
    expect(previewDepositSharesMinted(999_999n, 1n, 1_000_000n)).toBeNull();
    expect(previewDepositSharesMinted(1_000_000n, 1n, 1_000_000n)).toBe(1n);
  });
  it("is the plain pro-rata floor in the normal range", () => {
    expect(previewDepositSharesMinted(100n, 1_000n, 1_100n)).toBe(90n);
    expect(previewDepositSharesMinted(0n, 1_000n, 1_100n)).toBeNull();
    expect(previewDepositSharesMinted(100n, 1_000n, null)).toBeNull();
  });
  it("the deposit panel previews with it (no 1:1 fallback on a zero value)", () => {
    const src = readFileSync(join(__dirname, "../../../components/earn/DepositWithdrawPanel.tsx"), "utf8");
    expect(src).toContain("previewDepositSharesMinted(");
    expect(src).not.toMatch(/=== 0n\) return rawAmount;/);
  });
});
