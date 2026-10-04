import { afterEach, describe, expect, it, vi } from "vitest";
import { DARK_THEME, LIGHT_THEME } from "@/hooks/useChartTheme";
import { selectChartEngine, TV_LOADER_SRC } from "@/lib/tv/config";
import { loadTradingView, resetTradingViewLoaderForTests, TvLoadError } from "@/lib/tv/loadLibrary";
import { PositionLines, desiredLines, type LineInputs } from "@/lib/tv/positionLines";
import { chartOverrides, colorRamp, customThemes, mixHex } from "@/lib/tv/theme";
import { buildWidgetOptions, chartTimezone, featuresets } from "@/lib/tv/widgetOptions";
import type { TvChartApi, TvDatafeed, TvSaveLoadAdapter } from "@/lib/tv/types";

describe("engine selection", () => {
  it("TV by default when the build has the library; lwc otherwise", () => {
    expect(selectChartEngine({ libraryVersion: "v32.2.0", envEngine: undefined, query: null })).toBe("tv");
    expect(selectChartEngine({ libraryVersion: "", envEngine: undefined, query: "tv" })).toBe("lwc");
    expect(selectChartEngine({ libraryVersion: "", envEngine: "tv", query: null })).toBe("lwc");
  });
  it("kill switch and per-visit opt-out", () => {
    expect(selectChartEngine({ libraryVersion: "v32.2.0", envEngine: "lwc", query: "tv" })).toBe("lwc");
    expect(selectChartEngine({ libraryVersion: "v32.2.0", envEngine: undefined, query: "lwc" })).toBe("lwc");
    expect(selectChartEngine({ libraryVersion: "v32.2.0", envEngine: "tv", query: "tv" })).toBe("tv");
  });
});

