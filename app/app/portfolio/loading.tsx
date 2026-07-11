import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function PortfolioLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-5xl px-4 py-10 space-y-8">
        {/* Header */}
        <div>
          <ShimmerSkeleton className="h-3 w-16 mb-2" />
          <ShimmerSkeleton className="h-7 w-40 mb-2" />
          <ShimmerSkeleton className="h-4 w-56" />
        </div>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] p-4 hud-corners accent-top"
            >
              <ShimmerSkeleton className="h-3 w-20 mb-3" />
              <ShimmerSkeleton className="h-6 w-28 mb-2" />
              <ShimmerSkeleton className="h-3 w-16" />
            </div>
          ))}
        </div>

        {/* Position cards */}
        <div>
          <ShimmerSkeleton className="h-4 w-32 mb-4" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] p-4 hud-corners"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <ShimmerSkeleton className="h-8 w-8 rounded-full" />
                    <ShimmerSkeleton className="h-5 w-32" />
                  </div>
                  <ShimmerSkeleton className="h-6 w-16 rounded-sm" />
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[1, 2, 3, 4].map((j) => (
                    <div key={j}>
                      <ShimmerSkeleton className="h-3 w-14 mb-1.5" />
                      <ShimmerSkeleton className="h-4 w-20" />
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <ShimmerSkeleton className="h-8 w-24" />
                  <ShimmerSkeleton className="h-8 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Trade history */}
        <div>
          <ShimmerSkeleton className="h-4 w-28 mb-4" />
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <ShimmerSkeleton key={i} className="h-[44px]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
