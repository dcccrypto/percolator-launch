import { useEffect, useRef, useState } from "react";

/**
 * The classic perp-DEX tick micro-interaction: briefly tints a value
 * long-green (up) or short-red (down) when it changes, easing back to
 * neutral over `durationMs`. No layout shift — callers apply the returned
 * class as a text-color override on an already-laid-out element.
 *
 * Extracted from `MarketInfoBar`'s `MarkPrice` component (the original,
 * proven implementation) so PositionsDock/MarketBookCard can reuse the exact
 * same flash behavior instead of re-deriving it.
 */
export function usePriceFlash(value: bigint | null | undefined, durationMs = 300): "up" | "down" | null {
  const prev = useRef<bigint | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (value == null) return;
    const prevValue = prev.current;
    if (prevValue != null && value !== prevValue) {
      setFlash(value > prevValue ? "up" : "down");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash(null), durationMs);
    }
    prev.current = value;
  }, [value, durationMs]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return flash;
}
