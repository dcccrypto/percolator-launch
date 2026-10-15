/**
 * Resuming a stuck launch from the recovery banner went through handleLaunch, which required the
 * FULL launch cost in SOL. The slab account already exists by then, so a wallet with enough for the
 * remaining steps was blocked ("Need ~X SOL"). While resuming, the wizard requires only the steps
 * still to run: still a real check, so a resume can't land the LP step (past the reclaim window)
 * and then stall for lack of SOL.
 *
 * S16: it used to subtract only the slab rent, about a sixth of the total since one-slot launches
 * (#3357), so a resume past the LP step still had to hold that step's rent (~0.067 SOL) again.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeCreateMarketSolCost, remainingCreateMarketSolCost } from "@/components/create/CostEstimate";

describe("create wizard SOL requirement while resuming", () => {
  const src = readFileSync(resolve(process.cwd(), "components/create/CreateMarketWizard.tsx"), "utf8").replace(/\s+/g, " ");

  it("resume mode requires the remaining steps' cost; a fresh launch the full cost", () => {
    expect(src).toContain(
      "const requiredSol = resumeFromStep !== null ? remainingCreateMarketSolCost(solCostBreakdown, resumeFromStep, { p3: p3WizardEnabled() }) : solCostBreakdown.totalSolCost;",
    );
    // The gate and the "Need ~X SOL" reason both read it.
    expect(src).toContain("const hasSufficientSol = solBalance !== null && solBalance >= requiredSol;");
    expect(src).toContain("`Need ~${requiredSol.toFixed(3)} SOL`");
  });
});

describe("remainingCreateMarketSolCost (S16)", () => {
  const cost = computeCreateMarketSolCost();
  const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

  it("before the LP step has run (resume at 1 or 2): everything but the slab", () => {
    close(remainingCreateMarketSolCost(cost, 1), cost.totalSolCost - cost.slabRentSol);
    close(remainingCreateMarketSolCost(cost, 2), cost.totalSolCost - cost.slabRentSol);
  });

  it("past the LP step (resume at 3+): its portfolio and matcher rent is no longer required", () => {
    close(remainingCreateMarketSolCost(cost, 3), cost.totalSolCost - cost.slabRentSol - cost.lpPortfolioMatcherRentSol);
    expect(cost.lpPortfolioMatcherRentSol).toBeGreaterThan(cost.slabRentSol); // the larger part, not the slab
  });

  it("resume at 5 (stake pool still to create): the Earn vault + stake rent is still required", () => {
    close(remainingCreateMarketSolCost(cost, 5), remainingCreateMarketSolCost(cost, 3));
  });

  it("past the Earn vault and stake pool (resume at 6): their rent comes off too", () => {
    close(
      remainingCreateMarketSolCost(cost, 6),
      cost.totalSolCost - cost.slabRentSol - cost.lpPortfolioMatcherRentSol - cost.earnVaultStakeRentSol,
    );
  });

  it("stays conservative: token accounts and fees are always required, and P3 keeps the LP rent", () => {
    expect(remainingCreateMarketSolCost(cost, 6)).toBeGreaterThanOrEqual(cost.tokenAccountRentSol + cost.txFeeSol - 1e-12);
    const p3 = computeCreateMarketSolCost({ p3: true });
    close(remainingCreateMarketSolCost(p3, 3, { p3: true }), p3.totalSolCost - p3.slabRentSol);
  });
});
