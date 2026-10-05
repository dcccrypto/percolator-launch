// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

const swr = vi.fn();
vi.mock("swr", () => ({ default: (key: string | null, ...rest: unknown[]) => swr(key, ...rest) }));

import { GrowthDashboard } from "@/components/v21/GrowthDashboard";

afterEach(() => {
  cleanup();
  swr.mockReset();
});

const market = (o: Record<string, unknown>) => ({
  slab: "11111111111111111111111111111111",
  symbol: "SOL",
  t: 1,
  capacityUsd: 25_000,
  lpEquityUsd: 10_000,
  earnNavUsd: 15_000,
  navPerShare: 1.0123,
  allocatedUsd: 5_000,
  utilLong: 0.72,
  utilShort: 0.1,
  maxLevLong: 2,
  maxLevShort: 10,
  longClosed: false,
  shortClosed: false,
  adlActive: false,
  hlockActive: false,
  ...o,
});

function feed(markets: unknown[] | undefined, extra: { error?: Error; loading?: boolean } = {}) {
  swr.mockImplementation((key: string | null) => {
    if (key === null) return { data: undefined };
    if (key.includes("slab=")) return { data: { points: [] } };
    return { data: markets === undefined ? undefined : { markets }, error: extra.error, isLoading: extra.loading ?? false };
  });
}

describe("GrowthDashboard", () => {
  it("shows per-market capacity, utilisation per side, max leverage per side, Earn NAV/share and allocation", () => {
    feed([market({}), market({ slab: "So11111111111111111111111111111111111111112", symbol: "JUP", capacityUsd: 2_000, longClosed: true, maxLevLong: 0 })]);
    render(<GrowthDashboard />);
    const rows = within(screen.getByTestId("growth-table")).getAllByRole("row");
    // header + 2 markets, biggest capacity first
    expect(rows).toHaveLength(3);
    const sol = within(rows[1]);
    expect(sol.getByText("SOL")).toBeTruthy();
    expect(sol.getByText("$25.0k")).toBeTruthy();
    expect(sol.getByText("72%")).toBeTruthy();
    expect(sol.getByText("10%")).toBeTruthy();
    expect(sol.getByText("2.0x")).toBeTruthy();
    expect(sol.getByText("10x")).toBeTruthy();
    expect(sol.getByText("1.0123")).toBeTruthy();
    expect(sol.getByText("$5.0k")).toBeTruthy();
    expect(within(rows[2]).getByText("closed")).toBeTruthy();
  });
  it("requests the first market's series by default", () => {
    feed([market({})]);
    render(<GrowthDashboard />);
    const keys = swr.mock.calls.map((c) => c[0]);
    expect(keys).toContain("/api/v21/capacity");
    expect(keys.some((k) => typeof k === "string" && k.startsWith("/api/v21/capacity?slab=11111111111111111111111111111111&hours=24"))).toBe(true);
  });
  it("empty and error states are calm sentences", () => {
    feed([]);
    render(<GrowthDashboard />);
    expect(screen.getByTestId("growth-empty")).toBeTruthy();
    cleanup();
    feed(undefined, { error: new Error("HTTP 502") });
    render(<GrowthDashboard />);
    expect(screen.getByRole("alert").textContent).toContain("unavailable");
  });
});
