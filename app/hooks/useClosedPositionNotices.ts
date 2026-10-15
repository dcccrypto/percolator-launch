"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio } from "@/hooks/usePortfolio";
import {
  decideMissing,
  loadNotices,
  loadSnapshot,
  saveNotices,
  saveSnapshot,
  seenFromPositions,
  tradedSince,
  vanishedSince,
  type ClosedNotice,
  type SeenPosition,
} from "@/lib/closed-positions";

/** How often positions that went missing are re-checked against the indexer. */
const RECHECK_MS = 30_000;

export interface Missing {
  seen: SeenPosition;
  /** Snapshot time at which it was last seen open. */
  lastOpenAt: number;
  /** When this browser first saw it gone. */
  missingSince: number;
}

export type TradeCheck = "user-traded" | "no-trade" | "unknown";

/** What to remember: every open position (seen now) plus every missing one still being decided. */
export function rememberedPositions(
  open: Record<string, SeenPosition>,
  missing: ReadonlyMap<string, Missing>,
  now: number,
): Record<string, SeenPosition> {
  const out: Record<string, SeenPosition> = {};
  for (const [k, p] of Object.entries(open)) out[k] = { ...p, lastOpenAt: now };
  for (const [k, m] of missing) out[k] = { ...m.seen, lastOpenAt: m.lastOpenAt };
  return out;
}

/**
 * Asks the indexer whether `wallet` traded on `slab` since `sinceMs`. "unknown" when the answer
 * cannot be trusted: the request failed, or the indexer holds no trades at all for this wallet on
 * this market (no indexer configured, or a retired market), so a missing trade proves nothing.
 */
export async function checkTrades(wallet: string, slab: string, sinceMs: number, fetchImpl: typeof fetch = fetch): Promise<TradeCheck> {
  try {
    const r = await fetchImpl(`/api/trader/${encodeURIComponent(wallet)}/trades?slab=${encodeURIComponent(slab)}&limit=20`, { cache: "no-store" });
    if (!r.ok) return "unknown";
    const body = (await r.json()) as { trades?: unknown; total?: unknown };
    if (!Array.isArray(body.trades) || typeof body.total !== "number" || body.total === 0) return "unknown";
    return tradedSince(body.trades as Array<{ slab_address?: unknown; created_at?: unknown }>, slab, sinceMs) ? "user-traded" : "no-trade";
  } catch {
    return "unknown";
  }
}

/**
 * Notices for positions the protocol closed while the trader was away (see lib/closed-positions.ts).
 * Shares usePortfolio's app-wide deduped scan, so it adds no RPC load; the indexer is asked only when
 * a remembered position is missing.
 */
export function useClosedPositionNotices(): { notices: ClosedNotice[]; dismiss: (key: string) => void } {
  const { connected, publicKey } = useWalletCompat();
  const wallet = connected ? publicKey?.toBase58() ?? null : null;
  const portfolio = usePortfolio(connected);
  const [notices, setNotices] = useState<ClosedNotice[]>([]);
  const missing = useRef<Map<string, Missing>>(new Map());
  const checking = useRef(false);

  // Notices survive reloads until dismissed; a wallet switch shows that wallet's own.
  useEffect(() => {
    missing.current = new Map();
    setNotices(wallet ? loadNotices(wallet) : []);
  }, [wallet]);

  // After every COMPLETE scan (usePortfolio fails closed: an incomplete scan keeps the previous
  // snapshot and sets no fresh positions), remember what is open and note what went missing.
  // Missing positions stay in the saved snapshot until decided, so a reload re-detects them.
  useEffect(() => {
    if (!wallet || portfolio.loading || portfolio.error) return;
    // Just after a wallet switch the list can still be the previous wallet's: skip that scan
    // rather than read it as "every remembered position is gone".
    if (portfolio.positions.some((p) => !p.nftWrapped && p.account?.owner && p.account.owner.toBase58() !== wallet)) return;
    const now = Date.now();
    const open = seenFromPositions(portfolio.positions, wallet);
    const prev = loadSnapshot(wallet, now);
    if (prev) {
      for (const v of vanishedSince(prev, open)) {
        if (!missing.current.has(v.key)) {
          missing.current.set(v.key, { seen: v, lastOpenAt: v.lastOpenAt ?? prev.savedAt, missingSince: now });
        }
      }
    }
    // A position that is open again was never closed.
    for (const k of [...missing.current.keys()]) if (k in open) missing.current.delete(k);
    saveSnapshot(wallet, rememberedPositions(open, missing.current, now), now);
  }, [wallet, portfolio.loading, portfolio.error, portfolio.positions]);

  // Decide missing positions: a trade since it was last seen means the trader closed it; no trade,
  // once enough time has passed for their own close to have been indexed, means the protocol did.
  const decide = useCallback(async () => {
    if (!wallet || checking.current || missing.current.size === 0) return;
    checking.current = true;
    try {
      const now = Date.now();
      for (const [key, m] of [...missing.current]) {
        const action = decideMissing(await checkTrades(wallet, m.seen.slab, m.lastOpenAt), m, now);
        if (action === "wait") continue;
        missing.current.delete(key);
        if (action === "drop") continue;
        const notice: ClosedNotice = { ...m.seen, lastSeenAt: m.lastOpenAt, detectedAt: now };
        setNotices((prev) => {
          if (prev.some((n) => n.key === key && n.lastSeenAt === notice.lastSeenAt)) return prev;
          const next = [...prev, notice];
          saveNotices(wallet, next);
          return next;
        });
      }
      // Forget decided positions: keep what is open (lastOpenAt == savedAt) and what is still undecided.
      const snap = loadSnapshot(wallet);
      if (snap) {
        const kept = Object.fromEntries(
          Object.entries(snap.positions).filter(([k, p]) => missing.current.has(k) || (p.lastOpenAt ?? snap.savedAt) >= snap.savedAt),
        );
        saveSnapshot(wallet, kept, snap.savedAt);
      }
    } finally {
      checking.current = false;
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    void decide();
    const t = setInterval(() => void decide(), RECHECK_MS);
    return () => clearInterval(t);
  }, [wallet, decide, portfolio.positions]);

  const dismiss = useCallback(
    (key: string) => {
      setNotices((prev) => {
        const next = prev.filter((n) => n.key !== key);
        if (wallet) saveNotices(wallet, next);
        return next;
      });
    },
    [wallet],
  );

  return { notices, dismiss };
}
