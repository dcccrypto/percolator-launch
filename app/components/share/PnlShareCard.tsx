"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { formatSignedUsd, formatSignedPct, formatPriceUsd, PERCOLATOR_TAG } from "@/lib/pnl-card";

export interface PnlShareCardView {
  symbol: string;
  name: string;
  logoUrl: string | null;
  pnlUsd: number;
  roePct: number;
  spentUsd: number;
  avgEntryUsd: number;
  avgExitUsd: number;
  isProfit: boolean;
  /** Background scene URL (the full card art: character + neon frame + empty
   *  stats panel). A gradient shows if unset or it fails to load. */
  bgUrl: string | null;
}

/** Fixed design size — square, matching the artwork. The modal scales this for display; capture uses it 1:1. */
export const PNL_CARD_SIZE = 560;

// Concrete colours (no CSS vars / color-mix) so the card serialises cleanly for image export.
const GREEN = { base: "#4ade80", glow: "rgba(74,222,128,0.6)", soft: "rgba(74,222,128,0.14)", line: "rgba(74,222,128,0.65)" };
const RED = { base: "#f87171", glow: "rgba(248,113,113,0.6)", soft: "rgba(248,113,113,0.14)", line: "rgba(248,113,113,0.65)" };
const FONT = "var(--font-jetbrains-mono, ui-monospace), 'DejaVu Sans Mono', monospace";
const SHADOW = "0 2px 10px rgba(0,0,0,0.75)";
// Ease the green↔red tonal flip so a change of result glides rather than snaps.
// Harmless to the PNG export (the one-shot SVG raster has nothing to animate).
const COLOR_TX = "color 320ms ease, border-color 320ms ease, background-color 320ms ease, text-shadow 320ms ease";

/** Old background scene fading out above the new one — the profit/loss (or picker)
 *  crossfade. Capture ignores it: the export inlines only the ROOT background, and
 *  this child's relative-url background never resolves in the serialised SVG. */
