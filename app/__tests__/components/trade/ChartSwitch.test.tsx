import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/trade/TradingChart", () => ({
  TradingChart: (p: { slabAddress: string; mintAddress?: string }) => <div data-testid="legacy">{p.slabAddress}:{p.mintAddress ?? ""}</div>,
}));
let perpThrows = false;
vi.mock("@/components/trade/perp/PerpChart", () => ({
  PerpChart: (p: { slabAddress: string }) => {
    if (perpThrows) throw new Error("boom");
    return <div data-testid="perp">{p.slabAddress}</div>;
  },
}));
vi.mock("@/lib/tv/data", () => ({ perpChartEnabled: () => process.env.NEXT_PUBLIC_PERP_CHART !== "0" && !!process.env.NEXT_PUBLIC_WS_URL }));

async function renderSwitch() {
  vi.resetModules();
  const { ChartSwitch } = await import("@/components/trade/ChartSwitch");
  return render(<ChartSwitch slabAddress="SLAB" mintAddress="MINT" />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
  perpThrows = false;
});

describe("ChartSwitch", () => {
  it("with a WS URL the chart is the perp chart", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    await renderSwitch();
    expect(screen.getByTestId("perp").textContent).toBe("SLAB");
    expect(screen.queryByTestId("legacy")).toBeNull();
  });
  it("no WS URL: the original chart, with the slab and mint it was given (negative control)", async () => {
    await renderSwitch();
    expect(screen.getByTestId("legacy").textContent).toBe("SLAB:MINT");
    expect(screen.queryByTestId("perp")).toBeNull();
  });
  it("?chart=legacy keeps the original chart even with a WS URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    window.history.replaceState(null, "", "/trade/x?chart=legacy");
    await renderSwitch();
    expect(screen.getByTestId("legacy")).toBeInTheDocument();
  });
  it("NEXT_PUBLIC_PERP_CHART=0 is the rollback switch", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    vi.stubEnv("NEXT_PUBLIC_PERP_CHART", "0");
    await renderSwitch();
    expect(screen.getByTestId("legacy")).toBeInTheDocument();
  });
  it("a render error in the perp chart falls back to the original chart", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    perpThrows = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderSwitch();
    expect(screen.getByTestId("legacy")).toBeInTheDocument();
    err.mockRestore();
  });
});
