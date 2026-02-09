"use client";

import { type ReactNode, type ButtonHTMLAttributes } from "react";

interface GlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  asChild?: boolean;
}

export function GlowButton({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: GlowButtonProps) {
  const sizeClasses = {
    sm: "px-4 py-2 text-xs",
    md: "px-6 py-3 text-sm",
    lg: "px-10 py-4 text-base",
  };

  const variantClasses = {
    primary: "bg-[#00FFB2] text-[#09090b] font-bold hover:opacity-85 active:opacity-75",
    secondary: "bg-transparent border border-[#1a1a1f] text-[#fafafa] font-semibold hover:border-[#3f3f46] hover:bg-[#111113]",
    ghost: "bg-transparent text-[#71717a] font-medium hover:text-[#fafafa]",
  };

  return (
    <button
      className={[
        "inline-flex items-center justify-center rounded-[4px]",
        "transition-all duration-200",
        "focus:outline-none focus:ring-2 focus:ring-[#00FFB2]/30 focus:ring-offset-2 focus:ring-offset-[#09090b]",
        "disabled:opacity-40 disabled:pointer-events-none",
        sizeClasses[size],
        variantClasses[variant],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}
