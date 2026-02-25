"use client";

import { FC } from "react";

interface ModeSelectorProps {
  mode: "quick" | "manual";
  onModeChange: (mode: "quick" | "manual") => void;
}

/**
 * Quick Launch / Manual Setup tab toggle.
 * Prominent card-style selector displayed above the wizard steps.
 */
export const ModeSelector: FC<ModeSelectorProps> = ({ mode, onModeChange }) => {
  const tabs = [
    {
      key: "quick" as const,
      icon: "⚡",
      label: "QUICK LAUNCH",
      desc: "30-second deploy",
      detail: "Auto-detects oracle",
      badge: "Recommended",
    },
    {
      key: "manual" as const,
      icon: "⚙",
      label: "MANUAL SETUP",
      desc: "Full control",
      detail: "Pyth / HyperpEMA",
      badge: "Advanced users",
    },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-3">
      {tabs.map((tab) => {
        const active = mode === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onModeChange(tab.key)}
            className={`relative p-4 text-left transition-all duration-200 border ${
              active
                ? "border-[var(--accent)]/60 bg-[var(--accent)]/[0.06]"
                : "border-[var(--border)] bg-transparent hover:border-[var(--accent)]/20 hover:bg-[var(--accent)]/[0.02]"
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`text-[16px] ${
                  active ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                }`}
              >
                {tab.icon}
              </span>
              <span
                className={`text-[12px] font-semibold uppercase tracking-[0.1em] ${
                  active ? "text-white" : "text-[var(--text-secondary)]"
                }`}
              >
                {tab.label}
              </span>
            </div>
            <p
              className={`text-[11px] ${
                active ? "text-[var(--text-secondary)]" : "text-[var(--text-dim)]"
              }`}
            >
              {tab.desc}
            </p>
            <p
              className={`text-[10px] ${
                active ? "text-[var(--text-dim)]" : "text-[var(--text-dim)]"
              }`}
            >
              {tab.detail}
            </p>
            <span
              className={`mt-2 inline-block text-[9px] font-medium uppercase tracking-[0.1em] ${
                active ? "text-[var(--accent)]" : "text-[var(--text-dim)]"
              }`}
            >
              {tab.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
};
