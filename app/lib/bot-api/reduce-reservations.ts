/**
 * In-flight reduce-only reservations (council round 1, risk seat).
 *
 * v2.2's TradeCpi has no reduce-only flag (lib/trade-ix.ts) and a trade does not bump the taker's position epoch, so the
 * reduce-only check in builders/caps.ts only holds at BUILD time: two reduce-only orders built from the same position could
 * both land and flip it (long 10, two reduce-only sells of 6 -> short 2). This module closes that gap on the server:
 *
 *  - When a reduce-only order or a close is built, its size is RESERVED per (owner, market, trading account) in the bot-API
 *    key/value store (Upstash when configured, else the per-process map: the same store and fallback idempotency uses).
 *  - A new reduce-only build is refused with reduce_only_inflight (409, retryable) when the sizes still in flight plus the
 *    new size exceed the current position; details carry the position, the reserved size and what is still reducible.
 *  - A reservation ends when: its TTL passes (RESERVATION_TTL_SEC, longer than a blockhash lives: 150 blocks, ~60-90 s);
 *    the build is cancelled (POST /v1/orders/cancel); GET /v1/tx/{signature} sees the transaction landed (processed /
 *    confirmed / finalized / failed: the position read on the next build already reflects it); or GET /v1/tx is asked with
 *    ?messageHash= after the chain passed the build's lastValidBlockHeight (expired: it can never land).
 *
 * What it is NOT: an on-chain guarantee. Bytes the caller already holds can still land until their lastValidBlockHeight, and
 * a cancel releases the reservation on the caller's word that it will not send them. Only reduce-only orders and closes are
 * reserved; an order sent without reduceOnly is not counted. An on-chain position-sequence guard (the trade carries the
 * position it was built against and the program refuses a stale one) is future work.
 *
 * The check-and-reserve is serialised per position with a short store lock (set NX), so two concurrent builds cannot both
 * pass the check. Store writes are read-modify-write under that lock.
 */
import { randomUUID } from "node:crypto";
import { ApiError } from "./errors";
import { getKv, type Kv } from "./kv";

/** Longer than a blockhash lives (150 blocks, ~60-90 s), equal to the idempotency TTL: a reservation never ends before its bytes can no longer land on a normal chain. */
export const RESERVATION_TTL_SEC = 120;
/** A pending (not yet attached) reservation: the build is still simulating. Kept short so a crashed build frees it fast. */
const PENDING_TTL_SEC = 30;
const LOCK_TTL_SEC = 5;
const LOCK_TRIES = 20;
const LOCK_WAIT_MS = 50;

export interface ReservationEntry {
  /** Reservation id: random while the build runs, then the order transaction's messageHash (sha256 hex). */
  id: string;
  /** Absolute reserved size, engine q, decimal string. */
  q: string;
  /** Unix ms after which the entry no longer counts. */
  exp: number;
  /** The build's lastValidBlockHeight, once known. */
  lvbh: number | null;
}

export interface PositionKey {
  owner: string;
  market: string;
  /** The trading account (portfolio) the order trades from. */
  account: string;
}

const posKey = (p: PositionKey) => `botapi:reduce:${p.owner}:${p.market}:${p.account}`;
const lockKey = (p: PositionKey) => `botapi:reduce:lock:${p.owner}:${p.market}:${p.account}`;
const msgKey = (hash: string) => `botapi:reduce:msg:${hash}`;

function live(raw: string | null, now: number): ReservationEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { entries?: ReservationEntry[] };
    return (v.entries ?? []).filter((e) => e && typeof e.id === "string" && /^\d+$/.test(e.q) && e.exp > now);
  } catch {
    return [];
  }
}

