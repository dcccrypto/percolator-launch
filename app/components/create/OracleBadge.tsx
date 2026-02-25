"use client";

import { FC } from "react";

interface OracleBadgeProps {
  type: "pyth" | "dex" | "admin" | "loading" | "none";
  label?: string;
  feedId?: string;
}

/**
 * Auto-detection status pill for oracle source.
 * Shows Pyth (cyan), DEX (green), Admin (amber), or No oracle (muted).
 */
export const OracleBadge: FC<OracleBadgeProps> = ({ type, label, feedId }) => {
  if (type === "loading") {
    return (
      <div className="flex items-center gap-2 border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
        <span className="h-3.5 w-3.5 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
        <span className="text-[11px] text-[var(--text-muted)]">Detecting oracle source...</span>
      </div>
    );
  }

  if (type === "none") {
    return (
      <div className="flex items-center gap-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] px-3 py-2.5">
        <span className="text-[12px]">⚠</span>
        <span className="text-[11px] text-[var(--warning)]">
          No oracle detected — admin mode enabled. You set the initial price.
        </span>
      </div>
    );
  }

  const config = {
    pyth: {
      icon: "📡",
      borderColor: "border-[var(--accent)]/20",
      bgColor: "bg-[var(--accent)]/[0.04]",
      textColor: "text-[var(--accent)]",
      prefix: "Pyth feed:",
    },
    dex: {
      icon: "🔗",
      borderColor: "border-[var(--long)]/20",
      bgColor: "bg-[var(--long)]/[0.04]",
      textColor: "text-[var(--long)]",
      prefix: "DEX pool:",
    },
    admin: {
      icon: "🔧",
      borderColor: "border-[var(--warning)]/20",
      bgColor: "bg-[var(--warning)]/[0.04]",
      textColor: "text-[var(--warning)]",
      prefix: "Admin oracle:",
    },
  }[type];

  return (
    <div className={`flex items-center gap-2 border ${config.borderColor} ${config.bgColor} px-3 py-2.5`}>
      <span className="text-[12px]">{config.icon}</span>
      <div className="min-w-0 flex-1">
        <span className={`text-[11px] font-medium ${config.textColor}`}>
          {config.prefix} {label || "Unknown"}
        </span>
        {feedId && (
          <p className="text-[10px] text-[var(--text-dim)] font-mono truncate mt-0.5">
            {feedId.length > 20 ? `${feedId.slice(0, 10)}...${feedId.slice(-6)}` : feedId}
          </p>
        )}
      </div>
    </div>
  );
};
