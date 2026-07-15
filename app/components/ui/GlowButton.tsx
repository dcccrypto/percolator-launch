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
    primary: [
      "border border-[var(--accent)]/40 text-[var(--accent)] bg-transparent font-semibold",
      "hud-btn-corners",
      "hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08]",
      "active:scale-[0.98]",
    ].join(" "),
    secondary: [
      "border border-[var(--border)] text-[var(--text-secondary)] bg-transparent font-medium",
      "hud-btn-corners",
      "hover:border-[var(--accent)]/40 hover:text-[var(--text)]",
      "active:scale-[0.98]",
    ].join(" "),
    ghost: [
      "bg-transparent text-[var(--text-secondary)] font-medium",
      "hover:text-[var(--text)] hover:bg-[var(--accent)]/[0.04]",
    ].join(" "),
  };

  return (
    <button
      className={[
        "inline-flex items-center justify-center rounded-sm",
        "transition-all duration-200",
        "focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/20 focus:ring-offset-2 focus:ring-offset-[var(--bg)]",
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
