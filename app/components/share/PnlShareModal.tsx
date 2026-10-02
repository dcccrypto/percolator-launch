"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import {
  computePnlCardStats,
  buildShareToXUrl,
  pnlCardBackgrounds,
  type PnlCardData,
} from "@/lib/pnl-card";
import { PnlShareCard, PNL_CARD_SIZE } from "@/components/share/PnlShareCard";
import { captureCardToBlob, downloadBlob, copyBlobToClipboard } from "@/lib/capture-node";

/** Live market mark for a slab from the shared price store; falls back to the given snapshot. */
function useLiveMarkE6(slab: string, fallbackE6: bigint): bigint {
  const subscribe = useCallback((cb: () => void) => subscribeSlab(slab, cb), [slab]);
  const read = useCallback(() => {
    const e6 = getSnapshot(slab).priceE6;
    return e6 != null && e6 > 0n ? e6 : fallbackE6;
  }, [slab, fallbackE6]);
  // getServerSnapshot returns the fallback (bigint is a stable primitive under SSR/first paint).
  return useSyncExternalStore(subscribe, read, () => fallbackE6);
}

const POLARITY_DWELL_MS = 1200;

/** PnL dead-band (USD) for the polarity hold — at least $0.25, scaling to 0.5% of
 *  the amount spent. Shared by the hysteresis and the breakeven clamp below. */
function polarityBand(spentUsd: number): number {
  return Math.max(0.25, Math.abs(spentUsd) * 0.005);
}

/**
 * Stable profit/loss polarity for the card. A live PnL sitting at breakeven would
 * otherwise flip the card between its green and red treatments on every price
 * tick, so we hold the current polarity until the PnL is DECISIVELY on the other
 * side — past a small dead-band that scales with the position — and a minimum
 * dwell has elapsed since the last flip. The effect re-runs on every PnL change,
 * so a pending flip is continually re-evaluated (and cancelled if the PnL settles
 * back). Returns [isProfit, flipToken]; flipToken increments on each committed
 * flip so the view can play a transition.
 */
function useStablePolarity(pnlUsd: number, spentUsd: number): [boolean, number] {
  const band = polarityBand(spentUsd);
  const [state, setState] = useState(() => ({ isProfit: pnlUsd >= 0, flips: 0 }));
  const lastFlip = useRef(0);
  useEffect(() => {
    const want = pnlUsd >= 0;
    if (want === state.isProfit) return; // steady — nothing to do
    if (Math.abs(pnlUsd) < band) return; // inside the dead-band — hold current
    const commit = () => {
      lastFlip.current = Date.now();
      setState((s) => ({ isProfit: pnlUsd >= 0, flips: s.flips + 1 }));
    };
    const wait = Math.max(0, POLARITY_DWELL_MS - (Date.now() - lastFlip.current));
    if (wait === 0) {
      commit();
      return;
    }
    const t = setTimeout(() => {
      if ((pnlUsd >= 0) !== state.isProfit && Math.abs(pnlUsd) >= band) commit();
    }, wait);
    return () => clearTimeout(t);
  }, [pnlUsd, state.isProfit, band]);
  return [state.isProfit, state.flips];
}

type Toast = { msg: string; kind: "ok" | "err" } | null;

