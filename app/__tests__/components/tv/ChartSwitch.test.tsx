import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
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
let failNow: ((reason: string) => void) | null = null;
vi.mock("@/components/trade/tv/TvChartPanel", () => ({
  TvChartPanel: ({ onFailure }: { onFailure(r: string): void }) => {
    failNow = onFailure;
    return <div data-testid="tv">tv</div>;
  },
}));
vi.mock("@/lib/tv/data", () => ({ perpChartEnabled: () => process.env.NEXT_PUBLIC_PERP_CHART !== "0" && !!process.env.NEXT_PUBLIC_WS_URL }));

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

async function renderSwitch() {
  vi.resetModules();
  const { ChartSwitch } = await import("@/components/trade/ChartSwitch");
  return render(<ChartSwitch slabAddress={SLAB} mintAddress="MINT" />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/");
  failNow = null;
  perpThrows = false;
});

describe("ChartSwitch: TradingView by default, built-in chart as the automatic fallback", () => {
  it("library present -> TradingView", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "v32.2.0");
    await renderSwitch();
    expect(screen.getByTestId("tv")).toBeInTheDocument();
  });
  it("no library in this build -> built-in chart; with a WS URL that is the perp chart, without it the original (negative control)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "");
    await renderSwitch();
    expect(screen.getByTestId("legacy").textContent).toBe(`${SLAB}:MINT`);
    expect(screen.queryByTestId("tv")).toBeNull();
  });
  it("no library + WS URL -> the perp chart", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    await renderSwitch();
    expect(screen.getByTestId("perp")).toBeInTheDocument();
    expect(screen.queryByTestId("legacy")).toBeNull();
  });
  it("a load/ready failure falls back to the perp chart for the session and reports it", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "v32.2.0");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    await renderSwitch();
    const Sentry = await import("@sentry/nextjs");
    act(() => failNow?.("ready-timeout"));
    expect(screen.getByTestId("perp")).toBeInTheDocument();
    expect(screen.queryByTestId("tv")).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith("chart_engine_fallback", expect.objectContaining({ tags: { reason: "ready-timeout" } }));
  });
  it("?chart=lwc, NEXT_PUBLIC_CHART_ENGINE=lwc and ?chart=legacy all leave TradingView", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "v32.2.0");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    window.history.replaceState(null, "", "/trade/x?chart=lwc");
    const a = await renderSwitch();
    expect(screen.getByTestId("perp")).toBeInTheDocument();
    a.unmount();
    window.history.replaceState(null, "", "/trade/x?chart=legacy");
    const b = await renderSwitch();
    expect(screen.getByTestId("legacy")).toBeInTheDocument(); // legacy also bypasses the perp chart
    b.unmount();
    window.history.replaceState(null, "", "/");
    vi.stubEnv("NEXT_PUBLIC_CHART_ENGINE", "lwc");
    await renderSwitch();
    expect(screen.getByTestId("perp")).toBeInTheDocument();
  });
  it("NEXT_PUBLIC_PERP_CHART=0 makes the built-in chart the original one", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    vi.stubEnv("NEXT_PUBLIC_PERP_CHART", "0");
    await renderSwitch();
    expect(screen.getByTestId("legacy")).toBeInTheDocument();
  });
  it("a render error in the perp fallback falls back once more to the original chart", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "");
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example");
    perpThrows = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderSwitch();
    expect(screen.getByTestId("legacy")).toBeInTheDocument();
    err.mockRestore();
  });
});
