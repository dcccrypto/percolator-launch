// @vitest-environment node
/**
 * Council 2026-11-06-go1106-ux: the chart badge said "Offline" while the page's price ticked, because it counted only
 * the indexer's `tick` pushes. `chartLiveState` takes the newest of the tick feed and the display-price feed.
 */
import { describe, expect, it } from "vitest";
import { chartLiveState, CHART_DELAYED_AFTER_MS, CHART_OFFLINE_AFTER_MS } from "../../../lib/chart/live-state";

const NOW = 1_000_000_000;

describe("chartLiveState", () => {
  it("nothing heard at all is offline", () => {
    expect(chartLiveState({ tickAt: null, displayAt: null, now: NOW })).toEqual({ state: "offline", ageMs: null });
  });

  it("a fresh display price alone is live (the v2.2 preview case)", () => {
    expect(chartLiveState({ tickAt: null, displayAt: NOW - 500, now: NOW })).toEqual({ state: "live", ageMs: 500 });
  });

  it("a fresh tick alone is live (unchanged)", () => {
    expect(chartLiveState({ tickAt: NOW - 200, displayAt: null, now: NOW }).state).toBe("live");
  });

  it("uses the NEWER of the two feeds", () => {
    expect(chartLiveState({ tickAt: NOW - CHART_OFFLINE_AFTER_MS - 1, displayAt: NOW - 100, now: NOW })).toEqual({ state: "live", ageMs: 100 });
  });

  it("delayed and offline thresholds still apply", () => {
    expect(chartLiveState({ tickAt: null, displayAt: NOW - CHART_DELAYED_AFTER_MS - 1, now: NOW }).state).toBe("delayed");
    expect(chartLiveState({ tickAt: null, displayAt: NOW - CHART_OFFLINE_AFTER_MS - 1, now: NOW }).state).toBe("offline");
  });
});
