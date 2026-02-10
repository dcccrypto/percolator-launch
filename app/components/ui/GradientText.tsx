"use client";

import { type ReactNode } from "react";

interface GradientTextProps {
  children: ReactNode;
  className?: string;
  animate?: boolean;
  /** "solana" = purple→cyan, "muted" = soft white→purple, "bright" = saturated purple→green */
  variant?: "solana" | "muted" | "bright";
}

const GRADIENTS = {
  solana: "linear-gradient(135deg, #B97AFF 0%, #9945FF 40%, #14F195 100%)",
  muted: "linear-gradient(135deg, #E1E2E8 0%, #9945FF 100%)",
  bright: "linear-gradient(135deg, #C4A0FF 0%, #9945FF 30%, #14F195 100%)",
};

export function GradientText({ children, className = "", variant = "solana" }: GradientTextProps) {
  return (
    <span
      className={`bg-clip-text text-transparent ${className}`}
      style={{
        backgroundImage: GRADIENTS[variant],
        backgroundSize: "100% 100%",
        WebkitBackgroundClip: "text",
      }}
    >
      {children}
    </span>
  );
}
