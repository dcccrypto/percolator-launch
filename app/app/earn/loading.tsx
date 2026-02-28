export default function EarnLoading() {
  return (
    <div className="min-h-[calc(100vh-48px)]">
      {/* Header skeleton */}
      <div className="relative">
        <div className="mx-auto max-w-6xl px-4 pt-10 pb-6">
          <div className="h-4 w-16 bg-[var(--border)] rounded animate-pulse mb-3" />
          <div className="h-7 w-40 bg-[var(--border)] rounded animate-pulse mb-2" />
          <div className="h-4 w-80 bg-[var(--border)] rounded animate-pulse mb-6" />

          <div className="grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-[var(--panel-bg)] p-5">
                <div className="h-3 w-20 bg-[var(--border)] rounded animate-pulse mb-2" />
                <div className="h-7 w-28 bg-[var(--border)] rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Content skeleton */}
      <div className="mx-auto max-w-6xl px-4 pb-16">
        <div className="h-20 bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse mb-8" />

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-[280px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse"
              />
            ))}
          </div>
          <div className="lg:col-span-1 space-y-6">
            <div className="h-[320px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse" />
            <div className="h-[280px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}
