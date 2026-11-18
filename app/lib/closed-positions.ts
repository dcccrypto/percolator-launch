/**
 * "Closed while you were away": tell a trader when a position they held is gone and they did not
 * close it themselves.
 *
 * On v18 a liquidation happens inside the keeper's routine crank and emits nothing (no log, no
 * indexed trade; percolator-indexer traderNetPosition.ts), so a liquidated position simply vanishes
 * and the trader cannot tell why. Until the program emits a liquidation event (percolator-prog#547),
 * the app infers it:
 *   1. Remember the wallet's open positions in this browser after every complete portfolio scan.
 *   2. When a remembered position is gone from a later complete scan, ask the indexer whether this
 *      wallet traded on that market since we last saw it. A trade means the trader closed it (on any
 *      device). No trade means the protocol closed it: a liquidation, or the market was settled.
 *   3. Only then show a notice, and keep it until the trader dismisses it.
 *
 * Everything that cannot be checked fails quiet: a missed notice is better than a false "you were
 * liquidated". Pure helpers here; storage is wrapped in try/catch (private windows, blocked storage).
 */

/** A position as remembered between visits. Bigints are stored as decimal strings. */
export interface SeenPosition {
  key: string;
  slab: string;
  symbol: string | null;
  side: "long" | "short";
  sizeAbs: string;
  markE6: string;
  liqPriceE6: string;
  /** When it was last seen open. Equals the snapshot's savedAt while open; older once it went missing. */
  lastOpenAt?: number;
}

export interface PositionSnapshot {
  v: 1;
  savedAt: number;
  positions: Record<string, SeenPosition>;
}

export interface ClosedNotice extends SeenPosition {
  /** When the position was last seen open (the snapshot time). */
  lastSeenAt: number;
  detectedAt: number;
}

/** The fields this module reads from a PortfolioPosition (kept narrow so tests need no SDK types). */
export interface PositionLike {
  slabAddress: string;
  symbol: string | null;
  idx: number;
  nftWrapped?: boolean;
  oraclePriceE6: bigint;
  liquidationPriceE6: bigint;
  account: { positionSize: bigint; owner: { toBase58(): string } };
}

/** How long a disappearance is re-checked before it is reported, so the trader's own close has time to be indexed. */
export const CONFIRM_AFTER_MS = 3 * 60_000;
/** Trades this close to the snapshot time still count as "after", to absorb clock skew. */
export const TRADE_SKEW_MS = 2 * 60_000;
/** A snapshot older than this is too stale to explain anything; it is replaced, not compared. */
export const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 3_600_000;

export const positionKey = (slab: string, idx: number): string => `${slab}:${idx}`;

/**
 * The wallet's own, unwrapped, open positions. NFT-wrapped positions are left out: they can leave the
 * wallet legitimately (sent to someone else) with no trade. Positions whose account owner is not this
 * wallet are left out too, so a stale list from a just-switched wallet can never be remembered under
 * the new one.
 */
export function seenFromPositions(positions: PositionLike[], wallet: string): Record<string, SeenPosition> {
  const out: Record<string, SeenPosition> = {};
  for (const p of positions) {
    const size = p.account?.positionSize ?? 0n;
    if (size === 0n || p.nftWrapped) continue;
    if (p.account.owner.toBase58() !== wallet) continue;
    const key = positionKey(p.slabAddress, p.idx);
    out[key] = {
      key,
      slab: p.slabAddress,
      symbol: p.symbol,
      side: size > 0n ? "long" : "short",
      sizeAbs: (size < 0n ? -size : size).toString(),
      markE6: p.oraclePriceE6.toString(),
      liqPriceE6: p.liquidationPriceE6.toString(),
    };
  }
  return out;
}

/** Remembered positions that are no longer open. */
export function vanishedSince(prev: PositionSnapshot, now: Record<string, SeenPosition>): SeenPosition[] {
  return Object.values(prev.positions).filter((p) => !(p.key in now));
}

