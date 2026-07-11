import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

/**
 * Route-level loading skeleton for /stake. Mirrors the page's container
 * (max-w-[1100px]) and hero + stats structure so navigation shows instant
 * feedback and the real page swaps in without a layout jump.
 */
export default function StakeLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)]">
      <div className="mx-auto max-w-[1100px] px-6 py-10">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_380px] lg:items-center lg:gap-12">
          <div>
            <ShimmerSkeleton className="mb-3 h-3 w-24" />
            <ShimmerSkeleton className="mb-4 h-9 w-64" />
            <ShimmerSkeleton className="mb-2 h-4 w-full max-w-[520px]" />
            <ShimmerSkeleton className="h-4 w-3/4 max-w-[520px]" />
          </div>
          <div className="space-y-4 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
            <ShimmerSkeleton className="h-4 w-32" />
            <ShimmerSkeleton className="h-11 w-full" />
            <ShimmerSkeleton className="h-11 w-full" />
          </div>
        </div>
        <div className="mt-10 grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-2 bg-[var(--panel-bg)] p-5">
              <ShimmerSkeleton className="h-3 w-20" />
              <ShimmerSkeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
