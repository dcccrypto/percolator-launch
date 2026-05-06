"use client";

import { useState, useCallback } from "react";
import type { DrawingTool } from "@/lib/chart-drawings";

export interface UseChartDrawingToolReturn {
  tool: DrawingTool;
  setTool: (next: DrawingTool) => void;
}

/** Active drawing tool. Ephemeral — every fresh load starts on `pointer`,
 *  and the parent overlay also resets to `pointer` on slab change. The
 *  earlier version persisted to localStorage globally, but that turned
 *  the next visit's first click into a silent trend-anchor drop with
 *  no signal — a real UX trap because the toolbar's accent tint is too
 *  subtle for a returning user to scan for. Drawings still persist
 *  per-slab (see `useChartDrawings`); only the tool selection is
 *  intentionally session-local. */
export function useChartDrawingTool(): UseChartDrawingToolReturn {
  const [tool, setTool] = useState<DrawingTool>("pointer");
  const setStable = useCallback((next: DrawingTool) => {
    setTool(next);
  }, []);
  return { tool, setTool: setStable };
}
