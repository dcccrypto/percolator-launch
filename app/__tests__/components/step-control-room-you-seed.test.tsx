/**
 * Control Room "You seed" rendered LP + insurance (1,100 for a 1,000 / 100 launch) while the launch
 * takes LP + insurance + 2 x backingSeedPerDomain(LP) = 3,100: both backing domains are seeded at
 * 100% of LP (on chain, the untraded Jimothy market's vault holds exactly 3,100 Sim-USDC). The
 * readout now shows the wizard's own launch-gate total and the backing inside it.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StepControlRoom } from "@/components/create/StepControlRoom";

/** The component's own source — these are contract assertions about what the
 *  file may contain, which is stronger than any render-time probe. */
const SRC = readFileSync(
  join(__dirname, "../../components/create/StepControlRoom.tsx"),
  "utf8",
);

function renderStep(over: Record<string, unknown> = {}) {
  const props = {
    symbol: "TEST",
    oracleLabel: "Keeper (Pump.fun)",
    startPrice: "$0.004869",
    slabBytes: 26508,
    rentSol: 0.185,
    initialMarginBps: 1000,
    tradingFeeBps: 30,
    lpCollateral: "1000",
    insuranceAmount: "100",
    collateralSymbol: "USDC",
    // 1,000 LP + 100 insurance + 2 x 1,000 backing (the wizard passes its launch-gate total).
    seedTotal: 3100,
    seedBacking: 2000,
    onMarginBpsChange: vi.fn(),
    onLpCollateralChange: vi.fn(),
    onInsuranceChange: vi.fn(),
    onLaunch: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  return render(<StepControlRoom {...(props as never)} />);
}

import fs from "fs";
import path from "path";
import { backingSeedPerDomain } from "@/lib/market-params";

describe("Control Room: You seed is what the launch takes", () => {
  it("shows the total and the backing inside it", () => {
    renderStep();
    expect(screen.getByText("You seed").nextSibling?.textContent).toBe("3,100 USDC");
    expect(screen.getByText("Incl. trader payout reserve").nextSibling?.textContent).toBe("2,000 USDC");
  });

  it("1,000 LP + 100 insurance takes 3,100 under the backing policy", () => {
    const lp = 1_000_000_000n, ins = 100_000_000n;
    expect(lp + ins + 2n * backingSeedPerDomain(lp)).toBe(3_100_000_000n);
  });

  it("the wizard passes the total its launch gate enforces", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"), "utf8");
    expect(src).toContain("seedTotal={Number(totalTokensRequired) / 10 ** decimals}");
    expect(src).toContain("return lpRaw + insRaw + 2n * backingSeedPerDomain(lpRaw);");
  });
});
