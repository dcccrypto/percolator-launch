/**
 * #3281: the Insurance card's "Top Up" sent a wrapper tag 75 DepositToLpVault (an Earn deposit
 * that mints vault shares and never touches the insurance balance) while the modal said the user
 * funded insurance. TopUpInsurance (tag 9) is callable only by the market's insurance authority
 * (handle_top_up_insurance: expect_live_authority), so the Insurance card offers no deposit at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "@testing-library/jest-dom";
import { InsuranceDashboard } from "@/components/market/InsuranceDashboard";
import { InsuranceExplainerModal } from "@/components/market/InsuranceExplainerModal";

vi.mock("@/lib/mock-mode", () => ({ isMockMode: vi.fn(() => false) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: vi.fn(() => false) }));

const DEPOSIT_ACTION = /top[ -]?up|deposit|contribute|add funds|fund shares/i;
const FALSE_CLAIMS = [
  /anyone can (contribute|top up)/i,
  /community members can top up/i,
  /no approvals? needed/i,
  /consider\s+topping up/i,
  /receive fund shares/i,
];

afterEach(() => cleanup());

describe("Insurance card and explainer offer no deposit action (#3281)", () => {
  it("the card has no deposit button, and its explainer has none either", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        balance: "20000000000",
        totalRisk: "13333333333",
        historicalBalance: [{ timestamp: Date.now(), balance: 20000 }],
      }),
    }) as unknown as typeof fetch;

    render(<InsuranceDashboard slabAddress="test-slab" />);
    await waitFor(() => expect(screen.getByText("Low")).toBeInTheDocument());
    for (const b of screen.getAllByRole("button")) expect(b.textContent ?? "").not.toMatch(DEPOSIT_ACTION);

    fireEvent.click(screen.getByText("more"));
    expect(await screen.findByText("What is the Insurance Fund?")).toBeInTheDocument();
    for (const b of screen.getAllByRole("button")) expect(b.textContent ?? "").not.toMatch(DEPOSIT_ACTION);
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  it("the explainer says who actually funds insurance and makes none of the false claims", () => {
    render(<InsuranceExplainerModal onClose={() => {}} />);
    const text = document.body.textContent ?? "";
    for (const re of FALSE_CLAIMS) expect(text, String(re)).not.toMatch(re);
    expect(text).toMatch(/only the market.s insurance\s*authority can add/i);
    expect(text).toMatch(/no public deposit into the insurance fund/i);
    expect(text).toMatch(/Earn.*does not add to the insurance balance/i);
  });

  it("negative control: the false claims and the deposit button are what the old copy contained", () => {
    const old =
      "Anyone can contribute, no approval needed. Community members can top up the insurance fund anytime. " +
      "Low: risky, consider topping up. Top Up Insurance. Est. fund shares";
    expect(FALSE_CLAIMS.some((re) => re.test(old))).toBe(true);
    expect(DEPOSIT_ACTION.test("Top Up Insurance")).toBe(true);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** Why a market component would build an Earn deposit (wrapper tag 75). */
export function earnDepositReasons(src: string): string[] {
  const hits: string[] = [];
  if (/buildEarnDepositIxs/.test(src)) hits.push("buildEarnDepositIxs");
  if (/limits\/earn-ixs/.test(src)) hits.push("limits/earn-ixs");
  if (/const\s*\{[^}]*\bdeposit\b[^}]*\}\s*=\s*useInsuranceLP\(/.test(src)) hits.push("useInsuranceLP().deposit");
  if (/encodeDepositToLpVault|DepositToLpVault|TAG_DEPOSIT_TO_LP_VAULT/.test(src)) hits.push("DepositToLpVault");
  if (/InsuranceTopUpModal/.test(src)) hits.push("InsuranceTopUpModal");
  return hits;
}

describe("nothing under components/market builds an Earn deposit (tag 75)", () => {
  it("source scan", () => {
    const root = join(__dirname, "..", "..", "..", "components", "market");
    const offenders = walk(root)
      .map((f) => [f, earnDepositReasons(readFileSync(f, "utf8"))] as const)
      .filter(([, r]) => r.length > 0);
    expect(offenders).toEqual([]);
  });

  it("negative control: the scan flags the removed modal's source", () => {
    const removedModal = `
      import { useInsuranceLP } from "@/hooks/useInsuranceLP";
      const { deposit, state: lpState } = useInsuranceLP();
      await deposit(amountBaseUnits);`;
    expect(earnDepositReasons(removedModal)).toContain("useInsuranceLP().deposit");
    expect(earnDepositReasons("buildEarnDepositIxs({})")).toContain("buildEarnDepositIxs");
  });
});
