/**
 * #2954: a token with no supported pool cannot launch on devnet, but the Control Room still showed a
 * GREEN "Price feed" readout and a live cost estimate, so the dead end only surfaced at the launch
 * button. When the wizard says the market is not registrable, the readout is warn-toned
 * "No supported pool", the reason is visible text, and the dials and cost estimate are dimmed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepControlRoom } from "@/components/create/StepControlRoom";

function renderStep(over: Record<string, unknown> = {}) {
  const props = {
    symbol: "TEST",
    oracleLabel: "Admin Oracle",
    startPrice: "$0.004869",
    slabBytes: 26508,
    rentSol: 0.185,
    initialMarginBps: 1000,
    tradingFeeBps: 30,
    lpCollateral: "1000",
    insuranceAmount: "100",
    collateralSymbol: "USDC",
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

const costRows = () => ["Market rent", "You seed", "Incl. counterparty backing"].map((k) => screen.getByText(k).parentElement as HTMLElement);
const feedValue = () => screen.getByText("Price feed").nextSibling as HTMLElement;

describe("Control Room: unregistrable token (#2954)", () => {
  it("registrable (default): feed readout stays green with the oracle label, nothing dimmed", () => {
    renderStep({ oracleLabel: "Keeper (Pump.fun)" });
    expect(feedValue().textContent).toBe("Keeper (Pump.fun)");
    expect(feedValue().className).toContain("--long");
    expect(screen.getByTestId("control-dials").getAttribute("data-dimmed")).toBe("false");
    expect(costRows().every((r) => r.getAttribute("data-dimmed") === "false")).toBe(true);
    expect(screen.queryByTestId("not-registrable-reason")).toBeNull();
  });

  it("not registrable: warn-toned 'No supported pool', not the green admin label", () => {
    renderStep({ registrable: false, notRegistrableReason: "No supported pool found for this token." });
    expect(feedValue().textContent).toBe("No supported pool");
    expect(feedValue().className).toContain("--warning");
    expect(feedValue().className).not.toContain("--long");
  });

  it("not registrable: dials and each cost row are dimmed (on the row itself, dividers kept)", () => {
    renderStep({ registrable: false, notRegistrableReason: "x" });
    const dials = screen.getByTestId("control-dials");
    expect(dials.getAttribute("data-dimmed")).toBe("true");
    expect(dials.className).toContain("opacity-50");
    const rows = costRows();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.getAttribute("data-dimmed")).toBe("true");
      expect(r.className).toContain("opacity-50");
      expect(r.className).toContain("border-b");
    }
  });

  it("not registrable: the reason is visible text", () => {
    renderStep({ registrable: false, notRegistrableReason: "No supported pool found for this token." });
    expect(screen.getByTestId("not-registrable-reason").textContent).toContain("No supported pool found for this token.");
  });

  it("the reason appears exactly once when HoldToLaunch already shows it", () => {
    const reason = "No supported pool found for this token.";
    renderStep({ registrable: false, notRegistrableReason: reason, launchDisabled: true, launchDisabledReason: reason });
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(screen.getAllByRole("status").filter((n) => n.textContent === reason)).toHaveLength(1);
  });

  it("the reason is still shown (once) when the launch button says something else", () => {
    renderStep({ registrable: false, notRegistrableReason: "No supported pool.", launchDisabled: true, launchDisabledReason: "Connect wallet" });
    expect(screen.getAllByText("No supported pool.")).toHaveLength(1);
  });
});