describe("library loader", () => {
  afterEach(() => {
    resetTradingViewLoaderForTests();
    delete window.TradingView;
    document.head.querySelectorAll("script[data-tv-loader]").forEach((s) => s.remove());
    vi.useRealTimers();
  });

  it("injects one script tag and resolves the global", async () => {
    const p = loadTradingView();
    expect(loadTradingView()).toBe(p); // singleton
    const tags = document.head.querySelectorAll("script[data-tv-loader]");
    expect(tags).toHaveLength(1);
    expect((tags[0] as HTMLScriptElement).src).toContain(TV_LOADER_SRC);
    window.TradingView = { widget: function () {} as unknown as never };
    tags[0].dispatchEvent(new Event("load"));
    await expect(p).resolves.toBe(window.TradingView);
  });

  it("rejects on script error, missing global and timeout", async () => {
    const p1 = loadTradingView("/x.js", 10_000);
    document.head.querySelector("script[data-tv-loader]")!.dispatchEvent(new Event("error"));
    await expect(p1).rejects.toMatchObject({ reason: "script-error" });

    resetTradingViewLoaderForTests();
    const p2 = loadTradingView("/y.js", 10_000);
    document.head.querySelectorAll("script[data-tv-loader]")[1].dispatchEvent(new Event("load"));
    await expect(p2).rejects.toBeInstanceOf(TvLoadError);
    await expect(p2).rejects.toMatchObject({ reason: "no-global" });

    resetTradingViewLoaderForTests();
    vi.useFakeTimers();
    const p3 = loadTradingView("/z.js", 50);
    vi.advanceTimersByTime(60);
    await expect(p3).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("theme", () => {
  it("19-shade ramps with the base colour at 500", () => {
    const r = colorRamp("#9945FF");
    expect(r).toHaveLength(19);
    expect(r[9]).toBe("#9945FF");
    expect(r.every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
    expect(r[0]).toBe(mixHex("#FFFFFF", "#9945FF", 0.1));
    expect(mixHex("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    const t = customThemes(DARK_THEME, LIGHT_THEME);
    expect(t.dark.color4[9]).toBe(DARK_THEME.upColor.toUpperCase());
    expect(t.light.color3[9]).toBe(LIGHT_THEME.downColor.toUpperCase());
  });

  it("overrides paint the site palette and hide the series' own price line", () => {
    const o = chartOverrides(DARK_THEME);
    expect(o["paneProperties.background"]).toBe(DARK_THEME.bg);
    expect(o["mainSeriesProperties.candleStyle.upColor"]).toBe(DARK_THEME.upColor);
    expect(o["mainSeriesProperties.showPriceLine"]).toBe(false);
    expect(o["scalesProperties.showSeriesLastValue"]).toBe(false);
    expect(chartOverrides(LIGHT_THEME)["paneProperties.background"]).toBe(LIGHT_THEME.bg);
  });
});

describe("widget options", () => {
  it("same-origin iframe everywhere; symbol switching and manual save menus are off", () => {
    for (const mode of ["desktop", "compact", "fullscreen"] as const) {
      const f = featuresets(mode);
      expect(f.enabled).toContain("iframe_loading_same_origin");
      expect(f.disabled).toEqual(expect.arrayContaining(["header_symbol_search", "header_compare", "header_saveload", "use_localstorage_for_settings"]));
    }
  });
  it("phones hide the toolbars; the full-screen sheet keeps them", () => {
    expect(featuresets("compact").disabled).toEqual(expect.arrayContaining(["header_widget", "left_toolbar", "timeframes_toolbar", "control_bar"]));
    expect(featuresets("fullscreen").disabled).not.toContain("left_toolbar");
    expect(featuresets("desktop").disabled).not.toContain("header_widget");
  });
  it("builds constructor options", () => {
    const base = {
      container: document.createElement("div"),
      datafeed: {} as TvDatafeed,
      slab: "S",
      interval: "60",
      themeName: "light" as const,
      dark: DARK_THEME,
      light: LIGHT_THEME,
      mode: "desktop" as const,
      saveLoad: {} as TvSaveLoadAdapter,
      settings: { setValue() {}, removeValue() {} },
      savedData: null,
      timezone: "Etc/UTC",
      debug: false,
    };
    const o = buildWidgetOptions(base);
    expect(o.library_path).toBe("/charting_library/");
    expect(o.custom_css_url).toBe("/tv-theme/percolator.css");
    expect(o.theme).toBe("light");
    expect(o.overrides?.["paneProperties.background"]).toBe(LIGHT_THEME.bg);
    expect("saved_data" in o).toBe(false);
    expect(buildWidgetOptions({ ...base, savedData: { a: 1 } }).saved_data).toEqual({ a: 1 });
  });
  it("timezone: known zones pass, others chart in UTC", () => {
    expect(chartTimezone("Europe/London")).toBe("Europe/London");
    expect(chartTimezone("Antarctica/Troll")).toBe("Etc/UTC");
    expect(chartTimezone(undefined)).toBe("Etc/UTC");
  });
});

const inputs = (over: Partial<LineInputs> = {}): LineInputs => ({
  markPrice: 10,
  prevMarkPrice: null,
  liqPrice: 8,
  entryPrice: 9,
  prefs: { liq: true, entry: true },
  theme: DARK_THEME,
  ...over,
});

describe("Mark / Liq / Entry lines", () => {
  it("desired set follows prices and the Display toggles", () => {
    const all = desiredLines(inputs());
    expect(Object.keys(all).sort()).toEqual(["entry", "liq", "mark"]);
    expect(all.mark).toMatchObject({ text: "Mark", style: 2, color: DARK_THEME.neutralLine });
    expect(all.liq).toMatchObject({ text: "Liq", style: 0, width: 2, color: DARK_THEME.downColor });
    expect(all.entry).toMatchObject({ text: "Entry", color: DARK_THEME.entryLine });
    expect(desiredLines(inputs({ prefs: { liq: false, entry: false } }))).toEqual({ mark: all.mark });
    expect(desiredLines(inputs({ liqPrice: 0, entryPrice: null, markPrice: NaN }))).toEqual({});
  });
  it("mark tints up/down and holds on an equal tick", () => {
    expect(desiredLines(inputs({ prevMarkPrice: 9 })).mark?.color).toBe(DARK_THEME.upColor);
    expect(desiredLines(inputs({ prevMarkPrice: 11 })).mark?.color).toBe(DARK_THEME.downColor);
  });

  function fake() {
    let n = 0;
    const shapes = new Map<string, { setPoints: ReturnType<typeof vi.fn>; setProperties: ReturnType<typeof vi.fn> }>();
    const pending: Array<() => void> = [];
    const chart = {
      createShape: vi.fn((_p: unknown, opts: Record<string, unknown>) => {
        const id = `id${++n}`;
        shapes.set(id, { setPoints: vi.fn(), setProperties: vi.fn() });
        void opts;
        return new Promise<string>((res) => pending.push(() => res(id)));
      }),
      getShapeById: vi.fn((id: string) => {
        const s = shapes.get(id);
        if (!s) throw new Error("gone");
        return s;
      }),
      removeEntity: vi.fn((id: string) => void shapes.delete(id)),
    };
    const settle = async () => {
      while (pending.length) pending.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { chart: chart as unknown as TvChartApi, raw: chart, shapes, settle };
  }

  it("creates locked, unsaved lines once, then moves/recolours in place", async () => {
    const f = fake();
    const lines = new PositionLines(() => f.chart, () => 1000);
    lines.sync(desiredLines(inputs()));
    lines.sync(desiredLines(inputs())); // while creating: no duplicates
    expect(f.raw.createShape).toHaveBeenCalledTimes(3);
    const opts = f.raw.createShape.mock.calls[0][1] as Record<string, unknown>;
    expect(opts).toMatchObject({ shape: "horizontal_line", lock: true, disableSelection: true, disableSave: true, disableUndo: true, showInObjectsTree: false });
    await f.settle();
    lines.sync(desiredLines(inputs({ markPrice: 11, prevMarkPrice: 10 })));
    const markShape = f.shapes.get("id1")!;
    expect(markShape.setPoints).toHaveBeenCalledWith([{ time: 1000, price: 11 }]);
    expect(markShape.setProperties).toHaveBeenCalledWith(expect.objectContaining({ linecolor: DARK_THEME.upColor }));
    expect(f.shapes.get("id2")!.setPoints).not.toHaveBeenCalled(); // liq unchanged
  });

  it("removes a line when toggled off, including one still being created", async () => {
    const f = fake();
    const lines = new PositionLines(() => f.chart, () => 1);
    lines.sync(desiredLines(inputs()));
    lines.sync(desiredLines(inputs({ prefs: { liq: false, entry: true } }))); // liq create still in flight
    await f.settle();
    expect(f.raw.removeEntity).toHaveBeenCalledWith("id2");
    expect([...f.shapes.keys()].sort()).toEqual(["id1", "id3"]);
    lines.dispose();
    expect(f.shapes.size).toBe(0);
  });

  it("a throwing chart getter (iframe detached on unmount) never escapes", () => {
    const lines = new PositionLines(() => {
      throw new TypeError("Cannot read properties of null (reading 'tradingViewApi')");
    });
    expect(() => lines.sync(desiredLines(inputs()))).not.toThrow();
    expect(() => lines.dispose()).not.toThrow();
  });
});
