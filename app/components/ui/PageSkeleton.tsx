"use client";

import { ShimmerSkeleton } from "./ShimmerSkeleton";

interface PageSkeletonProps {
  /** Heading label width (e.g., "w-16") */
  labelWidth?: string;
  /** Heading title width (e.g., "w-48") */
  titleWidth?: string;
  /** Subtitle width */
  subtitleWidth?: string;
  /** Number of content block rows */
  rows?: number;
  /** Show a form layout */
  form?: boolean;
  /** Show card grid (2-col or 3-col) */
  cards?: number;
  /** Outer container max-width class (e.g. "max-w-5xl"). */
  maxWidth?: string;
}

/**
 * Reusable page-level loading skeleton that matches the Percolator
 * design system. Used in Next.js loading.tsx files for instant
 * visual feedback while the page chunk loads.
 */
export function PageSkeleton({
  labelWidth = "w-16",
  titleWidth = "w-48",
  subtitleWidth = "w-64",
  rows = 6,
  form = false,
  cards = 0,
  maxWidth = "max-w-4xl",
}: PageSkeletonProps) {
  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className={`relative mx-auto ${maxWidth} px-4 py-10 space-y-8`}>
        {/* Page header */}
        <div>
          <ShimmerSkeleton className={`h-3 ${labelWidth} mb-2`} />
          <ShimmerSkeleton className={`h-7 ${titleWidth} mb-2`} />
          <ShimmerSkeleton className={`h-4 ${subtitleWidth}`} />
        </div>

        {/* Card grid */}
        {cards > 0 && (
          <div className={`grid gap-3 ${cards >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
            {Array.from({ length: cards }).map((_, i) => (
              <div
                key={i}
                className="rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] p-5 hud-corners"
              >
                <ShimmerSkeleton className="h-4 w-24 mb-3" />
                <ShimmerSkeleton className="h-3 w-full mb-2" />
                <ShimmerSkeleton className="h-3 w-3/4" />
              </div>
            ))}
          </div>
        )}

        {/* Form layout */}
        {form && (
          <div className="rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] p-6 hud-corners space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i}>
                <ShimmerSkeleton className="h-3 w-20 mb-2" />
                <ShimmerSkeleton className="h-10 w-full" />
              </div>
            ))}
            <ShimmerSkeleton className="h-10 w-32 mt-2" />
          </div>
        )}

        {/* Content rows */}
        {!form && rows > 0 && (
          <div className="space-y-2">
            {Array.from({ length: rows }).map((_, i) => (
              <ShimmerSkeleton key={i} className="h-[48px]" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
