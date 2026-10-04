/**
 * Resuming a stuck launch from the recovery banner went through handleLaunch, which required the
 * FULL launch cost in SOL. The slab account (the bulk of it) already exists by then, so a wallet
 * with enough for the remaining steps was blocked ("Need ~X SOL"). While resuming, the wizard now
 * requires the full cost minus the slab rent: still a real check, so a resume can't land the LP
 * step (past the reclaim window) and then stall for lack of SOL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("create wizard SOL requirement while resuming", () => {
  const src = readFileSync(resolve(process.cwd(), "components/create/CreateMarketWizard.tsx"), "utf8").replace(/\s+/g, " ");

  it("resume mode requires the cost without the slab rent; a fresh launch the full cost", () => {
    expect(src).toContain(
      "const requiredSol = resumeFromStep !== null ? solCostBreakdown.totalSolCost - solCostBreakdown.slabRentSol : solCostBreakdown.totalSolCost;",
    );
    // The gate and the "Need ~X SOL" reason both read it.
    expect(src).toContain("const hasSufficientSol = solBalance !== null && solBalance >= requiredSol;");
    expect(src).toContain("`Need ~${requiredSol.toFixed(3)} SOL`");
  });
});
