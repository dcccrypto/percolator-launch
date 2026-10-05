// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/v21/GrowthDashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/v21/GrowthDashboard")>()),
  GrowthDashboard: () => createElement("div", { "data-testid": "dashboard" }),
}));

import GrowthPage from "@/app/growth/page";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { CapacityChart, chartDomain, linePath } from "@/components/v21/CapacityChart";
import { charts } from "@/components/v21/GrowthDashboard";
import { toPoint } from "@/lib/v21/capacity-snapshots";

afterEach(() => {
  cleanup();
  __setDevnetV21ForTest(null);
});

describe("/growth page flag gate", () => {
  it("flag off: notFound, the dashboard never mounts", () => {
    __setDevnetV21ForTest(false);
    expect(() => GrowthPage()).toThrow("NEXT_NOT_FOUND");
  });
  it("flag on: renders the dashboard", () => {
    __setDevnetV21ForTest(true);
    render(GrowthPage());
    expect(screen.getByTestId("dashboard")).toBeTruthy();
  });
});

describe("chart helpers", () => {
  const sx = (t: number) => t;
  const sy = (v: number) => v;
  it("linePath breaks the pen at null values", () => {
    expect(linePath([[0, 1], [1, 2], [2, null], [3, 4]], sx, sy)).toBe("M0.0 1.0L1.0 2.0M3.0 4.0");
  });
  it("chartDomain: null with no data; zero-based by default; flat series get a non-zero span", () => {
    expect(chartDomain([{ key: "a", label: "a", color: "x", points: [[0, null]] }], true)).toBeNull();
    expect(chartDomain([{ key: "a", label: "a", color: "x", points: [[0, 5], [10, 9]] }], true)).toEqual({ x0: 0, x1: 10, y0: 0, y1: 9 });
    expect(chartDomain([{ key: "a", label: "a", color: "x", points: [[0, 5], [10, 9]] }], false)!.y0).toBe(5);
    const flat = chartDomain([{ key: "a", label: "a", color: "x", points: [[0, 5]] }], false)!;
    expect(flat.y1).toBeGreaterThan(flat.y0);
    expect(flat.x1).toBeGreaterThan(flat.x0);
  });
  it("an empty series renders the honest empty state, not an empty axis", () => {
    render(createElement(CapacityChart, { title: "Capacity", series: [], format: (v: number) => String(v) }));
    expect(screen.getByText(/No snapshots in this window/)).toBeTruthy();
  });
  it("a populated chart is a labelled image whose label carries the latest values", () => {
    const pts = [
      toPoint({ slab: "s", ts: "2026-10-05T10:00:00Z", capacity_notional_atoms: "1000000000", lp_equity_atoms: "500000000" })!,
      toPoint({ slab: "s", ts: "2026-10-05T10:05:00Z", capacity_notional_atoms: "2000000000", lp_equity_atoms: "900000000" })!,
    ];
    const c = charts(pts)[0];
    render(createElement(CapacityChart, c));
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toContain("Capacity $2.0k");
    expect(img.getAttribute("aria-label")).toContain("LP capital $900");
  });
});

describe("charts()", () => {
  it("builds capacity, utilisation, leverage and NAV charts with a series per side", () => {
    const cs = charts([]);
    expect(cs.map((c) => c.title)).toEqual(["Capacity", "Used capacity", "Max leverage", "Earn NAV per share"]);
    expect(cs[1].series.map((s) => s.label)).toEqual(["Long", "Short"]);
    expect(cs[3].zeroBased).toBe(false);
  });
});
