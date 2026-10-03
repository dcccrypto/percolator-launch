"use client";

/**
 * Hosts one TradingView Advanced Charts widget for one market.
 *
 * - Loads the library with a <script> tag (lib/tv/loadLibrary.ts); never imported.
 * - Data comes from the chart data provider (lib/tv/data) through the datafeed
 *   adapter (lib/tv/datafeed.ts).
 * - The market's layout (drawings, indicators, chart type, resolution) is
 *   restored from and auto-saved to localStorage (lib/tv/saveLoadAdapter.ts);
 *   on a market's first TradingView visit the old chart's saved drawings and
 *   indicators are imported once (lib/tv/legacyImport.ts).
 * - Mark / Liq / Entry are locked horizontal lines (lib/tv/positionLines.ts).
 * - Follows the site theme (useChartTheme) one way: site -> chart.
 *
 * Calls `onFailure` (once) when the chart cannot be shown — library load
 * timeout/error, constructor throw, chartReady timeout — so the caller can
 * render the built-in chart instead.
 *
 * Remount (key) per market: each market has its own saved layout.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { DARK_THEME, LIGHT_THEME, useChartTheme } from "@/hooks/useChartTheme";
import { usePositionLinePrices } from "@/hooks/usePositionLinePrices";
import type { OverlayPrefs } from "@/lib/chart-overlays";
import { getSnapshot, subscribeSlab } from "@/lib/priceStore/priceStore";
import { startPerfSpan } from "@/lib/perf/perfTiming";
import { TV_READY_TIMEOUT_MS } from "@/lib/tv/config";
import { getChartDataProvider } from "@/lib/tv/data";
import type { BarSource } from "@/lib/tv/data/provider";
import { createTvDatafeed } from "@/lib/tv/datafeed";
import { importLegacyOnce } from "@/lib/tv/legacyImport";
import { loadTradingView, TvLoadError } from "@/lib/tv/loadLibrary";
import { PositionLines, desiredLines } from "@/lib/tv/positionLines";
import {
  LocalStorageSaveLoadAdapter,
  createSettingsAdapter,
  loadSlabLayout,
  safeStorage,
  saveSlabLayout,
  type KeyValueStorage,
} from "@/lib/tv/saveLoadAdapter";
import { chartOverrides, type SiteThemeName } from "@/lib/tv/theme";
import type { TvResolution, TvWidget } from "@/lib/tv/types";
import { DEFAULT_INTERVAL, buildWidgetOptions, chartTimezone, type TvLayoutMode } from "@/lib/tv/widgetOptions";

const INTERVAL_KEY = "perc:tv:interval";
/** Mark line updates are coalesced to at most this often. */
const MARK_LINE_MIN_INTERVAL_MS = 250;

export interface TvChartHandle {
  setResolution(resolution: TvResolution): void;
}

export interface TvChartProps {
  slabAddress: string;
  mode: TvLayoutMode;
  overlayPrefs: Pick<OverlayPrefs, "liq" | "entry">;
  onFailure(reason: string): void;
  onReady?(): void;
  onSource?(source: BarSource | null): void;
  onInterval?(resolution: TvResolution): void;
  handleRef?: MutableRefObject<TvChartHandle | null>;
  className?: string;
}

declare global {
  interface Window {
    /** Dev / opt-in debug handle (NODE_ENV !== production, or localStorage perc:tv:debug=1). */
    __percTvWidget?: TvWidget;
  }
}

