"use client";

import { forwardRef, type ReactNode, type HTMLAttributes } from "react";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  glow?: boolean;
  hover?: boolean;
  accent?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingMap = { none: "", sm: "p-4", md: "p-6", lg: "p-8" };

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ children, glow = false, hover = true, accent = false, padding = "md", className = "", ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={[
          "rounded-sm",
          "border border-[var(--border)]",
          "bg-[var(--panel-bg)]",
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
