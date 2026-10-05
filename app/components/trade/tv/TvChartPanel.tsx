"use client";

/**
 * The trade page's chart panel when TradingView is the engine.
 *
 * Desktop: a slim header (source badge + Display menu) above the full
 * TradingView UI. Phones: the TradingView toolbars are hidden (the library's
 * minimum comfortable size is 500x500), resolution is our own pill row, and an
 * expand button opens a full-screen sheet with the full toolbar and touch
 * drawing. The PnL / position badges are our React overlays, draggable, above
 * the chart iframe — identical to the fallback chart.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useChartOverlayPrefs } from "@/hooks/useChartOverlayPrefs";
import { useIsLargeScreen } from "@/hooks/useIsLargeScreen";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import type { BarSource } from "@/lib/tv/data/provider";
import type { TvResolution } from "@/lib/tv/types";
import { ChartDisplayMenu } from "../ChartDisplayMenu";
import { LiqEdgeChip } from "../LiqEdgeChip";
import type { LiqEdge } from "@/lib/tv/liqEdge";
import { ChartPnlBadge } from "../ChartPnlBadge";
import { DraggableChartBadges, PositionSummary } from "../ChartBadges";
import { TvChart, type TvChartHandle } from "./TvChart";
import { PerpSeriesToggle } from "../perp/PerpSeriesToggle";
import { PerpChartHeader } from "../perp/PerpChartHeader";
import { usePerpHeaderStats } from "@/hooks/usePerpHeaderStats";
import { usePerpLiveStrip } from "@/hooks/usePerpLiveStrip";
import { getSeriesStore, SERIES_LABEL } from "@/lib/chart/perp-series";
import { perpChartEnabled } from "@/lib/tv/data";
import type { PerpSeries } from "@/lib/chart/perp-types";

/** Pill row on phones: label -> TradingView resolution. */
export const COMPACT_RESOLUTIONS: ReadonlyArray<{ label: string; res: TvResolution }> = [
  { label: "1m", res: "1" },
  { label: "5m", res: "5" },
  { label: "15m", res: "15" },
  { label: "1h", res: "60" },
  { label: "4h", res: "240" },
  { label: "1d", res: "1D" },
];

const badgeStyle = {
  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
  color: "var(--accent)",
  border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
} as const;

