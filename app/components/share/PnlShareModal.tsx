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
import { captureCardToBlob, downloadBlob, writeImageToClipboard } from "@/lib/capture-node";
import { useTokenLogo } from "@/hooks/useTokenLogo";
import { useLockBodyScroll } from "@/hooks/useLockBodyScroll";

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

/**
 * Profit/loss polarity for the BACKGROUND SCENE only (the artwork set and the
 * flip shake) — never the card's text, which always follows the live sign. A PnL
 * hovering at breakeven would otherwise swap the full-card artwork on every price
 * tick, so the scene flips at most once per POLARITY_DWELL_MS. There is no
 * dead-band: any lag between the scene and the true sign is bounded by the dwell.
 * Returns [isProfit, flipToken]; flipToken increments on each committed flip so
 * the view can play a transition.
 */
function useStablePolarity(pnlUsd: number): [boolean, number] {
  const want = pnlUsd >= 0;
  const [state, setState] = useState(() => ({ isProfit: want, flips: 0 }));
  const lastFlip = useRef(0);
  useEffect(() => {
    if (want === state.isProfit) return; // steady — nothing to do
    const commit = () => {
      lastFlip.current = Date.now();
      setState((s) => ({ isProfit: want, flips: s.flips + 1 }));
    };
    const wait = Math.max(0, POLARITY_DWELL_MS - (Date.now() - lastFlip.current));
    if (wait === 0) {
      commit();
      return;
    }
    // Re-armed on every sign change; cancelled if the sign settles back.
    const t = setTimeout(commit, wait);
    return () => clearTimeout(t);
  }, [want, state.isProfit]);
  return [state.isProfit, state.flips];
}

type Toast = { msg: string; kind: "ok" | "err" } | null;

export function PnlShareModal({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The overlay scrolls itself (short screens); the page behind it must not, or
  // both scrollbars show and the wheel scrolls the page under the card.
  useLockBodyScroll();
  const markE6 = useLiveMarkE6(data.slab, data.initialMarkE6);
  const stats = computePnlCardStats(data, markE6);
  // Smoothed polarity picks ONLY the background artwork set (so a breakeven PnL
  // can't strobe the scene); flipToken fires the shake on a committed flip. The
  // card's text — amount, ROE, PROFIT/LOSS label, wording, arrow, colour — always
  // shows the TRUE signed figures from `stats` (the same numbers the dock shows),
  // and the tweet is built from that same `stats`, so the two can't disagree.
  const [sceneIsProfit, flipToken] = useStablePolarity(stats.pnlUsd);

  // Clear a pending toast timer on unmount so it can't setState after teardown.
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Logo precedence exactly as components/market/MarketLogo.tsx: the uploaded
  // logo_url wins; otherwise the DEX logo resolved from the MAINNET contract
  // address (never the devnet mint); otherwise the card's initials tile.
  const dexLogoUrl = useTokenLogo(data.logoUrl ? null : data.mainnetCa);
  const logoUrl = data.logoUrl ?? dexLogoUrl;

  // Backgrounds are tone-matched to the result and each set is separate. On a
  // polarity flip the new set starts at its first scene — resolved on the SAME
  // render as the flip (via the ref) so the card crossfades straight to the new
  // scene instead of flashing the old index against the new set first.
  const backgrounds = pnlCardBackgrounds(sceneIsProfit);
  const [bgIdx, setBgIdx] = useState(0);
  const lastPolarity = useRef(sceneIsProfit);
  const effectiveBgIdx = lastPolarity.current === sceneIsProfit ? bgIdx : 0;
  useEffect(() => {
    if (lastPolarity.current !== sceneIsProfit) {
      lastPolarity.current = sceneIsProfit;
      setBgIdx(0);
    }
  }, [sceneIsProfit]);
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
  const fileName = `percolator-pnl-${data.symbol || "position"}.png`;
  const saveImage = async () => {
    if (!cardRef.current || busy) return;
    setBusy(true);
    try {
      downloadBlob(await captureCardToBlob(cardRef.current, 2), fileName);
      flash({ msg: "Image downloaded", kind: "ok" });
    } catch {
      flash({ msg: "Image export failed — try Share to X", kind: "err" });
    } finally {
      setBusy(false);
    }
  };
  // Safari/iOS only allow clipboard.write() while the click's user activation is
  // live, and the PNG render is async. So the ClipboardItem is created and written
  // SYNCHRONOUSLY in this handler with a Promise<Blob> (no await before it); the
  // browser waits for the image itself. Where that isn't supported (or the write
  // is refused) the image is downloaded instead.
  const copyImage = async () => {
    if (!cardRef.current || busy) return;
    setBusy(true);
    const blobPromise = captureCardToBlob(cardRef.current, 2);
    blobPromise.catch(() => {}); // observed below; avoid an unhandled-rejection report
    const copied = writeImageToClipboard(blobPromise);
    try {
      if (await copied) {
        flash({ msg: "Image copied", kind: "ok" });
      } else {
        downloadBlob(await blobPromise, fileName);
        flash({ msg: "Copying images isn't supported here — image downloaded", kind: "ok" });
      }
    } catch {
      flash({ msg: "Image export failed — try Share to X", kind: "err" });
    } finally {
      setBusy(false);
    }
  };

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
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(3,2,10,0.94)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto", overscrollBehavior: "contain" }}
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
              pnlUsd={stats.pnlUsd}
              roePct={stats.roePct}
              paperPnlUsd={stats.paperPnlUsd}
              isCapped={stats.isCapped}
              spentUsd={stats.spentUsd}
              avgEntryUsd={stats.avgEntryUsd}
              avgExitUsd={stats.avgExitUsd}
              tone={stats.tone}
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
