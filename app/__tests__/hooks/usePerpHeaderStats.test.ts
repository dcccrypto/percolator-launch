import { describe, expect, it } from "vitest";
import { hourlyHistoryUrl, parseHourly } from "@/hooks/usePerpHeaderStats";

const NOW = 1_791_000_000;
describe("24h-change baseline follows the selected series", () => {
  it("Mark and Oracle read their own persisted candles", () => {
    expect(hourlyHistoryUrl("S", "mark", NOW)).toBe("/api/perp-chart/S?series=mark&resolution=60&countBack=30");
    expect(hourlyHistoryUrl("S", "oracle", NOW)).toBe("/api/perp-chart/S?series=oracle&resolution=60&countBack=30");
  });
  it("Last reads the trade candles (negative control: never the mark route)", () => {
    const u = hourlyHistoryUrl("S", "last", NOW);
    expect(u.startsWith("/api/candles/S?resolution=60&from=")).toBe(true);
    expect(u).not.toContain("perp-chart");
    expect(u).toContain(`to=${NOW}`);
  });
  it("parses each route's shape", () => {
    expect(parseHourly("oracle", { bars: [{ t: 3600, o: 1, h: 2, l: 1, c: 2 }] })).toEqual([{ timeSec: 3600, open: 1, close: 2 }]);
    expect(parseHourly("last", { s: "ok", t: [3600], o: [1], h: [2], l: [1], c: [2], v: [5] })).toEqual([{ timeSec: 3600, open: 1, close: 2 }]);
    expect(parseHourly("last", { s: "no_data" })).toEqual([]);
  });
});