function siteThemeName(): SiteThemeName {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function browserStorage(): KeyValueStorage {
  try {
    return safeStorage(window.localStorage);
  } catch {
    return safeStorage(null);
  }
}

function userTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function debugHandleEnabled(storage: KeyValueStorage): boolean {
  return process.env.NODE_ENV !== "production" || storage.getItem("perc:tv:debug") === "1";
}

export function TvChart({
  slabAddress,
  mode,
  overlayPrefs,
  onFailure,
  onReady,
  onSource,
  onInterval,
  handleRef,
  className,
}: TvChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TvWidget | null>(null);
  const linesRef = useRef<PositionLines | null>(null);
  const [ready, setReady] = useState(false);

  const chartTheme = useChartTheme();
  const { liq, entry } = usePositionLinePrices(slabAddress);

  // Latest values for callbacks registered once per widget.
  const cb = useRef({ onFailure, onReady, onSource, onInterval });
  cb.current = { onFailure, onReady, onSource, onInterval };
  const themeRef = useRef(chartTheme);
  themeRef.current = chartTheme;
  const lineState = useRef({ liq, entry, prefs: overlayPrefs, theme: chartTheme });
  lineState.current = { liq, entry, prefs: overlayPrefs, theme: chartTheme };
  const markRef = useRef<number | null>(null);
  const prevMarkRef = useRef<number | null>(null);
  const appliedThemeRef = useRef<SiteThemeName | null>(null);

  // ── Widget lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let widget: TvWidget | null = null;
    const cleanups: Array<() => void> = [];
    const storage = browserStorage();

    const fail = (reason: string) => {
      if (cancelled) return;
      cancelled = true;
      try {
        widget?.remove();
      } catch {
        /* ignore */
      }
      widget = null;
      widgetRef.current = null;
      cb.current.onFailure(reason);
    };

    (async () => {
      let TV;
      try {
        TV = await loadTradingView();
      } catch (err) {
        fail(err instanceof TvLoadError ? `load-${err.reason}` : "load-error");
        return;
      }
      if (cancelled) return;

      const saveLoad = new LocalStorageSaveLoadAdapter(storage);
      const saved = await loadSlabLayout(saveLoad, slabAddress);
      const container = containerRef.current;
      if (cancelled || !container) return;

      const themeName = siteThemeName();
      appliedThemeRef.current = themeName;
      const datafeed = createTvDatafeed(getChartDataProvider(), {
        onSource: (_ticker, source) => cb.current.onSource?.(source),
        onResetRequested: () => {
          try {
            widgetRef.current?.activeChart().resetData();
          } catch {
            /* chart gone */
          }
        },
        onError: (where, err) => console.warn(`[TvChart] datafeed ${where} error:`, err),
      });

      try {
        widget = new TV.widget(
          buildWidgetOptions({
            container,
            datafeed,
            slab: slabAddress,
            interval: storage.getItem(INTERVAL_KEY) ?? DEFAULT_INTERVAL,
            themeName,
            dark: DARK_THEME,
            light: LIGHT_THEME,
            mode,
            saveLoad,
            settings: createSettingsAdapter(storage),
            savedData: saved,
            timezone: chartTimezone(userTimezone()),
            debug: false,
          }),
        );
      } catch (err) {
        console.warn("[TvChart] widget constructor threw:", err);
        fail("construct");
        return;
      }
      widgetRef.current = widget;
      if (debugHandleEnabled(storage)) window.__percTvWidget = widget;

      const w = widget;
      const isReady = await Promise.race([
        w.chartReady().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), TV_READY_TIMEOUT_MS)),
      ]);
      if (cancelled) return;
      if (!isReady) {
        fail("ready-timeout");
        return;
      }

      const chart = w.activeChart();
      try {
        w.applyOverrides(chartOverrides(themeRef.current));
      } catch {
        /* cosmetic */
      }
      if (!saved) {
        try {
          await importLegacyOnce(chart, storage, slabAddress);
        } catch (err) {
          console.warn("[TvChart] legacy import failed:", err);
        }
        if (cancelled) return;
      }

      const onAutoSave = () => {
        w.save().then(
          (state) => saveSlabLayout(saveLoad, slabAddress, chart.symbol(), chart.resolution(), state),
          () => {
            /* not saved this time */
          },
        );
      };
      w.subscribe("onAutoSaveNeeded", onAutoSave);
      cleanups.push(() => {
        try {
          w.unsubscribe("onAutoSaveNeeded", onAutoSave);
        } catch {
          /* widget gone */
        }
      });

      const onIntervalChanged = (res: TvResolution) => {
        storage.setItem(INTERVAL_KEY, res);
        cb.current.onInterval?.(res);
      };
      const intervalSub = chart.onIntervalChanged();
      intervalSub.subscribe(null, onIntervalChanged);
      cleanups.push(() => {
        try {
          intervalSub.unsubscribe(null, onIntervalChanged);
        } catch {
          /* widget gone */
        }
      });
      cb.current.onInterval?.(chart.resolution());

      if (handleRef) {
        handleRef.current = {
          setResolution(res) {
            chart.setResolution(res).catch(() => {
              /* unsupported */
            });
          },
        };
        cleanups.push(() => {
          handleRef.current = null;
        });
      }

      linesRef.current = new PositionLines(() => {
        // activeChart() throws once the iframe is detached (React removes the
        // container before effect cleanups run), so never let it escape.
        try {
          return widgetRef.current?.activeChart() ?? null;
        } catch {
          return null;
        }
      });
      setReady(true);
      cb.current.onReady?.();
    })();

    return () => {
      cancelled = true;
      for (const c of cleanups) c();
      linesRef.current?.dispose();
      linesRef.current = null;
      try {
        widget?.remove();
      } catch {
        /* ignore */
      }
      if (window.__percTvWidget === widget) delete window.__percTvWidget;
      widgetRef.current = null;
      setReady(false);
    };
    // One widget per (market, layout mode). Theme/overlay changes are applied in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slabAddress, mode]);

  // ── Mark / Liq / Entry lines ──────────────────────────────────────────────
  const syncLines = useCallback(() => {
    const lines = linesRef.current;
    if (!lines) return;
    const s = lineState.current;
    lines.sync(
      desiredLines({
        markPrice: markRef.current,
        prevMarkPrice: prevMarkRef.current,
        liqPrice: s.liq,
        entryPrice: s.entry,
        prefs: s.prefs,
        theme: s.theme,
      }),
    );
  }, []);

  useEffect(() => {
    if (ready) syncLines();
  }, [ready, liq, entry, overlayPrefs.liq, overlayPrefs.entry, chartTheme, syncLines]);

  // Live mark: straight from the price store (no React state), coalesced.
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    const flush = () => {
      timer = null;
      lastRun = Date.now();
      const finish = startPerfSpan("chart-tick-to-paint");
      syncLines();
      finish();
    };
    const onTick = () => {
      const p = getSnapshot(slabAddress).priceUsd;
      if (p == null || !Number.isFinite(p) || p <= 0) return;
      if (p !== markRef.current) {
        prevMarkRef.current = markRef.current;
        markRef.current = p;
      }
      if (timer) return;
      const wait = Math.max(0, MARK_LINE_MIN_INTERVAL_MS - (Date.now() - lastRun));
      timer = setTimeout(flush, wait);
    };
    const off = subscribeSlab(slabAddress, onTick);
    onTick();
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [ready, slabAddress, syncLines]);

  // ── Site theme -> chart ───────────────────────────────────────────────────
  useEffect(() => {
    const w = widgetRef.current;
    if (!ready || !w) return;
    const name = siteThemeName();
    const apply = () => {
      try {
        w.applyOverrides(chartOverrides(chartTheme));
      } catch {
        /* widget gone */
      }
    };
    if (appliedThemeRef.current === name) {
      apply();
      return;
    }
    appliedThemeRef.current = name;
    w.changeTheme(name).then(apply, apply);
  }, [chartTheme, ready]);

  return <div ref={containerRef} data-testid="tv-chart" className={className} />;
}

