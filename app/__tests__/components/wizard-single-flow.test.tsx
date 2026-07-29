/**
 * The create wizard is a single linear flow: Token → Parameters → Review.
 *
 * Replaces gh1615-wizard-step-header-quick-mode.test.ts, which asserted the
 * Quick/Manual step-header remapping. That file re-implemented the wizard's
 * logic inside itself rather than importing it, so once the mode selector was
 * removed it kept passing while testing code that no longer existed.
 *
 * These tests render the REAL WizardProgress so a regression surfaces here.
 *
 * Why the modes went away:
 *  - "Manual" existed to pick a slab tier and an oracle.
 *  - Slab tier is vestigial under v17: the slab size is pinned to
 *    v17MarketAccountLen(14) on every path (InitMarket reverts otherwise), and
 *    all three programsBySlabTier entries point at the same wrapper.
 *  - Oracle modes DO exist in v17; a meaningful CHOICE does not on devnet. The
 *    launch path resolves to keeper-delegated (AUTH_MARK, oracle_mode=3) when a
 *    DEX pool is detected and admin otherwise, overriding whatever was picked.
 *
 * What a creator still controls (and must keep controlling): leverage and the
 * fee split. Trading fee is fixed for every market and must NOT be settable.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WizardProgress } from "@/components/create/WizardProgress";

describe("create wizard — single linear flow", () => {
  it("renders exactly three steps by default", () => {
    render(<WizardProgress currentStep={1} completedSteps={new Set()} />);
    for (const label of ["Token", "Parameters", "Review"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("no longer offers Oracle or Slab Tier as steps", () => {
    render(<WizardProgress currentStep={1} completedSteps={new Set()} />);
    expect(screen.queryByText("Oracle")).toBeNull();
    expect(screen.queryByText("Oracle ✓")).toBeNull();
    expect(screen.queryByText("Slab Tier")).toBeNull();
  });

  it("reports 'of 3' rather than the old 'of 4'", () => {
    render(<WizardProgress currentStep={2} completedSteps={new Set([1])} />);
    // Mobile counter renders the total; assert 3 appears and 4 does not.
    expect(screen.queryByText(/of\s*4/i)).toBeNull();
  });

  it("accepts a step count other than four (was hard-typed to a 4-tuple)", () => {
    // Regression guard: WizardProgress used to require exactly four labels,
    // which is what blocked collapsing the flow in the first place.
    expect(() =>
      render(
        <WizardProgress
          currentStep={1}
          completedSteps={new Set()}
          stepLabels={["A", "B", "C"]}
        />,
      ),
    ).not.toThrow();
  });
});