function SourceBadge({ source }: { source: BarSource | null }) {
  if (source === "percolator") {
    return (
      <span
        className="rounded-sm px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em]"
        style={badgeStyle}
        title="Source: Percolator match engine (internal trades)"
      >
        PERC
      </span>
    );
  }
  if (source === "perp-mark" || source === "perp-oracle") return null; // the series toggle already says which
  if (source === "oracle") {
    return (
      <span
        className="rounded-sm px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em]"
        style={{ background: "var(--bg-elevated)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
        title="No trades yet — the chart builds from the live price while this page is open"
      >
        Oracle
      </span>
    );
  }
  return null;
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

function FullscreenSheet({
  slabAddress,
  series,
  overlayPrefs,
  badgePrefs,
  onClose,
  onFailure,
}: {
  slabAddress: string;
  series: PerpSeries;
  overlayPrefs: { liq: boolean; entry: boolean };
  badgePrefs: { position: boolean; pnl: boolean };
  onClose(): void;
  onFailure(reason: string): void;
}) {
  const showBadges = badgePrefs.position || badgePrefs.pnl;
  const [liqOff, setLiqOff] = useState<{ edge: LiqEdge; price: number | null }>({ edge: null, price: null });
  const [tvPopup, setTvPopup] = useState(false);
  const onLiqEdge = useCallback((edge: LiqEdge, price: number | null) => setLiqOff({ edge, price }), []);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Full-screen chart"
      className="fixed inset-0 z-[100] flex flex-col bg-[var(--panel-bg)]"
      style={{ height: "100svh" }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-2 py-1.5">
        <LiqEdgeChip edge={liqOff.edge} price={liqOff.price} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close full-screen chart"
          className="rounded-none border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text)]"
        >
          Close
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <TvChart
          key={series}
          slabAddress={slabAddress}
          series={series}
          mode="fullscreen"
          onLiqEdge={onLiqEdge}
          onPopupOpen={setTvPopup}
          overlayPrefs={overlayPrefs}
          onFailure={onFailure}
          className="h-full w-full"
        />
        {showBadges && (
          <DraggableChartBadges hidden={tvPopup}>
            {badgePrefs.position && <PositionSummary slabAddress={slabAddress} />}
            {badgePrefs.pnl && <ChartPnlBadge slabAddress={slabAddress} />}
          </DraggableChartBadges>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface TvChartPanelProps {
  slabAddress: string;
  onFailure(reason: string): void;
}

export function TvChartPanel({ slabAddress, onFailure }: TvChartPanelProps) {
  const isLarge = useIsLargeScreen();
  const mode = isLarge ? "desktop" : "compact";
  const [overlayPrefs, setOverlayPref] = useChartOverlayPrefs();
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState<BarSource | null>(null);
  const [interval, setIntervalState] = useState<TvResolution | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Remount the embedded chart after the sheet closes so it reloads the layout
  // (drawings made in the sheet) the sheet just saved.
  const [embedEpoch, setEmbedEpoch] = useState(0);
  const handleRef = useRef<TvChartHandle | null>(null);
  // Off-screen liq indicator (drawn in the chrome strip below, never over the iframe) and "a TradingView
  // dialog / menu is open" (our badges over the iframe hide meanwhile).
  const [liqOff, setLiqOff] = useState<{ edge: LiqEdge; price: number | null }>({ edge: null, price: null });
  const [tvPopup, setTvPopup] = useState(false);
  const onLiqEdge = useCallback((edge: LiqEdge, price: number | null) => setLiqOff({ edge, price }), []);

  const closeSheet = useCallback(() => {
    setFullscreen(false);
    setReady(false);
    setEmbedEpoch((e) => e + 1);
  }, []);

  const linePrefs = { liq: overlayPrefs.liq, entry: overlayPrefs.entry };
  // Mark / Oracle / Last. The widget remounts per series (the symbol's volume plot and history differ),
  // which re-resolves the symbol through the shared perp datafeed.
  const perpOn = perpChartEnabled();
  const seriesStore = getSeriesStore();
  const series = useSyncExternalStore(seriesStore.subscribe, seriesStore.get, () => "mark" as PerpSeries);
  const strip = usePerpLiveStrip(slabAddress, series);
  const headerStats = usePerpHeaderStats(slabAddress, strip.price, series);
  // Pre-launch pool history on screen: CoinGecko attribution is mandatory (the TradingView logo is the library's own and stays visible).
  const [usesDex, setUsesDex] = useState(false);
  // History failed to load: say so, with a Retry, instead of leaving an empty canvas.
  const [dataError, setDataError] = useState<string | null>(null);
  useEffect(() => { setUsesDex(false); setDataError(null); }, [slabAddress, series]);

  return (
    <div className="flex h-full flex-col rounded-none border border-[var(--border)] bg-[var(--panel-bg)] p-2 lg:p-3">
      {perpOn && (
        <div className="-mx-2 mb-1 shrink-0 border-b border-[var(--border)] lg:-mx-3">
          <PerpChartHeader price={strip.price} stats={headerStats} live={strip.live} ageSec={strip.ageSec} seriesLabel={SERIES_LABEL[series]} />
        </div>
      )}
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SourceBadge source={source} />
          {perpOn && <PerpSeriesToggle value={series} onChange={(s) => seriesStore.set(s)} />}
          <LiqEdgeChip edge={liqOff.edge} price={liqOff.price} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ChartDisplayMenu prefs={overlayPrefs} onToggle={setOverlayPref} />
          {mode === "compact" && (
            <>
              <div className="flex gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
                {COMPACT_RESOLUTIONS.map(({ label, res }) => (
                  <button
                    key={res}
                    type="button"
                    onClick={() => handleRef.current?.setResolution(res)}
                    disabled={!ready}
                    className={`rounded-none px-1.5 py-1 text-xs transition-colors ${
                      interval === res
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                aria-label="Open full-screen chart"
                title="Full-screen chart with drawing tools"
                className="flex h-7 w-7 items-center justify-center rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text)]"
              >
                <ExpandIcon />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden [contain:paint]">
        {fullscreen && mode === "compact" ? (
          <div className="h-[clamp(420px,62svh,640px)] w-full" />
        ) : (
          <TvChart
            key={`${mode}:${embedEpoch}:${series}`}
            slabAddress={slabAddress}
            series={series}
            onDexData={() => setUsesDex(true)}
            onDataError={setDataError}
            onLiqEdge={onLiqEdge}
            onPopupOpen={setTvPopup}
            mode={mode}
            overlayPrefs={linePrefs}
            onFailure={onFailure}
            onReady={() => setReady(true)}
            onSource={setSource}
            onInterval={setIntervalState}
            handleRef={handleRef}
            className="h-[clamp(420px,62svh,640px)] w-full lg:h-full"
          />
        )}

        {dataError !== null && (
          <div
            role="alert"
            data-testid="chart-data-error"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--panel-bg)]/80 text-xs text-[var(--text-muted)]"
          >
            <span>Chart data unavailable</span>
            <button
              type="button"
              onClick={() => { setDataError(null); setReady(false); setEmbedEpoch((e) => e + 1); }}
              className="rounded-none border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text)]"
            >
              Retry
            </button>
          </div>
        )}

        {!ready && !fullscreen && (
          <div
            className="pointer-events-none absolute inset-0 flex items-end justify-center gap-1 pb-[30%]"
            aria-label="Loading chart"
            role="status"
          >
            {[14, 22, 10, 26, 16, 20, 12].map((h, i) => (
              <ShimmerSkeleton key={i} className="w-2" style={{ height: `${h}px` }} />
            ))}
          </div>
        )}

        {ready && (overlayPrefs.position || overlayPrefs.pnl) && (
          <DraggableChartBadges hidden={tvPopup}>
            {overlayPrefs.position && <PositionSummary slabAddress={slabAddress} />}
            {overlayPrefs.pnl && <ChartPnlBadge slabAddress={slabAddress} />}
          </DraggableChartBadges>
        )}
      </div>

      {usesDex && (
        <div className="shrink-0 pt-1 text-right text-[9px] text-[var(--text-muted)]">
          <a
            href="https://www.coingecko.com/en/api"
            target="_blank"
            rel="noopener noreferrer"
            title="Pre-launch history comes from GeckoTerminal (CoinGecko)"
            data-testid="coingecko-attribution"
            className="underline decoration-dotted underline-offset-2 hover:text-[var(--text)]"
          >
            Powered by CoinGecko
          </a>
        </div>
      )}

      {fullscreen && mode === "compact" && (
        <FullscreenSheet
          slabAddress={slabAddress}
          series={series}
          overlayPrefs={linePrefs}
          badgePrefs={{ position: overlayPrefs.position, pnl: overlayPrefs.pnl }}
          onClose={closeSheet}
          onFailure={onFailure}
        />
      )}
    </div>
  );
}

