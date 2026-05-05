"use client";

import { useState, useEffect, useCallback } from "react";
import type { DrawingTool } from "@/lib/chart-drawings";

const STORAGE_KEY = "perc:chart:drawing-tool";

/** Single source of truth for the tools the runtime validator accepts.
 *  Typed as `Record<DrawingTool, true>` so adding a tool to the union
 *  forces a compile error here (missing key). Mirrors the
 *  VALID_KIND_TABLE pattern in chart-drawings.ts. */
const VALID_TOOL_TABLE: Record<DrawingTool, true> = {
  pointer: true,
  trend: true,
  horizontal: true,
  rectangle: true,
};

function isValidTool(value: unknown): value is DrawingTool {
  return (
    typeof value === "string" && Object.hasOwn(VALID_TOOL_TABLE, value)
  );
}

export interface UseChartDrawingToolReturn {
  tool: DrawingTool;
  setTool: (next: DrawingTool) => void;
}

/** Persisted active drawing tool. Global (NOT per-slab) — when the user
 *  picks "trend line" on BTC and switches to SOL, they expect to still
 *  be in trend-line mode. Stored under a single localStorage key so the
 *  selection survives across markets and reloads.
 *
 *  Default: `pointer` (select / delete existing drawings without
 *  drawing anything new). Returns to default on:
 *  - First mount with no stored value.
 *  - Stored value that doesn't match a known kind (tolerant
 *    deserialisation; handles app-version downgrades that drop a kind).
 *  - localStorage unavailable (SSR, privacy mode, quota errors).
 *
 *  SSR-safe: returns `pointer` on the server and during the first
 *  client render, then hydrates from localStorage in an effect. */
export function useChartDrawingTool(): UseChartDrawingToolReturn {
  const [tool, setToolState] = useState<DrawingTool>("pointer");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw != null && isValidTool(raw)) {
        setToolState(raw);
      }
    } catch {
      // localStorage unavailable; keep default.
    }
  }, []);

  const setTool = useCallback((next: DrawingTool) => {
    setToolState(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort; ignore quota / privacy errors.
    }
  }, []);

  return { tool, setTool };
}
