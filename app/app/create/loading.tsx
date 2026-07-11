import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function CreateLoading() {
  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-16 bg-grid pointer-events-none opacity-50" />

      <div className="relative mx-auto max-w-4xl px-4 pt-4 pb-10">
        {/* Back-nav row */}
        <div className="mb-4">
          <ShimmerSkeleton className="h-3 w-24" />
        </div>
        {/* Page header skeleton */}
        <div className="mb-8">
          <ShimmerSkeleton className="h-3 w-16 mb-2" />
          <ShimmerSkeleton className="h-8 w-56 mb-2" />
          <ShimmerSkeleton className="h-4 w-96 mb-2" />
          <ShimmerSkeleton className="h-4 w-80" />
        </div>

        {/* Wizard container skeleton */}
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-6">
          {/* Progress steps */}
          <div className="mb-8 flex items-center justify-between">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex flex-col items-center gap-2">
                <ShimmerSkeleton className="h-10 w-10 rounded-full" />
                <ShimmerSkeleton className="h-3 w-16" />
              </div>
            ))}
          </div>

          {/* Form content — single-column fields only, matching wizard step 1 layout (#866) */}
          <div className="space-y-5">
            <div>
              <ShimmerSkeleton className="h-4 w-32 mb-2" />
              <ShimmerSkeleton className="h-12 w-full" />
            </div>
            <div>
              <ShimmerSkeleton className="h-4 w-40 mb-2" />
              <ShimmerSkeleton className="h-12 w-full" />
            </div>
            <div>
              <ShimmerSkeleton className="h-4 w-28 mb-2" />
              <ShimmerSkeleton className="h-12 w-full" />
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-8 flex justify-between">
            <ShimmerSkeleton className="h-11 w-24" />
            <ShimmerSkeleton className="h-11 w-32" />
          </div>
        </div>
      </div>
    </div>
  );
}
