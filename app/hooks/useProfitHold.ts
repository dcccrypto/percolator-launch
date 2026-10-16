"use client";

import { useEffect, useState } from "react";
import { HELD_AFTER_MS, isProfitHeld, type ConvertQuote } from "@/lib/convert-released-pnl";

/**
 * v2.2 QA W-1/W-2: when did this portfolio's profit FIRST read "backing short" (tag 28 simulates to nothing)? Kept in
 * sessionStorage so a reload does not restart the clock; forgotten as soon as the quote is anything else.
 */
const KEY = (portfolio: string) => `v22.profitSince.${portfolio}`;
const mem = new Map<string, number>();

export function noteBackingShortSince(portfolio: string, now: number): number {
  const known = mem.get(portfolio);
  if (known !== undefined) return known;
  let since = now;
  try {
    const raw = window.sessionStorage.getItem(KEY(portfolio));
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0 && n <= now) since = n;
    else window.sessionStorage.setItem(KEY(portfolio), String(now));
  } catch { /* no storage: the in-memory clock stands */ }
  mem.set(portfolio, since);
  return since;
}
export function clearBackingShortSince(portfolio: string): void {
  mem.delete(portfolio);
  try { window.sessionStorage.removeItem(KEY(portfolio)); } catch { /* ignore */ }
}
export function __resetProfitHoldForTest(): void { mem.clear(); }

/** `held` = show "Held: waiting on backing" (lib/convert-released-pnl.ts isProfitHeld); re-evaluated every 15 s while it could flip. */
export function useProfitHold(portfolioKey: string | null, quote: ConvertQuote | null): { held: boolean; amount: bigint | null } {
  const [now, setNow] = useState(() => Date.now());
  const backing = quote?.status === "settling" && quote.reason === "backing";
  useEffect(() => {
    if (!portfolioKey) return;
    if (backing) noteBackingShortSince(portfolioKey, Date.now());
    else clearBackingShortSince(portfolioKey);
  }, [portfolioKey, backing]);
  useEffect(() => {
    if (!backing) return;
    const t = setInterval(() => setNow(Date.now()), Math.min(15_000, HELD_AFTER_MS));
    return () => clearInterval(t);
  }, [backing]);
  if (!portfolioKey || quote?.status !== "settling" || !quote.reason) return { held: false, amount: null };
  const since = backing ? noteBackingShortSince(portfolioKey, now) : null;
  return { held: isProfitHeld(quote, since, now), amount: quote.released };
}
