import { describe, expect, it, vi } from "vitest";
import {
  LocalStorageSaveLoadAdapter,
  MAX_STORED_CHARTS,
  createSettingsAdapter,
  loadSlabLayout,
  safeStorage,
  saveSlabLayout,
  slabChartId,
  type KeyValueStorage,
} from "@/lib/tv/saveLoadAdapter";
import {
  applyLegacyImport,
  chartTypeFor,
  importLegacyOnce,
  importedMarker,
  planLegacyImport,
  studyFor,
  TV_SERIES,
} from "@/lib/tv/legacyImport";
import type { TvChartApi } from "@/lib/tv/types";

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

function mem(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("save/load adapter (localStorage)", () => {
  it("round-trips a per-market layout", async () => {
    const s = mem();
    const a = new LocalStorageSaveLoadAdapter(s);
    expect(await loadSlabLayout(a, SLAB)).toBeNull();
    await saveSlabLayout(a, SLAB, "SOL/USD", "60", { charts: [{ panes: [] }] });
    expect(await loadSlabLayout(a, SLAB)).toEqual({ charts: [{ panes: [] }] });
    const all = await a.getAllCharts();
    expect(all).toEqual([expect.objectContaining({ id: slabChartId(SLAB), symbol: SLAB, resolution: "60" })]);
    await a.removeChart(slabChartId(SLAB));
    expect(await loadSlabLayout(a, SLAB)).toBeNull();
    expect(await a.getAllCharts()).toEqual([]);
  });

  it("evicts the oldest layouts past the cap", async () => {
    const s = mem();
    let t = 1_000_000;
    const a = new LocalStorageSaveLoadAdapter(s, () => (t += 1000));
    for (let i = 0; i < MAX_STORED_CHARTS + 3; i++) {
      await a.saveChart({ id: `c${i}`, name: "n", symbol: "s", resolution: "1D", content: "{}", timestamp: 0 });
    }
    const ids = (await a.getAllCharts()).map((r) => r.id);
    expect(ids).toHaveLength(MAX_STORED_CHARTS);
    expect(ids).not.toContain("c0");
    expect(s.data.has("perc:tv:chart:c0")).toBe(false);
    expect(s.data.has(`perc:tv:chart:c${MAX_STORED_CHARTS + 2}`)).toBe(true);
  });

  it("study, drawing and chart templates", async () => {
    const a = new LocalStorageSaveLoadAdapter(mem());
    await a.saveStudyTemplate({ name: "mine", content: "X" });
    expect(await a.getAllStudyTemplates()).toEqual([{ name: "mine" }]);
    expect(await a.getStudyTemplateContent({ name: "mine" })).toBe("X");
    await a.removeStudyTemplate({ name: "mine" });
    await expect(a.getStudyTemplateContent({ name: "mine" })).rejects.toThrow();
    await a.saveDrawingTemplate("trend_line", "t1", "C");
    expect(await a.getDrawingTemplates("trend_line")).toEqual(["t1"]);
    expect(await a.loadDrawingTemplate("trend_line", "t1")).toBe("C");
    await a.removeDrawingTemplate("trend_line", "t1");
    expect(await a.getDrawingTemplates("trend_line")).toEqual([]);
    await a.saveChartTemplate("ct", { a: 1 });
    expect(await a.getAllChartTemplates()).toEqual(["ct"]);
    expect(await a.getChartTemplateContent("ct")).toEqual({ content: { a: 1 } });
    await a.removeChartTemplate("ct");
    expect(await a.getChartTemplateContent("ct")).toEqual({});
  });

  it("never throws when storage does (private mode / quota)", async () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const a = new LocalStorageSaveLoadAdapter(throwing);
    await expect(saveSlabLayout(a, SLAB, "n", "1D", {})).resolves.toBeUndefined();
    expect(await loadSlabLayout(a, SLAB)).toBeNull();
    expect(safeStorage(null).getItem("x")).toBeNull();
  });

  it("corrupt stored JSON reads as empty", async () => {
    const s = mem();
    s.setItem("perc:tv:charts", "{nope");
    s.setItem(`perc:tv:chart:${slabChartId(SLAB)}`, "[1,2]");
    const a = new LocalStorageSaveLoadAdapter(s);
    expect(await a.getAllCharts()).toEqual([]);
    expect(await loadSlabLayout(a, SLAB)).toBeNull();
  });

  it("settings adapter persists to one key", () => {
    const s = mem();
    const st = createSettingsAdapter(s);
    st.setValue("tz", "Europe/London");
    st.setValue("x", "1");
    st.removeValue("x");
    expect(createSettingsAdapter(s).initialSettings).toEqual({ tz: "Europe/London" });
  });
});

