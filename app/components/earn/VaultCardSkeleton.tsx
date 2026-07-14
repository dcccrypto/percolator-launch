import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';

/** Loading placeholder matching VaultCard's layout — shared so the route-level
 * loading.tsx, the VaultGrid's dynamic-import fallback, and VaultGrid's own
 * initial/pagination loading states render the identical skeleton. */
export function VaultCardSkeleton() {
  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-5 space-y-4 rounded-sm">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <ShimmerSkeleton className="w-8 h-8 rounded-full" />
          <div>
            <ShimmerSkeleton className="h-4 w-20 mb-1" />
            <ShimmerSkeleton className="h-3 w-16" />
          </div>
        </div>
        <div className="text-right space-y-1">
          <ShimmerSkeleton className="h-2.5 w-12" />
          <ShimmerSkeleton className="h-5 w-16" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[1, 2, 3, 4].map((j) => (
          <div key={j} className="space-y-1">
            <ShimmerSkeleton className="h-2 w-10" />
            <ShimmerSkeleton className="h-4.5 w-16" />
          </div>
        ))}
      </div>
      <ShimmerSkeleton className="h-2 w-full mt-2" />
      <div className="flex justify-between items-center pt-2 border-t border-[var(--border)]/30">
        <ShimmerSkeleton className="h-3.5 w-16" />
        <ShimmerSkeleton className="h-3.5 w-12" />
      </div>
    </div>
  );
}
