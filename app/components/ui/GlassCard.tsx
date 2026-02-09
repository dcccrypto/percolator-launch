"use client";

import { forwardRef, type ReactNode, type HTMLAttributes } from "react";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  glow?: boolean;
  hover?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddingMap = { none: "", sm: "p-4", md: "p-6", lg: "p-8" };

export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ children, glow = false, hover = true, padding = "md", className = "", ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={[
          "relative overflow-hidden rounded-2xl",
          "border border-white/[0.06]",
          "bg-white/[0.03] backdrop-blur-xl",
          glow ? "shadow-[0_0_30px_rgba(0,255,178,0.06)]" : "shadow-[0_0_20px_rgba(0,0,0,0.3)]",
          hover ? "glass-hover" : "",
          paddingMap[padding],
          "noise",
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