/** Did this wallet trade on `slab` at or after `sinceMs` (minus skew)? */
export function tradedSince(
  trades: ReadonlyArray<{ slab_address?: unknown; created_at?: unknown }>,
  slab: string,
  sinceMs: number,
  skewMs: number = TRADE_SKEW_MS,
): boolean {
  return trades.some((t) => {
    if (t.slab_address !== slab || typeof t.created_at !== "string") return false;
    const at = Date.parse(t.created_at);
    return Number.isFinite(at) && at >= sinceMs - skewMs;
  });
}

// ── storage (per wallet, fail-soft) ──────────────────────────────────────────

const snapKey = (wallet: string) => `pco-pos-snapshot:v1:${wallet}`;
const noticeKey = (wallet: string) => `pco-closed-notices:v1:${wallet}`;

function read<T>(key: string): T | null {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the feature quietly does nothing */
  }
}

export function loadSnapshot(wallet: string, now: number = Date.now()): PositionSnapshot | null {
  const s = read<PositionSnapshot>(snapKey(wallet));
  if (!s || s.v !== 1 || typeof s.savedAt !== "number" || typeof s.positions !== "object" || s.positions === null) return null;
  if (Array.isArray(s.positions)) return null;
  // A non-finite or future savedAt (device clock was ahead when saved) has no usable age: stale.
  const age = now - s.savedAt;
  if (!Number.isFinite(age) || age < 0 || age > MAX_SNAPSHOT_AGE_MS) return null;
  return s;
}

export function saveSnapshot(wallet: string, positions: Record<string, SeenPosition>, now: number = Date.now()): void {
  write(snapKey(wallet), { v: 1, savedAt: now, positions } satisfies PositionSnapshot);
}

const isIntString = (v: unknown): boolean => typeof v === "string" && /^-?\d+$/.test(v);

/** Every field the notice UI reads, checked so a corrupt entry is dropped instead of throwing in render (BigInt()). */
function isNotice(x: unknown): x is ClosedNotice {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  return (
    typeof n.key === "string" &&
    typeof n.slab === "string" &&
    (n.symbol === null || typeof n.symbol === "string") &&
    (n.side === "long" || n.side === "short") &&
    isIntString(n.sizeAbs) &&
    isIntString(n.markE6) &&
    isIntString(n.liqPriceE6) &&
    typeof n.lastSeenAt === "number" &&
    Number.isFinite(n.lastSeenAt)
  );
}

export function loadNotices(wallet: string): ClosedNotice[] {
  const n = read<ClosedNotice[]>(noticeKey(wallet));
  return Array.isArray(n) ? n.filter(isNotice) : [];
}

export function saveNotices(wallet: string, notices: ClosedNotice[]): void {
  write(noticeKey(wallet), notices);
}

// ── decision (pure) ──────────────────────────────────────────────────────────

/** A missing position is re-checked at least this long before it can be reported. */
export const MIN_MISSING_MS = 60_000;
/** An undecidable position (indexer has nothing for it) is given up on after this long. */
export const GIVE_UP_UNKNOWN_MS = 10 * CONFIRM_AFTER_MS;

/**
 * What to do with a position that went missing, given the indexer's answer.
 *  - "drop":   the trader closed it themselves, or it cannot be decided and has waited long enough.
 *  - "wait":   check again later (too soon for the trader's own close to be indexed, or unknown).
 *  - "notice": the protocol closed it.
 */
export function decideMissing(
  check: "user-traded" | "no-trade" | "unknown",
  m: { lastOpenAt: number; missingSince: number },
  now: number,
): "drop" | "wait" | "notice" {
  if (check === "user-traded") return "drop";
  if (check === "unknown") return now - m.missingSince > GIVE_UP_UNKNOWN_MS ? "drop" : "wait";
  if (now - m.missingSince < MIN_MISSING_MS || now - m.lastOpenAt < CONFIRM_AFTER_MS) return "wait";
  return "notice";
}
