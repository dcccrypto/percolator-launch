import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function VaultDetailLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)]">
      <div className="mx-auto max-w-5xl px-4 pt-8 pb-16">
        {/* Breadcrumb */}
        <ShimmerSkeleton className="h-4 w-40 mb-6" />

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <ShimmerSkeleton className="w-12 h-12 rounded-full shrink-0" />
            <div className="space-y-2">
              <ShimmerSkeleton className="h-6 w-48" />
              <ShimmerSkeleton className="h-3.5 w-32" />
            </div>
          </div>
          <div className="flex items-center gap-6 self-end sm:self-auto">
            <div className="text-right space-y-1.5">
              <ShimmerSkeleton className="h-3 w-16" />
              <ShimmerSkeleton className="h-7 w-20" />
            </div>
            <div className="text-right space-y-1.5">
              <ShimmerSkeleton className="h-3 w-12" />
              <ShimmerSkeleton className="h-6 w-16" />
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-px border border-[var(--border)] bg-[var(--border)] mb-6">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-[var(--panel-bg)] p-4">
              <ShimmerSkeleton className="h-3 w-16 mb-2" />
              <ShimmerSkeleton className="h-5 w-20" />
            </div>
          ))}
        </div>

        {/* OI meter */}
        <ShimmerSkeleton className="h-20 bg-[var(--panel-bg)] border border-[var(--border)] mb-8" />

        {/* Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LP Position dashboard skeleton */}
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 space-y-5">
            <div className="flex items-center justify-between">
              <ShimmerSkeleton className="h-4 w-32" />
              <ShimmerSkeleton className="h-4.5 w-12" />
            </div>
            <div className="p-4 bg-[var(--bg)] border border-[var(--border)] rounded-sm space-y-2">
              <ShimmerSkeleton className="h-3 w-24" />
              <div className="flex items-baseline gap-2">
                <ShimmerSkeleton className="h-7 w-32" />
                <ShimmerSkeleton className="h-4 w-8" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="space-y-1.5">
                  <ShimmerSkeleton className="h-3 w-20" />
                  <ShimmerSkeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </div>

          {/* Deposit / Withdraw skeleton */}
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden p-5 space-y-5">
            <div className="flex border-b border-[var(--border)] -mx-5 -mt-5">
              <ShimmerSkeleton className="flex-1 h-11 rounded-none" />
              <ShimmerSkeleton className="flex-1 h-11 border-l border-[var(--border)] rounded-none" />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <ShimmerSkeleton className="h-3 w-28" />
                <ShimmerSkeleton className="h-3 w-16" />
              </div>
              <ShimmerSkeleton className="h-12 w-full" />
            </div>
            <div className="flex gap-2">
              {[25, 50, 75, 100].map(pct => (
                <ShimmerSkeleton key={pct} className="h-7 flex-1" />
              ))}
            </div>
            <ShimmerSkeleton className="h-10 w-full mt-2" />
          </div>
        </div>
      </div>
    </div>
  );
}
