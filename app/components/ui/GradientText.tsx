"use client";

import { type ReactNode } from "react";

interface GradientTextProps {
  children: ReactNode;
  className?: string;
  animate?: boolean;
}

export function GradientText({ children, className = "" }: GradientTextProps) {
  return <span className={`text-white ${className}`}>{children}</span>;
}