export function PnlShareModal({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markE6 = useLiveMarkE6(data.slab, data.initialMarkE6);
  const stats = computePnlCardStats(data, markE6);
  // Smoothed polarity drives the whole card (colours + background set), so a
  // breakeven PnL can't strobe it; flipToken fires the shake on a real flip.
  const [displayIsProfit, flipToken] = useStablePolarity(stats.pnlUsd, stats.spentUsd);

  // During the brief hysteresis lag at a zero-crossing the live sign can disagree
  // with the still-held polarity. A sub-dead-band blip (immaterial, near zero) is
  // shown as breakeven ($0.00) so the card never reads as a contradiction
  // ("YOU'VE MADE -$0.80"); a MATERIAL opposite value (|pnl| ≥ band, only possible
  // during the dwell window of a fast swing) is shown truthfully — we never hide a
  // real gain/loss, even if its label lags for a beat.
  const subBandBlip = displayIsProfit !== (stats.pnlUsd >= 0) && Math.abs(stats.pnlUsd) < polarityBand(stats.spentUsd);
  const shownPnlUsd = subBandBlip ? 0 : stats.pnlUsd;
  const shownRoePct = subBandBlip ? 0 : stats.roePct;

  // Clear a pending toast timer on unmount so it can't setState after teardown.
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Resolve the token logo from the mint when the caller didn't supply one.
  const [logoUrl, setLogoUrl] = useState<string | null>(data.logoUrl);
  useEffect(() => {
    if (data.logoUrl || !data.mintAddress) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/token-logo/${data.mintAddress}`);
        if (!r.ok) return;
        const j = (await r.json()) as { logoUrl?: string | null };
        if (alive && j?.logoUrl) setLogoUrl(j.logoUrl);
      } catch {
        /* logo is cosmetic — initials fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, [data.logoUrl, data.mintAddress]);

  // Backgrounds are tone-matched to the result and each set is separate. On a
  // polarity flip the new set starts at its first scene — resolved on the SAME
  // render as the flip (via the ref) so the card crossfades straight to the new
  // scene instead of flashing the old index against the new set first.
  const backgrounds = pnlCardBackgrounds(displayIsProfit);
  const [bgIdx, setBgIdx] = useState(0);
  const lastPolarity = useRef(displayIsProfit);
  const effectiveBgIdx = lastPolarity.current === displayIsProfit ? bgIdx : 0;
  useEffect(() => {
    if (lastPolarity.current !== displayIsProfit) {
      lastPolarity.current = displayIsProfit;
      setBgIdx(0);
    }
  }, [displayIsProfit]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [scale, setScale] = useState(1);

  // Responsive scale: fit the 560px card within the viewport on small screens.
  useEffect(() => {
    const fit = () => {
      const avail = Math.min(window.innerWidth * 0.92, PNL_CARD_SIZE);
      setScale(Math.min(1, avail / PNL_CARD_SIZE));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Shake the card on a committed polarity flip — a deliberate "it just changed"
  // beat (the card's colours + background crossfade alongside it). Restart the
  // animation via a reflow; skip for reduced-motion. Applied to the display
  // wrapper, never the captured node, so the PNG export is unaffected.
  useEffect(() => {
    if (flipToken === 0) return; // initial mount is not a flip
    const el = wrapRef.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.style.animation = "none";
    void el.offsetWidth; // force reflow so the animation re-triggers each flip
    el.style.animation = "pnlFlipShake 480ms cubic-bezier(0.36,0.07,0.19,0.97)";
  }, [flipToken]);

  const flash = (t: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  if (typeof document === "undefined") return null;

  const bgUrl = backgrounds.length ? backgrounds[effectiveBgIdx % backgrounds.length] : null;
  const cycleBg = (dir: number) =>
    setBgIdx((i) => (i + dir + backgrounds.length) % backgrounds.length);

  const shareToX = () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://percolator.trade";
    window.open(buildShareToXUrl(data, stats, origin), "_blank", "noopener,noreferrer");
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/trade/${data.slab}`);
      flash({ msg: "Market link copied", kind: "ok" });
    } catch {
      flash({ msg: "Couldn't copy link", kind: "err" });
    }
  };
  const withCapture = async (action: (b: Blob) => Promise<void> | void, okMsg: string) => {
    if (!cardRef.current || busy) return;
    setBusy(true);
    try {
      const blob = await captureCardToBlob(cardRef.current, 2);
      await action(blob);
      flash({ msg: okMsg, kind: "ok" });
    } catch {
      flash({ msg: "Image export failed — try Share to X", kind: "err" });
    } finally {
      setBusy(false);
    }
  };
  const saveImage = () =>
    withCapture((b) => downloadBlob(b, `percolator-pnl-${data.symbol || "position"}.png`), "Image downloaded");
  const copyImage = () =>
    withCapture(async (b) => {
      const ok = await copyBlobToClipboard(b);
      if (!ok) throw new Error("clipboard");
    }, "Image copied");

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share your PnL"
      // React portals bubble synthetic events up the COMPONENT tree, not the DOM
      // tree — so without stopping here, a backdrop click reaches the parent
      // (e.g. the portfolio row's <Link>) and navigates. Stop it, then close.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(3,2,10,0.94)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}
    >
      <style>{`@keyframes pnlFlipShake{10%,90%{transform:translateX(-2px)}20%,80%{transform:translateX(3px)}30%,50%,70%{transform:translateX(-5px)}40%,60%{transform:translateX(5px)}}`}</style>
      {/* margin:auto centers vertically when there's room and lets the top scroll into
          view on short/landscape phones — flex align-items:center would clip it. */}
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, maxWidth: "100%", margin: "auto 0" }}>
        {/* Card (scaled for display; captured at 1:1). The wrapper's shadow lifts the
            opaque card off the backdrop so the site never reads as interfering with it. */}
        <div ref={wrapRef} style={{ width: PNL_CARD_SIZE * scale, height: PNL_CARD_SIZE * scale, position: "relative", borderRadius: 28 * scale, boxShadow: "0 30px 90px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.05)" }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <PnlShareCard
              ref={cardRef}
              symbol={data.symbol}
              name={data.name}
              logoUrl={logoUrl}
              pnlUsd={shownPnlUsd}
              roePct={shownRoePct}
              spentUsd={stats.spentUsd}
              avgEntryUsd={stats.avgEntryUsd}
              avgExitUsd={stats.avgExitUsd}
              isProfit={displayIsProfit}
              bgUrl={bgUrl}
            />
          </div>
        </div>

        {/* Background picker */}
        {backgrounds.length > 1 && (
          <div className="flex items-center gap-3 text-[11px] text-[var(--text-secondary)]">
            <button onClick={() => cycleBg(-1)} aria-label="Previous background" className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-2 py-1 hover:text-[var(--text)]">‹</button>
            <span className="tabular-nums">Background {((effectiveBgIdx % backgrounds.length) + 1)} / {backgrounds.length}</span>
            <button onClick={() => cycleBg(1)} aria-label="Next background" className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-2 py-1 hover:text-[var(--text)]">›</button>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-center gap-2" style={{ maxWidth: PNL_CARD_SIZE }}>
          <button onClick={shareToX} className="rounded-sm bg-[var(--accent)] px-4 py-2 text-[12px] font-bold text-black transition-opacity hover:opacity-90">
            Share to X
          </button>
          <button onClick={saveImage} disabled={busy} className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-[12px] font-semibold text-[var(--text)] hover:border-[var(--accent)]/40 disabled:opacity-40">
            {busy ? "Working…" : "Save image"}
          </button>
          <button onClick={copyImage} disabled={busy} className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-[12px] font-semibold text-[var(--text)] hover:border-[var(--accent)]/40 disabled:opacity-40">
            Copy image
          </button>
          <button onClick={copyLink} className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-[12px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text)]">
            Copy link
          </button>
          <button onClick={onClose} className="rounded-sm px-4 py-2 text-[12px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text)]">
            Close
          </button>
        </div>

        {toast && (
          <div className={`text-[11px] ${toast.kind === "ok" ? "text-[var(--long)]" : "text-[var(--short)]"}`} role="status">
            {toast.msg}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
