"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import {
  computePnlCardStats,
  buildShareToXUrl,
  PNL_CARD_BACKGROUNDS,
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

type Toast = { msg: string; kind: "ok" | "err" } | null;

export function PnlShareModal({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const markE6 = useLiveMarkE6(data.slab, data.initialMarkE6);
  const stats = computePnlCardStats(data, markE6);

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

  const [bgIdx, setBgIdx] = useState(0);
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

  const flash = (t: Toast) => {
    setToast(t);
    setTimeout(() => setToast(null), 2200);
  };

  if (typeof document === "undefined") return null;

  const bgUrl = PNL_CARD_BACKGROUNDS.length ? PNL_CARD_BACKGROUNDS[bgIdx % PNL_CARD_BACKGROUNDS.length] : null;
  const cycleBg = (dir: number) =>
    setBgIdx((i) => (i + dir + PNL_CARD_BACKGROUNDS.length) % PNL_CARD_BACKGROUNDS.length);

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
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(3,2,10,0.82)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, maxWidth: "100%" }}>
        {/* Card (scaled for display; captured at 1:1) */}
        <div style={{ width: PNL_CARD_SIZE * scale, height: PNL_CARD_SIZE * scale, position: "relative" }}>
          <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <PnlShareCard
              ref={cardRef}
              symbol={data.symbol}
              name={data.name}
              logoUrl={logoUrl}
              pnlUsd={stats.pnlUsd}
              roePct={stats.roePct}
              spentUsd={stats.spentUsd}
              avgEntryUsd={stats.avgEntryUsd}
              avgExitUsd={stats.avgExitUsd}
              isProfit={stats.isProfit}
              bgUrl={bgUrl}
            />
          </div>
        </div>

        {/* Background picker */}
        {PNL_CARD_BACKGROUNDS.length > 1 && (
          <div className="flex items-center gap-3 text-[11px] text-[var(--text-secondary)]">
            <button onClick={() => cycleBg(-1)} aria-label="Previous background" className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-2 py-1 hover:text-[var(--text)]">‹</button>
            <span className="tabular-nums">Background {((bgIdx % PNL_CARD_BACKGROUNDS.length) + 1)} / {PNL_CARD_BACKGROUNDS.length}</span>
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
