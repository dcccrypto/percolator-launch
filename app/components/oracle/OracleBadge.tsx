"use client";

import { FC, memo } from "react";
import type { OracleMode } from "@/lib/oraclePrice";

export type OracleBadgeStatus = "healthy" | "stale" | "error";

interface OracleBadgeProps {
  /** Oracle mode or explicit label */
  mode: OracleMode | "pool";
  /** Health status — determines color and icon when overriding mode color */
  status?: OracleBadgeStatus;
  /** Show the pulse animation (default: true for healthy) */
  pulse?: boolean;
  /** Optional className for outer element */
  className?: string;
}

interface BadgeStyle {
  borderColor: string;
  bgColor: string;
  label: string;
  icon: string;
}

function getBadgeStyle(mode: OracleMode | "pool", status?: OracleBadgeStatus): BadgeStyle {
  // Override for non-healthy states
  if (status === "stale") {
    return {
      borderColor: "#eab308",
      bgColor: "rgba(234,179,8,0.10)",
      label: "STALE",
      icon: "⚠",
    };
  }
  if (status === "error") {
    return {
      borderColor: "#ef4444",
      bgColor: "rgba(239,68,68,0.10)",
      label: "OFFLINE",
      icon: "✕",
    };
  }

  switch (mode) {
    case "hyperp":
      return {
        borderColor: "#22d3ee",
        bgColor: "rgba(34,211,238,0.10)",
        label: "HYPERP",
        icon: "⬡",
      };
    case "pyth-pinned":
      return {
        borderColor: "#a78bfa",
        bgColor: "rgba(167,139,250,0.10)",
        label: "PYTH",
        icon: "⬡",
      };
    case "admin":
      return {
        borderColor: "#fb923c",
        bgColor: "rgba(251,146,60,0.10)",
        label: "ADMIN",
        icon: "⬡",
      };
    case "pool":
      return {
        borderColor: "#38bdf8",
        bgColor: "rgba(56,189,248,0.10)",
        label: "POOL",
        icon: "⬡",
      };
  }
}

/**
 * P1 — Oracle badge pill component.
 *
 * A compact pill showing the oracle feed source with color-coded border.
 * Used on market cards, market list, and anywhere feed identity matters.
 *
 * 20px tall, font-mono 9px uppercase, hex icon prefix.
 */
export const OracleBadge: FC<OracleBadgeProps> = memo(function OracleBadge({
  mode,
  status = "healthy",
  pulse = true,
  className = "",
}) {
  const style = getBadgeStyle(mode, status);
  const showPulse = pulse && status === "healthy";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] ${className}`}
      style={{
        borderColor: style.borderColor,
        backgroundColor: style.bgColor,
        color: style.borderColor,
        fontFamily: "var(--font-mono)",
        lineHeight: "1",
        animation: showPulse
          ? "oracle-pulse 3s ease-in-out infinite"
          : undefined,
        // Inline the pulse keyframes as a CSS custom property for the animation
        ["--oracle-pulse-color" as string]: style.borderColor,
      }}
    >
      {/* Icon */}
      <HexIcon size={10} color={style.borderColor} icon={style.icon} />
      {/* Label */}
      {style.label}
    </span>
  );
});

/** Renders the badge icon — hex for normal, warning/error symbols for bad states */
function HexIcon({
  size = 10,
  color = "#22d3ee",
  icon = "⬡",
}: {
  size?: number;
  color?: string;
  icon?: string;
}) {
  // For non-hexagon icons, just render the text character
  if (icon !== "⬡") {
    return (
      <span style={{ fontSize: `${size}px`, color, lineHeight: "1" }}>
        {icon}
      </span>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block"
      style={{ verticalAlign: "middle" }}
    >
      <path d="M12 2l8.5 5v10L12 22l-8.5-5V7z" />
    </svg>
  );
}