function fakeChart() {
  const calls: string[] = [];
  const chart = {
    setChartType: vi.fn(async (t: number) => void calls.push(`type:${t}`)),
    createStudy: vi.fn(async (name: string, _f?: boolean, _l?: boolean, inputs?: Record<string, unknown>) => {
      calls.push(`study:${name}:${JSON.stringify(inputs)}`);
      return "s1";
    }),
    createShape: vi.fn(async (p: { price?: number }, o: { shape?: string }) => {
      calls.push(`shape:${o.shape}:${p.price}`);
      return "h1";
    }),
    createMultipointShape: vi.fn(async (pts: Array<{ time: number }>, o: { shape?: string }) => {
      calls.push(`multi:${o.shape}:${pts.map((x) => x.time).join("-")}`);
      return "m1";
    }),
  };
  return { chart: chart as unknown as TvChartApi, calls, raw: chart };
}

function seedLegacy(s: KeyValueStorage) {
  s.setItem(
    `perc:chart:drawings:${SLAB}`,
    JSON.stringify({
      version: 1,
      drawings: [
        { id: "a", kind: "trend", p1: { time: 1_000_000, price: 1 }, p2: { time: 2_000_000, price: 2 } },
        { id: "b", kind: "horizontal", price: 1.5 },
        { id: "c", kind: "rectangle", p1: { time: 3_000_000, price: 1 }, p2: { time: 4_000_000, price: 2 } },
        { id: "bad", kind: "circle" },
      ],
    }),
  );
  s.setItem(
    `perc:chart:indicators:${SLAB}`,
    JSON.stringify({
      version: 1,
      indicators: [
        { id: "1", kind: "sma", period: 50, color: "#F59E0B" },
        { id: "2", kind: "bollinger", period: 30, stdDev: 2.5, color: "#fff" },
        { id: "3", kind: "macd", fastPeriod: 8, slowPeriod: 21, signalPeriod: 5, color: "#fff" },
      ],
    }),
  );
  s.setItem("perc:chart:style", "candle-hollow");
}

describe("one-time import of the old chart's prefs", () => {
  it("plans drawings (ms -> s), studies with v32 input ids, and the chart type", () => {
    const s = mem();
    seedLegacy(s);
    const plan = planLegacyImport(s, SLAB, 999);
    expect(plan.shapes).toEqual([
      { kind: "multi", shape: "trend_line", points: [{ time: 1000, price: 1 }, { time: 2000, price: 2 }] },
      { kind: "single", shape: "horizontal_line", point: { time: 999, price: 1.5 } },
      { kind: "multi", shape: "rectangle", points: [{ time: 3000, price: 1 }, { time: 4000, price: 2 }] },
    ]);
    expect(plan.studies.map((x) => [x.name, x.inputs])).toEqual([
      ["Moving Average", { length: 50 }],
      ["Bollinger Bands", { in_0: 30, in_1: 2.5 }],
      ["MACD", { in_0: 8, in_1: 21, in_2: 5 }],
    ]);
    expect(plan.chartType).toBe(TV_SERIES.hollowCandles);
  });

  it("maps every old style and indicator kind", () => {
    expect(chartTypeFor("bar")).toBe(0);
    expect(chartTypeFor("line")).toBe(2);
    expect(chartTypeFor("area")).toBe(3);
    expect(chartTypeFor("candle-solid")).toBe(1);
    expect(chartTypeFor("candle-hollow-up")).toBe(1);
    expect(studyFor({ id: "e", kind: "ema", period: 34, color: "#000" }).name).toBe("Moving Average Exponential");
    expect(studyFor({ id: "r", kind: "rsi", period: 7, color: "#000" })).toMatchObject({ name: "Relative Strength Index", inputs: { length: 7 } });
  });

  it("imports once per market and marks it done", async () => {
    const s = mem();
    seedLegacy(s);
    const { chart, calls } = fakeChart();
    expect(await importLegacyOnce(chart, s, SLAB, 999)).toBe(7);
    expect(calls).toContain("type:9");
    expect(s.getItem(importedMarker(SLAB))).toBe("999");
    expect(await importLegacyOnce(chart, s, SLAB, 999)).toBe(0);
    expect(calls).toHaveLength(7);
    // The old keys stay for the fallback chart.
    expect(s.getItem(`perc:chart:drawings:${SLAB}`)).not.toBeNull();
  });

  it("nothing to import still marks done; one failing item does not stop the rest", async () => {
    const s = mem();
    const { chart } = fakeChart();
    expect(await importLegacyOnce(chart, s, SLAB)).toBe(0);
    expect(s.getItem(importedMarker(SLAB))).not.toBeNull();

    const s2 = mem();
    seedLegacy(s2);
    const f = fakeChart();
    f.raw.createStudy.mockRejectedValueOnce(new Error("bad study"));
    f.raw.createMultipointShape.mockRejectedValueOnce(new Error("out of range"));
    expect(await applyLegacyImport(f.chart, planLegacyImport(s2, SLAB, 1))).toBe(5);
  });
});