async function write(kv: Kv, p: PositionKey, entries: ReservationEntry[], now: number): Promise<void> {
  if (entries.length === 0) {
    await kv.del(posKey(p));
    return;
  }
  const ttl = Math.max(1, Math.ceil((Math.max(...entries.map((e) => e.exp)) - now) / 1000));
  await kv.set(posKey(p), JSON.stringify({ entries }), { ttlSec: ttl });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withLock<T>(kv: Kv, p: PositionKey, f: () => Promise<T>): Promise<T> {
  for (let i = 0; i < LOCK_TRIES; i++) {
    if (await kv.set(lockKey(p), "1", { nx: true, ttlSec: LOCK_TTL_SEC })) {
      try {
        return await f();
      } finally {
        await kv.del(lockKey(p));
      }
    }
    await sleep(LOCK_WAIT_MS);
  }
  throw new ApiError("reduce_only_inflight", "another reduce-only build for this position is being checked right now; retry in a moment");
}

/** Sum of the live reserved sizes for a position. */
export async function reservedReduce(p: PositionKey, kv: Kv = getKv(), now: number = Date.now()): Promise<bigint> {
  return live(await kv.get(posKey(p)), now).reduce((a, e) => a + BigInt(e.q), 0n);
}

/**
 * Checks that `sizeAbs` still fits in the position after what is in flight, and reserves it (pending until attach()).
 * Throws reduce_only_inflight with { positionQ, reservedQ, remainingQ, sizeQ } when it does not.
 */
export async function reserveReduce(
  p: PositionKey,
  positionAbs: bigint,
  sizeAbs: bigint,
  kv: Kv = getKv(),
  now: () => number = Date.now,
): Promise<{ id: string; release: () => Promise<void>; attach: (messageHash: string, lastValidBlockHeight: number) => Promise<void> }> {
  const id = `pending:${randomUUID()}`;
  await withLock(kv, p, async () => {
    const t = now();
    const entries = live(await kv.get(posKey(p)), t);
    const reserved = entries.reduce((a, e) => a + BigInt(e.q), 0n);
    if (reserved + sizeAbs > positionAbs) {
      const remaining = positionAbs > reserved ? positionAbs - reserved : 0n;
      throw new ApiError(
        "reduce_only_inflight",
        `reduce-only orders already in flight for this position reserve ${reserved} of its ${positionAbs} q; only ${remaining} q is still reducible, this order asks for ${sizeAbs}. Wait for them to land or expire (GET /v1/tx/{signature}), or cancel one, then build again`,
        { details: { positionQ: positionAbs.toString(), reservedQ: reserved.toString(), remainingQ: remaining.toString(), sizeQ: sizeAbs.toString(), inFlight: entries.length } },
      );
    }
    entries.push({ id, q: sizeAbs.toString(), exp: t + PENDING_TTL_SEC * 1000, lvbh: null });
    await write(kv, p, entries, t);
  });
  let done = false;
  return {
    id,
    release: async () => {
      if (done) return;
      done = true;
      await removeEntry(p, id, kv, now());
    },
    attach: async (messageHash: string, lastValidBlockHeight: number) => {
      if (done) return;
      done = true;
      await withLock(kv, p, async () => {
        const t = now();
        const entries = live(await kv.get(posKey(p)), t);
        const e = entries.find((x) => x.id === id);
        // Gone (the pending TTL passed while the build ran): reserve it again under its final id, it is about to be returned.
        const q = e?.q ?? sizeAbs.toString();
        const rest = entries.filter((x) => x.id !== id && x.id !== messageHash);
        rest.push({ id: messageHash, q, exp: t + RESERVATION_TTL_SEC * 1000, lvbh: lastValidBlockHeight });
        await write(kv, p, rest, t);
      });
      await kv.set(msgKey(messageHash), JSON.stringify(p), { ttlSec: RESERVATION_TTL_SEC });
      await kv.set("botapi:reduce:any", "1", { ttlSec: RESERVATION_TTL_SEC });
    },
  };
}

async function removeEntry(p: PositionKey, id: string, kv: Kv, now: number): Promise<boolean> {
  return withLock(kv, p, async () => {
    const entries = live(await kv.get(posKey(p)), now);
    const rest = entries.filter((e) => e.id !== id);
    if (rest.length === entries.length) return false;
    await write(kv, p, rest, now);
    return true;
  });
}

/** The reservation a returned order transaction holds, if any. */
export async function reservationFor(messageHash: string, kv: Kv = getKv(), now: number = Date.now()): Promise<{ position: PositionKey; entry: ReservationEntry } | null> {
  if (!/^[0-9a-f]{64}$/.test(messageHash)) return null;
  const raw = await kv.get(msgKey(messageHash));
  if (!raw) return null;
  let position: PositionKey;
  try {
    position = JSON.parse(raw) as PositionKey;
  } catch {
    return null;
  }
  const entry = live(await kv.get(posKey(position)), now).find((e) => e.id === messageHash);
  return entry ? { position, entry } : null;
}

/** Ends the reservation of the order transaction with this messageHash. True when one was released. */
export async function releaseByMessageHash(messageHash: string, kv: Kv = getKv(), now: number = Date.now()): Promise<boolean> {
  const r = await reservationFor(messageHash, kv, now);
  await kv.del(msgKey(messageHash));
  if (!r) return false;
  return removeEntry(r.position, messageHash, kv, now);
}

/** Whether any reservation was made recently (lets GET /v1/tx skip the extra transaction read when there is nothing to release). */
export async function anyReservations(kv: Kv = getKv()): Promise<boolean> {
  return (await kv.get("botapi:reduce:any")) !== null;
}
