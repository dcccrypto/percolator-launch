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
          "rounded-[4px]",
          "border border-[#1a1a1f]",
          "bg-[#111113]",
          hover ? "transition-colors duration-200 hover:bg-[#161618]" : "",
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
