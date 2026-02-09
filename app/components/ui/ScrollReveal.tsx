"use client";

import { type ReactNode } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  direction?: "up" | "down" | "left" | "right";
  delay?: number;
  duration?: number;
  distance?: number;
  stagger?: number;
  className?: string;
}

export function ScrollReveal({ children, className = "" }: ScrollRevealProps) {
  return <div className={className}>{children}</div>;
}
