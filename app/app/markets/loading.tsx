import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function MarketsLoading() {
  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-32 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 pt-4 pb-10">
        {/* Header skeleton */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <ShimmerSkeleton className="h-3 w-20 mb-2" />
            <ShimmerSkeleton className="h-8 w-48 mb-2" />
            <ShimmerSkeleton className="h-4 w-72" />
          </div>
          <ShimmerSkeleton className="h-10 w-36" />
        </div>

        {/* Search & Sort skeleton */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <ShimmerSkeleton className="flex-1 h-11" />
          <div className="flex gap-1 p-1">
            {[1, 2, 3, 4].map((i) => (
              <ShimmerSkeleton key={i} className="h-9 w-20" />
            ))}
          </div>
        </div>

        {/* Filters skeleton */}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <ShimmerSkeleton className="h-4 w-12" />
          <ShimmerSkeleton className="h-8 w-32" />
          <ShimmerSkeleton className="h-8 w-48" />
          <ShimmerSkeleton className="h-8 w-56" />
          <ShimmerSkeleton className="ml-auto h-4 w-24" />
        </div>

        {/* Table skeleton */}
        <div className="space-y-2">
          {/* Header */}
          <div className="grid grid-cols-[minmax(140px,2fr)_minmax(70px,1fr)_minmax(70px,1fr)_minmax(70px,1fr)_minmax(50px,0.7fr)] gap-3 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <ShimmerSkeleton key={i} className="h-3 w-full" />
            ))}
          </div>
          {/* Rows */}
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <ShimmerSkeleton key={i} className="h-[52px]" />
          ))}
        </div>
      </div>
    </div>
  );
}
