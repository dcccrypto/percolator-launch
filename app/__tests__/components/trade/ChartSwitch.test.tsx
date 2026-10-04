import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/trade/TradingChart", () => ({
  TradingChart: (p: { slabAddress: string; mintAddress?: string }) => <div data-testid="legacy">{p.slabAddress}:{p.mintAddress ?? ""}</div>,
}));

describe("ChartSwitch (foundation)", () => {
  it("renders the built-in chart with the slab and mint it is given", async () => {
    const { ChartSwitch } = await import("@/components/trade/ChartSwitch");
    render(<ChartSwitch slabAddress="SLAB" mintAddress="MINT" />);
    expect(screen.getByTestId("legacy").textContent).toBe("SLAB:MINT");
  });
});
