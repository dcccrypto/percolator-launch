"use client";

import { FC, useEffect, useCallback, useRef, useState } from "react";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useLivePrice } from "@/hooks/useLivePrice";
import { detectOracleMode } from "@/lib/oraclePrice";
import { OracleBadge } from "./OracleBadge";
import { useOraclePublishers, type PublisherInfo } from "@/hooks/useOraclePublishers";

interface OracleDetailsPanelProps {
  onClose: () => void;
}

/**
 * P1 — Oracle details slide-in panel.
 *
 * Desktop: slides in from the right edge, 320px wide.
 * Mobile: bottom sheet, 60% screen height, drag to dismiss.
 *
 * Shows: price feed, freshness bar, feed source, fallback chain,
 * publisher list, and 24h statistics.
 */
export const OracleDetailsPanel: FC<OracleDetailsPanelProps> = ({ onClose }) => {
  const { config } = useSlabState();
  const { priceUsd } = useLivePrice();
  const {
    mode,
    modeLabel,
    elapsedSecs,
    level,
    color,
  } = useOracleFreshness();

  const {
    publisherCount,
    publisherTotal,
    publishers: dynamicPublishers,
  } = useOraclePublishers();

  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isClosing, setIsClosing] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(onClose, 200);
  }, [onClose]);

  // Close on overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) handleClose();
    },
    [handleClose]
  );

  const priceText = priceUsd != null
    ? `$${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd < 1 ? priceUsd.toFixed(4) : priceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";

  const elapsedText =
    elapsedSecs < 60
      ? `Updated ${elapsedSecs}s ago`
      : `Updated ${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s ago`;

  // Freshness bar percentage (drains from 100% → 0% over 30s)
  const freshnessBarPct = Math.max(0, Math.min(100, ((30 - elapsedSecs) / 30) * 100));

  const fallbackChain = getFallbackChain(mode);

  // Dynamic publisher data from Pythnet/oracle bridge (PERC-371)
  const publishers = dynamicPublishers;

  return (
    <div
      ref={overlayRef}
      className={`fixed inset-0 z-50 ${isClosing ? "animate-[fade-out_200ms_ease-in_forwards]" : "animate-[fade-in_200ms_ease-out]"}`}
      onClick={handleOverlayClick}
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
    >
      {/* Desktop: right slide-in panel */}
      <div
        ref={panelRef}
        className={`
          fixed right-0 top-0 h-full w-[320px] overflow-y-auto
          border-l border-[var(--border)]/50
          max-lg:hidden
          ${isClosing
            ? "animate-[slide-out-right_200ms_ease-in_forwards]"
            : "animate-[slide-in-right_200ms_ease-out]"
          }
        `}
        style={{
          backgroundColor: "var(--bg)",
          backdropFilter: "blur(20px)",
        }}
      >
        <PanelContent
          mode={mode}
          modeLabel={modeLabel}
          priceText={priceText}
          elapsedText={elapsedText}
          elapsedSecs={elapsedSecs}
          level={level}
          color={color}
          freshnessBarPct={freshnessBarPct}
          publisherCount={publisherCount}
          publisherTotal={publisherTotal}
          fallbackChain={fallbackChain}
          publishers={publishers}
          onClose={handleClose}
        />
      </div>

      {/* Mobile: bottom sheet */}
      <div
        className={`
          fixed bottom-0 left-0 right-0 h-[60vh] overflow-y-auto
          rounded-t-lg border-t border-[var(--border)]/50
          lg:hidden
          ${isClosing
            ? "animate-[slide-out-bottom_200ms_ease-in_forwards]"
            : "animate-[slide-in-bottom_200ms_ease-out]"
          }
        `}
        style={{
          backgroundColor: "var(--bg)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Drag handle */}
        <div className="flex justify-center py-2">
          <div
            className="h-1 w-8 rounded-full"
            style={{ backgroundColor: "var(--border)" }}
          />
        </div>
        <PanelContent
          mode={mode}
          modeLabel={modeLabel}
          priceText={priceText}
          elapsedText={elapsedText}
          elapsedSecs={elapsedSecs}
          level={level}
          color={color}
          freshnessBarPct={freshnessBarPct}
          publisherCount={publisherCount}
          publisherTotal={publisherTotal}
          fallbackChain={fallbackChain}
          publishers={publishers}
          onClose={handleClose}
        />
      </div>
    </div>
  );
};

/** Shared panel body used by both desktop and mobile layouts */
function PanelContent({
  mode,
  modeLabel,
  priceText,
  elapsedText,
  elapsedSecs,
  level,
  color,
  freshnessBarPct,
  publisherCount,
  publisherTotal,
  fallbackChain,
  publishers,
  onClose,
}: {
  mode: string | null;
  modeLabel: string;
  priceText: string;
  elapsedText: string;
  elapsedSecs: number;
  level: string;
  color: string;
  freshnessBarPct: number;
  publisherCount: number | null;
  publisherTotal: number | null;
  fallbackChain: string[];
  publishers: PublisherInfo[];
  onClose: () => void;
}) {
  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HexIconLarge />
          <div>
            <h3
              className="text-[13px] font-medium"
              style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}
            >
              Oracle Feed
            </h3>
            <p
              className="text-[10px] uppercase tracking-[0.08em]"
              style={{ color: "var(--text-secondary)" }}
            >
              {modeLabel} Mode
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>

      {/* Divider */}
      <div className="h-px" style={{ backgroundColor: "var(--border)" }} />

      {/* Price Feed */}
      <Section title="Price Feed">
        <div className="flex items-baseline justify-between">
          <span
            className="text-lg font-bold tabular-nums"
            style={{
              fontFamily: "var(--font-mono)",
              color: level === "stale" ? "var(--text-muted)" : "var(--text)",
            }}
          >
            {priceText}
          </span>
          <span
            className="text-[10px] tabular-nums"
            style={{ fontFamily: "var(--font-mono)", color }}
          >
            {elapsedText}
          </span>
        </div>
        {/* Freshness bar */}
        <div className="mt-2 h-1 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--border)" }}>
          <div
            className="h-full rounded-full transition-all duration-1000 ease-linear"
            style={{
              width: `${freshnessBarPct}%`,
              backgroundColor: color,
            }}
          />
        </div>
        <p
          className="mt-1 text-[9px] uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          Freshness
        </p>
      </Section>

      {/* Feed Source */}
      <Section title="Feed Source">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              Mode
            </span>
            {mode && (
              <OracleBadge
                mode={mode as "hyperp" | "pyth-pinned" | "admin"}
                pulse={false}
              />
            )}
          </div>
          {fallbackChain.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Fallback
              </span>
              <span
                className="text-[10px] tabular-nums"
                style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}
              >
                {fallbackChain.join(" → ")}
              </span>
            </div>
          )}
        </div>
      </Section>

      {/* Publishers */}
      {publishers.length > 0 && (
        <Section
          title={`Publishers (${publisherCount ?? "?"}/${publisherTotal ?? "?"} active)`}
        >
          <div className="space-y-1">
            {publishers.map((pub) => (
              <div
                key={pub.key ?? pub.name}
                className="flex items-center justify-between py-0.5"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-[6px] w-[6px] rounded-full"
                    style={{
                      backgroundColor:
                        pub.status === "active"
                          ? "#22c55e"
                          : pub.status === "degraded"
                          ? "#eab308"
                          : "#454B5F",
                    }}
                  />
                  <span
                    className="text-[11px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--text)",
                    }}
                  >
                    {pub.name}
                  </span>
                </div>
                <span
                  className="text-[9px] uppercase tracking-[0.08em]"
                  style={{
                    color:
                      pub.status === "active"
                        ? "var(--text-secondary)"
                        : pub.status === "degraded"
                        ? "#eab308"
                        : "var(--text-dim)",
                  }}
                >
                  {pub.status === "active"
                    ? "verified"
                    : pub.status}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 24h Statistics */}
      <Section title="24h Statistics">
        <div className="grid grid-cols-2 gap-2">
          <StatItem label="Max deviation" value="0.023%" />
          <StatItem label="Uptime" value="99.97%" />
          <StatItem label="Pushes/hour" value="1,847" />
          <StatItem label="Last anomaly" value="4d ago" />
        </div>
      </Section>
    </div>
  );
}

/** Section wrapper with title */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p
        className="mb-1.5 text-[9px] uppercase tracking-[0.1em]"
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

/** Stat grid item */
function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p
        className="text-[9px] uppercase tracking-[0.08em]"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </p>
      <p
        className="text-[12px] tabular-nums"
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
        }}
      >
        {value}
      </p>
    </div>
  );
}

/** Large hexagon icon for the panel header */
function HexIconLarge() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#22d3ee"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l8.5 5v10L12 22l-8.5-5V7z" />
    </svg>
  );
}

/** Get fallback chain for a given mode */
function getFallbackChain(mode: string | null): string[] {
  switch (mode) {
    case "hyperp":
      return ["Pyth", "Chainlink"];
    case "pyth-pinned":
      return ["Chainlink"];
    case "admin":
      return [];
    default:
      return [];
  }
}

/* getMockPublishers removed in PERC-371 — publisher data now fetched dynamically */
