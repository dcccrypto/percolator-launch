"use client";

/**
 * Position + PnL badges drawn over the chart. Shared by the TradingView chart
 * (components/trade/tv/TvChartPanel.tsx) and the lightweight-charts fallback
 * (TradingChart.tsx) — the math and look are identical on both.
 */
import { useRef, useState } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";

// Phase 2: compact position summary shown on chart when wallet is connected
interface PositionSummaryProps {
  slabAddress: string;
}

export function PositionSummary({ slabAddress }: PositionSummaryProps) {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);

  if (!userAccount) return null;
  const { account } = userAccount;
  if (account.positionSize === 0n) return null;

  const isLong = account.positionSize > 0n;
  const direction = isLong ? "LONG" : "SHORT";
  const dirColor = isLong ? "text-[var(--long)]" : "text-[var(--short)]";

  return (
    <div className="flex items-center gap-1.5 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/90 px-2 py-1 backdrop-blur-sm">
      <span className={`text-[9px] font-bold uppercase tracking-[0.12em] ${dirColor}`}>{direction}</span>
      <span className="text-[9px] text-[var(--text-secondary)]">position open</span>
    </div>
  );
}

/** Draggable stack for the position + PnL badges.
 *
 *  The badges default to the chart's top-right, exactly where the price axis
 *  labels and recent candles live — they routinely cover the very data the
 *  user is watching. This wrapper keeps them as ONE unit (they always move
 *  together) and lets the user drag the pair anywhere inside the chart.
 *  Position is chart-local state: it resets to top-right on market switch,
 *  which is the sane default for a fresh layout.
 *
 *  Pointer events (not mouse) so touch dragging works; the container uses
 *  touch-none while dragging targets it so the browser doesn't hijack the
 *  gesture for scrolling. `hidden` hides the stack while a TradingView popup is open. Children keep their own pointer handlers (none —
 *  the badges are display-only), so a drag can start anywhere on the stack. */
export function DraggableChartBadges({ children, hidden = false }: { children: React.ReactNode; hidden?: boolean }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // null → default CSS position (top-right). Set on first drag.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = elRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const rect = el.getBoundingClientRect();
    const prect = parent.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: rect.left - prect.left,
      baseY: rect.top - prect.top,
    };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = elRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!d || !el || !parent) return;
    // Clamp inside the chart container so the badges can't be lost off-canvas.
    const x = Math.max(0, Math.min(d.baseX + (e.clientX - d.startX), parent.clientWidth - el.offsetWidth));
    const y = Math.max(0, Math.min(d.baseY + (e.clientY - d.startY), parent.clientHeight - el.offsetHeight));
    setPos({ x, y });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    elRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={elRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title="Drag to move"
      data-testid="chart-badges"
      data-hidden={hidden || undefined}
      // `hidden`: a TradingView dialog / menu is open inside the iframe, which no z-index of ours can outrank.
      // invisible keeps the stack mounted (drag position survives) but draws nothing and takes no pointer.
      className={`absolute z-10 flex cursor-grab touch-none select-none flex-col items-end gap-1 active:cursor-grabbing${hidden ? " invisible pointer-events-none" : ""}`}
      style={pos ? { left: pos.x, top: pos.y } : { top: 8, right: 8 }}
    >
      {children}
    </div>
  );
}
