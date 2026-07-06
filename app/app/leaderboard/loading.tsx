import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function LeaderboardLoading() {
  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="max-w-3xl mx-auto px-4">
        <ShimmerSkeleton className="h-12 w-64 bg-[var(--panel-bg)] border border-[var(--border)] mb-2" />
        <ShimmerSkeleton className="h-4 w-48 bg-[var(--panel-bg)] border border-[var(--border)] mb-8" />
        <div className="flex gap-2 mb-6">
          <ShimmerSkeleton className="h-9 w-20 bg-[var(--panel-bg)] border border-[var(--border)]" />
          <ShimmerSkeleton className="h-9 w-24 bg-[var(--panel-bg)] border border-[var(--border)]" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <ShimmerSkeleton
            key={i}
            className="h-14 bg-[var(--panel-bg)] border border-[var(--border)] mb-1"
            style={{ opacity: 1 - i * 0.07 }}
          />
        ))}
      </div>
    </div>
  );
}
