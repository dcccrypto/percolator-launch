import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The fallback chart is lazy (next/dynamic); render a marker instead of lightweight-charts.
vi.mock("next/dynamic", () => ({
  default: () =>
    function Lwc(props: { slabAddress: string }) {
      return <div data-testid="lwc">{props.slabAddress}</div>;
    },
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
let failNow: ((reason: string) => void) | null = null;
vi.mock("@/components/trade/tv/TvChartPanel", () => ({
  TvChartPanel: ({ onFailure }: { onFailure(r: string): void }) => {
    failNow = onFailure;
    return <div data-testid="tv">tv</div>;
  },
}));

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

async function renderSwitch() {
  vi.resetModules();
  const { ChartSwitch } = await import("@/components/trade/ChartSwitch");
  return render(<ChartSwitch slabAddress={SLAB} />);
}

describe("ChartSwitch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
    failNow = null;
  });

  it("no library in this build -> built-in chart", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "");
    await renderSwitch();
    expect(screen.getByTestId("lwc")).toBeInTheDocument();
    expect(screen.queryByTestId("tv")).toBeNull();
  });

  it("library present -> TradingView, and a load/ready failure falls back for the session", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "v32.2.0");
    await renderSwitch();
    expect(screen.getByTestId("tv")).toBeInTheDocument();
    const Sentry = await import("@sentry/nextjs");
    act(() => failNow?.("ready-timeout"));
    expect(screen.getByTestId("lwc")).toBeInTheDocument();
    expect(screen.queryByTestId("tv")).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith("chart_engine_fallback", expect.objectContaining({ tags: { reason: "ready-timeout" } }));
  });

  it("?chart=lwc and NEXT_PUBLIC_CHART_ENGINE=lwc opt out", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "v32.2.0");
    window.history.replaceState(null, "", "/trade/x?chart=lwc");
    await renderSwitch();
    expect(screen.getByTestId("lwc")).toBeInTheDocument();
  });

  it("kill switch", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_LIBRARY_VERSION", "v32.2.0");
    vi.stubEnv("NEXT_PUBLIC_CHART_ENGINE", "lwc");
    await renderSwitch();
    expect(screen.getByTestId("lwc")).toBeInTheDocument();
  });
});
