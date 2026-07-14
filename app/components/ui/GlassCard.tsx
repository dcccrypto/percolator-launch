"use client";

import { forwardRef, type ReactNode, type HTMLAttributes, type CSSProperties } from "react";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /**
   * @deprecated No-op. This batch removed the accent glow/bloom halo
   * (design-spine cleanup) — kept only so existing callers don't break.
   * Will be removed once all call sites drop the prop.
   */
  glow?: boolean;
  hover?: boolean;
  accent?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  /**
   * Surface depth. Controls how far the card's drop-shadow reads off the
   * page — a physical stand-in for "how close to the glass is this sitting".
   * Defaults to "sm" (standard card lift). Reach for "lg" on hero surfaces.
   * Reads the shared elevation/shadow scale (--shadow-* in globals.css) so
   * every surface in the app draws from one elevation system.
   */
  elevation?: "flat" | "sm" | "md" | "lg";
}

const paddingMap = { none: "", sm: "p-4", md: "p-6", lg: "p-8" };

// Elevation tokens: graduated drop-shadow depth per surface level, sourced
// from the shared --shadow-* scale in globals.css (not a locally-owned map)
// so cards and every other elevated surface agree on depth.
const elevationMap = {
  flat: "var(--shadow-none)",
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
} as const;

// Top inset hairline — a sliver of light catching the surface's top edge.
const TOP_HAIRLINE = "inset 0 1px 0 rgba(255,255,255,0.04)";

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  (
    {
      children,
      glow: _glow = false,
      hover = true,
      accent = false,
      padding = "md",
      elevation = "sm",
      className = "",
      style,
      ...props
    },
    ref
  ) => {
    const boxShadow = [TOP_HAIRLINE, elevationMap[elevation]].filter(Boolean).join(", ");

    const surfaceStyle: CSSProperties = {
      backgroundImage: "linear-gradient(180deg, var(--bg-elevated), var(--panel-bg))",
      borderTopColor: "var(--border-hover)",
      boxShadow,
      ...style,
    };

    return (
      <div
        ref={ref}
        style={surfaceStyle}
        className={[
          "rounded-sm",
          "border border-[var(--border)]",
          "hud-corners",
          hover
            ? "transition-all duration-200 hover:border-[var(--accent)]/20"
            : "",
          accent ? "accent-top overflow-hidden" : "",
          paddingMap[padding],
          className,
        ].filter(Boolean).join(" ")}
        {...props}
      >
        {children}
      </div>
    );
  }
);

GlassCard.displayName = "GlassCard";
