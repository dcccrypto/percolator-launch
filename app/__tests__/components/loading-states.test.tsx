/**
 * UX WP-10 (audit §4.9, UI-2): a field that has not loaded shows "—" with data-state="loading",
 * never a default rendered as a fact ("$0", "Cooldown None"). The Earn rail and the Earn market
 * page gate their figures on the first completed read.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOADING_DASH, LoadingValue, loadingText } from "@/components/ui/LoadingValue";

describe("LoadingValue", () => {
  it("loading -> the dash with data-state=loading; loaded -> the value", () => {
    const { rerender } = render(<LoadingValue loading>$0</LoadingValue>);
    expect(screen.getByText(LOADING_DASH).getAttribute("data-state")).toBe("loading");
    expect(screen.queryByText("$0")).toBeNull();
    rerender(<LoadingValue loading={false}>$12.2K</LoadingValue>);
    expect(screen.getByText("$12.2K")).toBeTruthy();
    expect(loadingText(true, "None")).toBe(LOADING_DASH);
    expect(loadingText(false, "None")).toBe("None");
  });
  it("the Earn rail and the Earn market page gate TVL / cooldown / status on the first read", () => {
    const rail = readFileSync(resolve(process.cwd(), "components/earn/VaultDepositRail.tsx"), "utf8");
    for (const f of ["Fee", "Cooldown"]) expect(rail).toMatch(new RegExp(`<Figure label="${f}" loading=\\{!everLoaded\\}`));
    // App bug 2026-10-29: TVL is also "—" while a bound vault has no program price yet.
    expect(rail).toContain('<Figure label="TVL" loading={!everLoaded || vaultUsd === null}');
    expect(rail).toContain("<LoadingValue loading={loading}>{value}</LoadingValue>");
    const page = readFileSync(resolve(process.cwd(), "app/earn/[slab]/page.tsx"), "utf8");
    expect(page).toContain("<LoadingValue loading={firstLoad || vaultUsd === null}>${formatCompact(vaultUsd ?? 0)}</LoadingValue>");
    expect(page).toMatch(/label="Withdrawal wait"\s*value=\{loadingText\(firstLoad,/);
    expect(page).toMatch(/label="Vault status"\s*value=\{loadingText\(firstLoad,/);
  });
});
