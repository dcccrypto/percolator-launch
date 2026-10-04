/**
 * UX WP-10 (audit §4.3): the ONE status line under the trade page's market header, shown only
 * when the market is not simply live. Priority: settled > close-only (ADL / recovery) > no room for
 * new positions (LP depleted / halted) > catching up > one side paused > both sides paused. The
 * bankruptcy h-lock is deliberately NOT a header state: it gates only LP-backing / insurance
 * withdrawals and admin oracle reconfiguration, never opens, closes, deposits or user withdrawals.
 * Everything else the old health banner and limits
 * strip showed (OI vs cap, liquidity, band, skew, payout level) lives in "Market details".
 * Copy = the §5.3 lines. Pure.
 */
import type { StatusVariant } from "@/lib/limits/user-message";
import type { HealthBadge, MarketHealthRow } from "@/lib/market-health";

export interface HeaderStatus {
  kind: string;
  variant: StatusVariant;
  title: string;
  body: string;
}

const has = (row: MarketHealthRow, id: HealthBadge["id"]) => row.badges.some((b) => b.id === id);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Sides named by the drain-only badge ("long close-only", "long & short close-only"). */
function drainSides(row: MarketHealthRow): string[] {
  const b = row.badges.find((x) => x.id === "drain-only");
  if (!b) return [];
  return b.label.replace(/\s*close-only$/i, "").split("&").map((x) => x.trim()).filter(Boolean);
}

export function marketHeaderStatus(row: MarketHealthRow | null | undefined): HeaderStatus | null {
  if (!row) return null;
  if (has(row, "resolved")) {
    return { kind: "resolved", variant: "info", title: "Market settled", body: "Close any position and withdraw. There's nothing else to do." };
  }
  if (has(row, "recovery") && !has(row, "adl-reduce-only")) {
    return { kind: "adl-reduce-only", variant: "paused", title: "Close-only for now", body: "Closing works normally; new positions reopen once the market recovers." };
  }
  if (has(row, "adl-reduce-only")) {
    return { kind: "adl-reduce-only", variant: "paused", title: "Close-only for now", body: "Closing works normally. New positions reopen once the positions on one side of the market have closed, which depends on those traders and can take a while." };
  }
  // A-3: "no funds to take the other side" is the real reason new positions can't open, and it
  // does not clear on its own, so it outranks the transient "catching up" state.
  if (has(row, "lp-halted") || has(row, "lp-depleted")) {
    return { kind: "lp-halt", variant: "paused", title: "New positions paused", body: "The market has no room for new positions right now. Closing works normally." };
  }
  if (has(row, "repairable") || has(row, "loss-stale")) {
    return {
      kind: "engine-catching-up",
      variant: "wait",
      title: "Catching up",
      body: "The market is catching up with the latest prices. Your trade goes through automatically when it's ready.",
    };
  }
  const drain = drainSides(row);
  if (drain.length === 1) {
    const side = drain[0]!.toLowerCase();
    const known = side === "long" || side === "longs" || side === "short" || side === "shorts";
    const plural = side.endsWith("s") ? side : `${side}s`;
    const other = side.startsWith("long") ? "shorts" : "longs";
    return known
      ? { kind: "side-paused", variant: "paused", title: `New ${plural} paused`, body: `The market has no room for more ${side.replace(/s$/, "")} exposure. ${cap(other)} and closes work.` }
      : { kind: "side-paused", variant: "paused", title: "One side paused", body: "One side of this market only accepts trades that reduce positions right now. Closes work." };
  }
  if (drain.length > 1) {
    return { kind: "lp-halt", variant: "paused", title: "New positions paused", body: "The market has no room for new positions right now. Closing works normally." };
  }
  return null;
}

/** Badges a market LIST may show (audit §4.3): only states that change what a user can do. */
export const LIST_BADGE_IDS: ReadonlySet<HealthBadge["id"]> = new Set(["resolved", "adl-reduce-only", "recovery", "lp-halted", "lp-depleted", "drain-only"]);
