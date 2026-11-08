import { describe, expect, it } from "vitest";
import { growthRoomState } from "@/hooks/useMarketLimits";
import { growthMarketView } from "@/lib/v21/growth-market";
import { marketRaw } from "../lib/v21/fixtures";

const raw = marketRaw({ launch: 800, tier: 800, ceil: 800, kink: 5000, lambda: 10_000 });

describe("growthRoomState (M9: room is a required input)", () => {
  it("slab bytes not loaded: room unknown (loading, or error when the read failed)", () => {
    expect(growthRoomState(null, null, 0, false)).toBe("loading");
    expect(growthRoomState(null, null, 0, true)).toBe("error");
  });
  it("growth record present but the view cannot be built: loading / error, never none", () => {
    expect(growthRoomState(null, raw, 0, false)).toBe("loading");
    expect(growthRoomState(null, raw, 0, true)).toBe("error");
  });
  it("no growth record (all-zero / not a growth market): genuinely no room limit", () => {
    expect(growthRoomState(null, new Uint8Array(raw.length), 0, false)).toBe("none");
  });
  it("a built view is known", () => {
    const g = {} as NonNullable<ReturnType<typeof growthMarketView>>;
    expect(growthRoomState(g, raw, 0, true)).toBe("known");
  });
});
