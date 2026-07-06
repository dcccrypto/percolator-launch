import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function EarnLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)]">
      {/* Header skeleton */}
      <div className="relative">
        <div className="mx-auto max-w-6xl px-4 pt-10 pb-6">
          <ShimmerSkeleton className="h-4 w-16 mb-3" />
          <ShimmerSkeleton className="h-7 w-40 mb-2" />
          <ShimmerSkeleton className="h-4 w-80 mb-6" />

          <div className="grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-[var(--panel-bg)] p-5">
                <ShimmerSkeleton className="h-3 w-20 mb-2" />
                <ShimmerSkeleton className="h-7 w-28" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Content skeleton */}
      <div className="mx-auto max-w-6xl px-4 pb-16">
        <ShimmerSkeleton className="h-20 bg-[var(--panel-bg)] border border-[var(--border)] mb-8" />

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <ShimmerSkeleton
                key={i}
                className="h-[280px] bg-[var(--panel-bg)] border border-[var(--border)]"
              />
            ))}
          </div>
          <div className="lg:col-span-1 space-y-6">
            <ShimmerSkeleton className="h-[320px] bg-[var(--panel-bg)] border border-[var(--border)]" />
            <ShimmerSkeleton className="h-[280px] bg-[var(--panel-bg)] border border-[var(--border)]" />
          </div>
        </div>
      </div>
    </div>
  );
}
