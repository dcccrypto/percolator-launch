import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

export default function TradingPageLoading() {
  return (
    <div className="mx-auto max-w-[1920px] min-h-[calc(100dvh-48px)]">
      {/* Mobile: Sticky header skeleton */}
      <div className="sticky top-0 z-30 border-b border-[var(--border)]/50 bg-[var(--bg)]/95 px-3 py-2 backdrop-blur-sm lg:hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShimmerSkeleton className="h-8 w-8 rounded-full" />
            <ShimmerSkeleton className="h-5 w-32" />
          </div>
          <div className="flex items-center gap-2">
            <ShimmerSkeleton className="h-6 w-20" />
            <ShimmerSkeleton className="h-6 w-16" />
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <ShimmerSkeleton className="h-4 w-24" />
          <ShimmerSkeleton className="h-4 w-8" />
        </div>
      </div>

      {/* Desktop: Header skeleton */}
      <div className="hidden lg:flex items-start justify-between px-4 py-2 gap-3 border-b border-[var(--border)]/30">
        <div className="min-w-0">
          <ShimmerSkeleton className="h-3 w-16 mb-2" />
          <div className="flex items-center gap-2.5">
            <ShimmerSkeleton className="h-12 w-12 rounded-full" />
            <ShimmerSkeleton className="h-7 w-40" />
          </div>
          <div className="mt-1 flex items-center gap-3">
            <ShimmerSkeleton className="h-4 w-28" />
            <ShimmerSkeleton className="h-5 w-16" />
            <ShimmerSkeleton className="h-4 w-12" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ShimmerSkeleton className="h-6 w-20" />
          <ShimmerSkeleton className="h-8 w-24" />
        </div>
      </div>

      {/* Mobile layout skeleton — mirrors the real mobile stack: chart,
          positions dock (2 tabs: Positions / Trades), bottom order-sheet
          trigger. The order ticket itself is a tap-to-open bottom sheet, so
          it isn't shown inline here. */}
      <div className="flex flex-col gap-1.5 px-2 pt-2 pb-4 lg:hidden">
        {/* Chart */}
        <ShimmerSkeleton className="h-[360px] w-full" />
        {/* Positions dock — 2 tabs */}
        <div className="h-[45vh] min-h-[280px] border border-[var(--border)]">
          <div className="flex border-b border-[var(--border)]/50">
            {[1, 2].map((i) => (
              <ShimmerSkeleton key={i} className="h-8 w-24 rounded-none" />
            ))}
          </div>
          <ShimmerSkeleton className="h-[calc(100%-2rem)] w-full rounded-none" />
        </div>
        {/* Bottom order-ticket trigger bar */}
        <ShimmerSkeleton className="h-10 w-full" />
      </div>

      {/* Desktop layout skeleton — mirrors the named grid in page.tsx: chart
          (left, dominant), order-ticket rail (right, 340px, spans both rows),
          positions dock (bottom-left, 2 tabs). */}
      <div
        className="hidden lg:grid gap-3 px-4 lg:px-6 pb-3 pt-2 min-h-[calc(100dvh-150px)]"
        style={{
          gridTemplateAreas: '"Chart OrderTicket" "PositionsDock OrderTicket"',
          gridTemplateColumns: "minmax(0,1fr) 340px",
          gridTemplateRows: "minmax(0,1fr) minmax(220px,340px)",
        }}
      >
        {/* Chart */}
        <div style={{ gridArea: "Chart" }} className="min-w-0 min-h-0">
          <ShimmerSkeleton className="h-full w-full" />
        </div>

        {/* Order-ticket rail — single framed panel (order ticket + NFT panel) */}
        <div style={{ gridArea: "OrderTicket" }} className="border border-[var(--border)] p-3.5 space-y-3">
          {/* Long / Short segmented */}
          <div className="flex gap-1">
            <ShimmerSkeleton className="h-9 flex-1" />
            <ShimmerSkeleton className="h-9 flex-1" />
          </div>
          {/* Size input */}
          <ShimmerSkeleton className="h-10 w-full" />
          {/* Quick-fill chips */}
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((i) => (
              <ShimmerSkeleton key={i} className="h-6 flex-1" />
            ))}
          </div>
          {/* Leverage slider */}
          <ShimmerSkeleton className="h-8 w-full" />
          {/* Receipt rows */}
          <div className="space-y-2 pt-1">
            {[1, 2, 3, 4].map((i) => (
              <ShimmerSkeleton key={i} className="h-3.5 w-full" />
            ))}
          </div>
          {/* Submit */}
          <ShimmerSkeleton className="h-11 w-full" />
        </div>

        {/* Positions dock — 2 tabs (Positions / Trades) */}
        <div style={{ gridArea: "PositionsDock" }} className="min-w-0 border border-[var(--border)]">
          <div className="flex border-b border-[var(--border)]/50">
            {[1, 2].map((i) => (
              <ShimmerSkeleton key={i} className="h-9 w-28 rounded-none" />
            ))}
          </div>
          <ShimmerSkeleton className="h-[200px] w-full rounded-none" />
        </div>
      </div>
    </div>
  );
}
