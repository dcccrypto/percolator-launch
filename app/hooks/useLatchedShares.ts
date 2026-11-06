'use client';

import { useRef } from 'react';

/**
 * Hold a derived share count steady while the user's input is unchanged (Council GO1106-UX #1).
 *
 * The Earn exit quote is bound to its share count (lib/v22/exit-quote-binding F6). A typed USDC amount is converted
 * to shares at the live share price, so a background poll that moved the price re-derived a different count and
 * dropped the quote seconds after it appeared. The count is re-taken only when `inputKey` changes (the user edited
 * the amount, unit or balance) or while it is still 0 (pricing not loaded yet).
 */
export function latchShares(prev: { key: string; shares: bigint } | null, shares: bigint, inputKey: string): { key: string; shares: bigint } {
  if (!prev || prev.key !== inputKey || prev.shares === 0n) return { key: inputKey, shares };
  return prev;
}

export function useLatchedShares(shares: bigint, inputKey: string): bigint {
  const ref = useRef<{ key: string; shares: bigint } | null>(null);
  ref.current = latchShares(ref.current, shares, inputKey);
  return ref.current.shares;
}
