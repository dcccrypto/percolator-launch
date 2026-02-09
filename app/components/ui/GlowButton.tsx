"use client";

import { useRef, type ReactNode, type ButtonHTMLAttributes } from "react";

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
  const btnRef = useRef<HTMLButtonElement>(null);

  const sizeClasses = {
    sm: "px-4 py-2 text-xs",
    md: "px-6 py-3 text-sm",
    lg: "px-10 py-4 text-base",
  };

  const variantClasses = {
    primary: [
      "bg-gradient-to-r from-[#00FFB2] to-[#00d4aa]",
      "text-[#06080d] font-bold",
      "hover:shadow-[0_0_40px_rgba(0,255,178,0.25)]",
      "hover:from-[#00FFB2] hover:to-[#7B61FF]",
      "active:scale-[0.98]",
    ].join(" "),
    secondary: [
      "bg-white/[0.05] border border-white/[0.08]",
      "text-[#F0F4FF] font-semibold",
      "hover:bg-white/[0.08] hover:border-[#00FFB2]/20",
      "hover:shadow-[0_0_30px_rgba(0,255,178,0.08)]",
      "active:scale-[0.98]",
    ].join(" "),
    ghost: [
      "bg-transparent",
      "text-[#8B95B0] font-medium",
      "hover:text-[#F0F4FF] hover:bg-white/[0.04]",
      "active:scale-[0.98]",
    ].join(" "),
  };

  return (
    <button
      ref={btnRef}
      className={[
        "relative inline-flex items-center justify-center rounded-xl",
        "transition-all duration-200 ease-out",
        "focus:outline-none focus:ring-2 focus:ring-[#00FFB2]/30 focus:ring-offset-2 focus:ring-offset-[#06080d]",
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
