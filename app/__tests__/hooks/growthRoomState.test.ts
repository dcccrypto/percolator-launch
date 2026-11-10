import { describe, expect, it } from "vitest";
import { growthRoomState } from "@/hooks/useMarketLimits";
import { growthMarketView, growthRecordPresence } from "@/lib/v21/growth-market";
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
    expect(growthRoomState(null, marketRaw(null), 0, false)).toBe("none");
  });
  it("a built view is known", () => {
    const g = {} as NonNullable<ReturnType<typeof growthMarketView>>;
    expect(growthRoomState(g, raw, 0, true)).toBe("known");
  });
});

describe("growthRoomState: a decode throw is room-unknown, never none (Council r4 N3)", () => {
  it("an all-zero buffer is not a market account (the decoder throws): error, not none", () => {
    expect(growthRoomState(null, new Uint8Array(raw.length), 0, false)).toBe("error");
  });
  it("bytes that cannot be decoded map to error (fail closed), not none", () => {
    const truncated = raw.slice(0, 64); // a market account cut short: the decoder throws
    expect(growthRecordPresence(truncated, 0)).toBe("undecodable");
    expect(growthRoomState(null, truncated, 0, false)).toBe("error");
    expect(growthRoomState(null, truncated, 0, true)).toBe("error");
  });
});
