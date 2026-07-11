import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

/**
 * Route-level loading skeleton for /dashboard. Mirrors the page's wide
 * container (max-w-[1440px]) and its header-bar + chart + stat-cards structure
 * so navigation shows instant feedback without a layout jump on swap-in.
 */
export default function DashboardLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      <div className="relative mx-auto max-w-[1440px] space-y-4 px-4 py-6 lg:px-6">
        {/* Account header bar */}
        <div className="flex h-14 items-center justify-between rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4">
          <div className="flex items-center gap-3">
            <ShimmerSkeleton className="h-8 w-8 rounded-full" />
            <ShimmerSkeleton className="h-4 w-32" />
          </div>
          <ShimmerSkeleton className="h-5 w-24" />
        </div>
        {/* PnL chart + side panel */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <div className="h-[380px] rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]" />
          <div className="h-[380px] rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]" />
        </div>
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-4">
              <ShimmerSkeleton className="h-3 w-20" />
              <ShimmerSkeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
        {/* Trade history */}
        <div className="h-64 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]" />
      </div>
    </div>
  );
}
