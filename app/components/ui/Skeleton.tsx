"use client";

import { FC } from "react";

export const Skeleton: FC<{ className?: string }> = ({ className = "" }) => (
  <div className={`animate-pulse rounded bg-[#1a1a2e] ${className}`} />
);
