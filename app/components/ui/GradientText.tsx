"use client";

import { type ReactNode } from "react";

interface GradientTextProps {
  children: ReactNode;
  className?: string;
  animate?: boolean;
  /** "solana" = purple→cyan, "muted" = soft white→purple, "bright" = saturated purple→green,
   *  "headline" = the landing headline's "before anyone else" (also Earn and Stake titles) */
  variant?: "solana" | "muted" | "bright" | "headline";
}

// GH#1837: "muted" variant used to start at #E1E2E8 (near-white), which was
// invisible in light mode. Updated to start at #9945FF (same as solana variant)
// so it's readable on both dark and light backgrounds.
const GRADIENTS = {
  solana: "linear-gradient(135deg, #B97AFF 0%, #9945FF 40%, #14F195 100%)",
  muted: "linear-gradient(135deg, #9945FF 0%, #B97AFF 100%)",
  bright: "linear-gradient(135deg, #C4A0FF 0%, #9945FF 30%, #14F195 100%)",
  headline: "linear-gradient(110deg, #B97AFF 0%, #9945FF 35%, #14F195 100%)",
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
