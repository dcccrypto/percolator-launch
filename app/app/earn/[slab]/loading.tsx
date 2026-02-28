export default function VaultDetailLoading() {
  return (
    <div className="min-h-[calc(100vh-48px)]">
      <div className="mx-auto max-w-5xl px-4 pt-8 pb-16">
        {/* Breadcrumb */}
        <div className="h-4 w-40 bg-[var(--border)] rounded animate-pulse mb-6" />

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-full bg-[var(--border)] animate-pulse" />
          <div>
            <div className="h-6 w-48 bg-[var(--border)] rounded animate-pulse mb-2" />
            <div className="h-3 w-32 bg-[var(--border)] rounded animate-pulse" />
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-px border border-[var(--border)] bg-[var(--border)] mb-6">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-[var(--panel-bg)] p-4">
              <div className="h-3 w-16 bg-[var(--border)] rounded animate-pulse mb-2" />
              <div className="h-5 w-20 bg-[var(--border)] rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* OI meter */}
        <div className="h-20 bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse mb-8" />

        {/* Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-[350px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse" />
          <div className="h-[400px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm animate-pulse" />
        </div>
      </div>
    </div>
  );
}
