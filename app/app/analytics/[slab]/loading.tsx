import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

/**
 * Route-level loading skeleton for /analytics/[slab]. Mirrors the page's
 * container (max-w-[1400px]) and its responsive analytics-card grid so the
 * heavy analytics route shows instant feedback without a layout jump.
 */
export default function AnalyticsLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)]">
      <div className="mx-auto max-w-[1400px] px-4 py-4 lg:px-6">
        <div className="mb-4 flex items-center gap-3">
          <ShimmerSkeleton className="h-8 w-8 rounded-full" />
          <ShimmerSkeleton className="h-6 w-40" />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5 hud-corners">
              <ShimmerSkeleton className="h-4 w-28" />
              <ShimmerSkeleton className="h-8 w-24" />
              <ShimmerSkeleton className="h-3 w-full" />
              <ShimmerSkeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
