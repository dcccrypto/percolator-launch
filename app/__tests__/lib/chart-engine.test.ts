import { describe, expect, it } from "vitest";
import { selectBuiltInChart } from "@/lib/chart-engine";

describe("selectBuiltInChart", () => {
  it("perp when enabled", () => expect(selectBuiltInChart({ perpEnabled: true, query: null })).toBe("perp"));
  it("legacy when the perp feed is disabled (rollback switch)", () => expect(selectBuiltInChart({ perpEnabled: false, query: null })).toBe("legacy"));
  it("?chart=legacy wins over an enabled perp chart; other values do not", () => {
    expect(selectBuiltInChart({ perpEnabled: true, query: "legacy" })).toBe("legacy");
    expect(selectBuiltInChart({ perpEnabled: true, query: "tv" })).toBe("perp");
    expect(selectBuiltInChart({ perpEnabled: true, query: "" })).toBe("perp");
  });
});