function FadeOutScene({ url }: { url: string }) {
  const [op, setOp] = useState(1);
  useEffect(() => {
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setOp(0)));
    return () => cancelAnimationFrame(r);
  }, []);
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: `url("${url}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        opacity: op,
        transition: "opacity 360ms ease",
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * The shareable live-PnL card. The background art already carries the neon frame
 * and the empty bottom stats panel, so this only OVERLAYS the live data: the
 * logo / name / PnL / % on the upper-left, and the Spent / Avg entry / Avg exit
 * strip inside the baked panel. Green for profit, red for loss; the PnL is always
 * signed so a loss reads "-$…".
 */
export const PnlShareCard = forwardRef<HTMLDivElement, PnlShareCardView>(function PnlShareCard(v, ref) {
  const good = v.isProfit;
  const C = good ? GREEN : RED;

  // Crossfade the scene when bgUrl changes (polarity flip or the viewer picking
  // another background): the root paints the CURRENT scene immediately, and the
  // previous one is flashed on top and faded out. The root always holds the live
  // scene, so the PNG export (root background only) stays correct.
  const [prevBg, setPrevBg] = useState<string | null>(null);
  const bgRef = useRef<string | null>(v.bgUrl);
  useEffect(() => {
    if (bgRef.current === v.bgUrl) return;
    setPrevBg(bgRef.current);
    bgRef.current = v.bgUrl;
    const t = setTimeout(() => setPrevBg(null), 380);
    return () => clearTimeout(t);
  }, [v.bgUrl]);

  return (
    <div
      ref={ref}
      style={{
        width: PNL_CARD_SIZE,
        height: PNL_CARD_SIZE,
        position: "relative",
        overflow: "hidden",
        borderRadius: 28,
        fontFamily: FONT,
        backgroundColor: "#0a0a12",
        backgroundImage: v.bgUrl
          ? `url("${v.bgUrl}")`
          : "radial-gradient(120% 120% at 100% 0%, #3b1d6e 0%, #140a2e 55%, #060410 100%)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        userSelect: "none",
      }}
    >
      {/* Outgoing scene (crossfade) — above the root background, below the scrim. */}
      {prevBg ? <FadeOutScene key={prevBg} url={prevBg} /> : null}

      {/* Gentle upper-left scrim for text legibility — inset so it never dims the baked frame. */}
      <div
        style={{
          position: "absolute",
          top: "5%",
          left: "4%",
          right: "4%",
          bottom: "5%",
          borderRadius: 20,
          background: "linear-gradient(100deg, rgba(5,4,14,0.62) 0%, rgba(5,4,14,0.34) 30%, rgba(5,4,14,0) 58%)",
        }}
      />

      {/* Upper-left data block */}
      <div style={{ position: "absolute", top: "7.5%", left: "7.5%", right: "7.5%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={{ position: "relative", width: 50, height: 50, borderRadius: 13, overflow: "hidden", flexShrink: 0, background: "rgba(255,255,255,0.1)", boxShadow: "0 0 0 1px rgba(255,255,255,0.18)" }}>
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 800, color: "#fff" }}>
              {(v.symbol || "?").slice(0, 2).toUpperCase()}
            </span>
            {v.logoUrl ? (
              /* No crossOrigin: the logo is an external CDN URL (via /api/token-logo);
                 crossOrigin="anonymous" would FAIL the load (→ initials) on any CDN without
                 CORS headers. The PNG export inlines it best-effort (lib/capture-node), falling
                 back to initials when CORS/CSP blocks the fetch. */
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.logoUrl} alt="" width={50} height={50} style={{ position: "absolute", inset: 0, width: 50, height: 50, objectFit: "cover" }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            ) : null}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 25, fontWeight: 800, color: "#fff", lineHeight: 1.05, letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 300, textShadow: SHADOW }}>
              {v.name}
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.72)", marginTop: 2, textShadow: SHADOW }}>${v.symbol}</div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <span style={{ display: "inline-block", padding: "5px 13px", borderRadius: 9, fontSize: 12.5, fontWeight: 800, letterSpacing: "0.12em", color: C.base, border: `1.5px solid ${C.line}`, background: C.soft, transition: COLOR_TX }}>
            {good ? "PROFIT" : "LOSS"}
          </span>
        </div>

        <div style={{ marginTop: 13, fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", color: "rgba(255,255,255,0.82)", textShadow: SHADOW }}>
          {good ? "YOU'VE MADE" : "YOU'RE DOWN"}
        </div>
        <div style={{ fontSize: 54, fontWeight: 800, lineHeight: 1.0, marginTop: 4, color: C.base, textShadow: `0 0 24px ${C.glow}, 0 2px 8px rgba(0,0,0,0.6)`, letterSpacing: "-0.02em", transition: COLOR_TX }}>
          {formatSignedUsd(v.pnlUsd)}
        </div>

        <div style={{ marginTop: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px", borderRadius: 9, fontSize: 17, fontWeight: 800, color: C.base, border: `1.5px solid ${C.line}`, background: C.soft, transition: COLOR_TX }}>
            <span style={{ fontSize: 13 }}>{good ? "▲" : "▼"}</span>
            {formatSignedPct(v.roePct)}
          </span>
        </div>
      </div>

      {/* Stats — sit inside the baked bottom panel */}
      <div style={{ position: "absolute", left: "9%", right: "9%", bottom: "11%" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
          <Stat label="Spent" value={`$${v.spentUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          <Stat label="Average entry" value={formatPriceUsd(v.avgEntryUsd)} divider />
          <Stat label="Average exit" value={formatPriceUsd(v.avgExitUsd)} divider />
        </div>
      </div>

      {/* Product tag */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: "5.5%", textAlign: "center", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", color: "rgba(255,255,255,0.62)", textShadow: SHADOW }}>
        {PERCOLATOR_TAG.toUpperCase()}
      </div>
    </div>
  );
});

function Stat({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <div style={{ paddingLeft: divider ? 16 : 0, borderLeft: divider ? "1px solid rgba(255,255,255,0.14)" : undefined }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", lineHeight: 1.1, whiteSpace: "nowrap", textShadow: SHADOW }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.72)", marginTop: 3, textShadow: SHADOW }}>{label}</div>
    </div>
  );
}
