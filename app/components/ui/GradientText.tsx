"use client";

import { useRef, useEffect, type ReactNode } from "react";
import gsap from "gsap";

interface GradientTextProps {
  children: ReactNode;
  className?: string;
  animate?: boolean;
}

export function GradientText({ children, className = "", animate = true }: GradientTextProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!animate || !ref.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.to(ref.current, {
      backgroundPosition: "200% center",
      duration: 4,
      ease: "none",
      repeat: -1,
    });
  }, [animate]);

  return (
    <span
      ref={ref}
      className={`bg-gradient-to-r from-[#F0F4FF] via-[#00FFB2] to-[#7B61FF] bg-[length:200%_100%] bg-clip-text text-transparent ${className}`}
    >
      {children}
    </span>
  );
}
