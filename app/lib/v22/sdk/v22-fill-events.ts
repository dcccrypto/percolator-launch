/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ d98488b (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/v22-fill-events.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * v2.2 wrapper events: FILL, REDUCE, MOVE (incl. MOVE sub 4 `G9_RESTORE_PNL`) and the strict log attribution rule.
 *
 * Source of truth: percolator-prog `release/v22-wrapper-rem` `docs/v22-fill-events.md` and `src/fill_events_v22.rs`
 * (reference decoder `tests/support/fill_events.rs`). Nothing here is read from an account: events live only in a
 * transaction's `logMessages`.
 *
 * TRUST MODEL (read before indexing; the first published attribution rule was forgeable):
 *  1. Only successful transactions (`meta.err == null`): {@link decodeTxEventsV22} takes `succeeded` and returns
 *     `status: "failed"` otherwise.
 *  2. Each `logMessages` element is ONE atomic line. A `Program data: ` token is attributed to the wrapper only when the
 *     program on TOP of the runtime's frame stack at that line is the wrapper id you pin (not one read from the
 *     transaction). The stack is pushed ONLY by a full-line `Program <32-byte base58 key> invoke [n]` with `n` ==
 *     stack depth + 1, and popped ONLY by exactly `Program <key on top> success` or a line starting
 *     `Program <key on top> failed: `. ANY inconsistency makes the whole transaction's events UNKNOWN (never "no events").
 *  3. `requested_q` and `quoted_price_e6` are NOT the wrapper's statement (instruction data / the matcher's reply): display
 *     only, never volume, PnL or charts. Volume is `executed_q` at `price_e6`.
 *  4. Unknown kinds, versions, MOVE subs and REDUCE reasons, and known kinds whose length does not match, are SKIPPED
 *     (reported in `skipped`), never thrown and never guessed at.
 *  5. `Log truncated` anywhere, or null/empty logs: the events are UNKNOWN. Reconcile from account state.
 *  6. Check `market` against your registry and `assetGen` against the asset's current generation before accepting an event.
 *
 * @module v22-fill-events
 */
import { PublicKey } from "@solana/web3.js";

export const EVENT_KIND_FILL_V22 = 1;
export const EVENT_KIND_REDUCE_V22 = 2;
export const EVENT_KIND_MOVE_V22 = 3;
export const EVENT_VERSION_V22 = 1;

/** Header of every event: kind, version, ix_tag (u8 each) + market (32). */
export const EVENT_HEADER_LEN_V22 = 35;
export const FILL_FIXED_LEN_V22 = 100;
export const FILL_REC_LEN_V22 = 75;
export const REDUCE_LEN_V22 = 134;
export const MOVE_LEN_V22 = 62;
/** `MAX_FILL_RECS_PER_LINE`. The wrapper accepts at most 4 legs per batch since #546, so a line has at most 4 records today. */
export const FILL_MAX_RECS_PER_LINE_V22 = 11;
/** `asset_index` of a MOVE that names no asset. */
export const MOVE_NO_ASSET_V22 = 0xffff;
/** The exact element the runtime's log collector inserts once when its 10,000-byte budget is hit. */
export const LOG_TRUNCATED_V22 = "Log truncated";

/** FILL record `flags` bits. A decoder must not reject an unknown bit or combination. */
export const FILL_FLAG_V22 = Object.freeze({ CLIPPED: 1, PARTIAL: 2, ZERO: 4, MATCHER: 8 });

/** REDUCE `reason`. Units differ: 1 = basis units; 2 and 3 = ADL-effective units; 4 and 5 = size traded against the vault LP. */
export const REDUCE_REASON_V22 = Object.freeze({
  REBALANCE_REDUCE: 1,
  ADL_WIND_DOWN: 2,
  LIQUIDATION: 3,
  DUST_SWEEP: 4,
  EVICTION: 5,
} as const);
export type ReduceReasonV22 = (typeof REDUCE_REASON_V22)[keyof typeof REDUCE_REASON_V22];

/** MOVE `sub`. */
export const MOVE_SUB_V22 = Object.freeze({
  EARN_EXIT: 1,
  G9: 2,
  RENT_ROUTED: 3,
  G9_RESTORE_PNL: 4,
} as const);
export type MoveSubV22 = (typeof MOVE_SUB_V22)[keyof typeof MOVE_SUB_V22];

/** One record of a FILL line (75 bytes). */
export interface FillRecordV22 {
  assetIndex: number;
  /** The asset's `market_id` (generation): a reused asset index is unambiguous. */
  assetGen: bigint;
  flags: number;
  /** UNTRUSTED (copied from the instruction data). Display only. */
  requestedQ: bigint;
  /** The size that executed (0 on a zero fill). Positive = `taker` long. Engine position units (POS_SCALE 1e6). */
  executedQ: bigint;
  /** The price the position was BOOKED at (e6). On a zero fill: the reference price only. */
  priceE6: bigint;
  /** UNTRUSTED (the matcher's quote, or the wire price on NoCpi). 0 when no matcher answered. Never a price for volume, PnL or charts. */
  quotedPriceE6: bigint;
  /** TOTAL engine trade fee across BOTH portfolios (not the taker's alone, not protocol revenue); saturates at u64::MAX. */
  feeAtoms: bigint;
  /** Backing-domain fee charged on top (single trades only; 0 in batches). */
  backingFeeAtoms: bigint;
}

interface EventBaseV22 {
  /** The wrapper tag of the HANDLER that emitted it (10 inside 119, 5 for the pre-crank inside 77): match to instructions by log position. */
  ixTag: number;
  market: PublicKey;
}

export interface FillEventV22 extends EventBaseV22 {
  kind: "fill";
  /** `account_a`: the fee payer and, on a matcher route, the signing taker. */
  taker: PublicKey;
  /** `account_b`: the counterparty (the LP on a matcher route). */
  lp: PublicKey;
  records: FillRecordV22[];
}

export interface ReduceEventV22 extends EventBaseV22 {
  kind: "reduce";
  portfolio: PublicKey;
  /** The bound vault LP for forced closes; the all-zero key for a unilateral reduction. */
  counterparty: PublicKey;
  assetIndex: number;
  assetGen: bigint;
  reason: ReduceReasonV22;
  /** Signed change of the portfolio's position (a long being reduced is negative). Unit depends on `reason`. */
  signedReducedQ: bigint;
  priceE6: bigint;
}

/** MOVE with its `a`/`b`/`c` words named per `sub`. Raw words are always kept. */
interface MoveBaseV22 extends EventBaseV22 {
  kind: "move";
  /** 0xFFFF = none. */
  assetIndex: number;
  a: bigint;
  b: bigint;
  c: bigint;
}
export interface MoveEarnExitV22 extends MoveBaseV22 { sub: 1; principalAtoms: bigint; earningsAtoms: bigint; sharesBurned: bigint }
/** Mode 0 draw (insurance -> vault LP capital) or mode 1 capital-only restore (vault LP capital -> insurance). Mode 3 is never here. */
export interface MoveG9V22 extends MoveBaseV22 { sub: 2; amountAtoms: bigint; receivableAfterAtoms: bigint; mode: 0 | 1 }
export interface MoveRentRoutedV22 extends MoveBaseV22 { sub: 3; routedAtoms: bigint }
/**
 * G9 restore, mode 3: repaid from the vault LP's released profit first, capital for the remainder. ALWAYS this sub for mode 3,
 * also when the profit part is 0. Amount repaid into insurance = `fromProfitAtoms + fromCapitalAtoms`; the vault LP's PnL fell by
 * the first, its capital by the second.
 */
export interface MoveG9RestorePnlV22 extends MoveBaseV22 { sub: 4; fromProfitAtoms: bigint; fromCapitalAtoms: bigint; receivableAfterAtoms: bigint }
export type MoveEventV22 = MoveEarnExitV22 | MoveG9V22 | MoveRentRoutedV22 | MoveG9RestorePnlV22;

export type WrapperEventV22 = FillEventV22 | ReduceEventV22 | MoveEventV22;

/** Why one token was skipped (it never throws). */
export type SkipReasonV22 = "malformed" | "unknown-kind" | "unknown-version" | "bad-length" | "unknown-reduce-reason" | "unknown-move-sub" | "bad-g9-mode";

/** Why a transaction's events are UNKNOWN (never "no events"). */
export type UnknownReasonV22 = "no-logs" | "truncated" | "bad-invoke-depth" | "bad-return" | "data-outside-frame" | "unclosed-frame";

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u64(b: Uint8Array, o: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);
}
function i128(b: Uint8Array, o: number): bigint {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return (dv.getBigInt64(o + 8, true) << 64n) | dv.getBigUint64(o, true);
}
function key(b: Uint8Array, o: number): PublicKey {
  return new PublicKey(b.slice(o, o + 32));
}

/**
 * Decode ONE event payload (the raw bytes behind one base64 token). `kind` and `version` are bytes 0 and 1 in every version and are
 * checked before any length. Returns `{ skip }` (never throws) for an unknown kind, version, MOVE sub, REDUCE reason, or a known kind
 * with the wrong length. Do not guess at the fields of a skipped event.
 */
export function decodeWrapperEventV22(b: Uint8Array): { event: WrapperEventV22 } | { skip: SkipReasonV22 } {
  if (b.length < 2) return { skip: "malformed" };
  if (b[0] < 1 || b[0] > 3) return { skip: "unknown-kind" };
  if (b[1] !== EVENT_VERSION_V22) return { skip: "unknown-version" };
  if (b.length < EVENT_HEADER_LEN_V22) return { skip: "bad-length" };
  const ixTag = b[2];
  const market = key(b, 3);
  if (b[0] === EVENT_KIND_FILL_V22) {
    if (b.length < FILL_FIXED_LEN_V22) return { skip: "bad-length" };
    const n = b[99];
    // The wrapper never emits an empty line, and never more than 11 records per line.
    if (n === 0 || n > FILL_MAX_RECS_PER_LINE_V22 || b.length !== FILL_FIXED_LEN_V22 + FILL_REC_LEN_V22 * n) return { skip: "bad-length" };
    const records: FillRecordV22[] = [];
    for (let i = 0; i < n; i++) {
      const o = FILL_FIXED_LEN_V22 + FILL_REC_LEN_V22 * i;
      records.push({
        assetIndex: u16(b, o), assetGen: u64(b, o + 2), flags: b[o + 10],
        requestedQ: i128(b, o + 11), executedQ: i128(b, o + 27),
        priceE6: u64(b, o + 43), quotedPriceE6: u64(b, o + 51), feeAtoms: u64(b, o + 59), backingFeeAtoms: u64(b, o + 67),
      });
    }
    return { event: { kind: "fill", ixTag, market, taker: key(b, 35), lp: key(b, 67), records } };
  }
  if (b[0] === EVENT_KIND_REDUCE_V22) {
    if (b.length !== REDUCE_LEN_V22) return { skip: "bad-length" };
    const reason = b[109];
    if (reason < 1 || reason > 5) return { skip: "unknown-reduce-reason" };
    return {
      event: {
        kind: "reduce", ixTag, market, portfolio: key(b, 35), counterparty: key(b, 67), assetIndex: u16(b, 99), assetGen: u64(b, 101),
        reason: reason as ReduceReasonV22, signedReducedQ: i128(b, 110), priceE6: u64(b, 126),
      },
    };
  }
  if (b.length !== MOVE_LEN_V22) return { skip: "bad-length" };
  const sub = b[35];
  const assetIndex = u16(b, 36), a = u64(b, 38), bb = u64(b, 46), c = u64(b, 54);
  const base = { kind: "move" as const, ixTag, market, assetIndex, a, b: bb, c };
  switch (sub) {
    case MOVE_SUB_V22.EARN_EXIT: return { event: { ...base, sub: 1, principalAtoms: a, earningsAtoms: bb, sharesBurned: c } };
    case MOVE_SUB_V22.G9:
      // `c` is the mode: 0 draw, 1 restore; never 3 (mode 3 is G9_RESTORE_PNL), 2 emits nothing. Anything else is not ours: skip.
      if (c !== 0n && c !== 1n) return { skip: "bad-g9-mode" };
      return { event: { ...base, sub: 2, amountAtoms: a, receivableAfterAtoms: bb, mode: Number(c) as 0 | 1 } };
    case MOVE_SUB_V22.RENT_ROUTED: return { event: { ...base, sub: 3, routedAtoms: a } };
    case MOVE_SUB_V22.G9_RESTORE_PNL: return { event: { ...base, sub: 4, fromProfitAtoms: a, fromCapitalAtoms: bb, receivableAfterAtoms: c } };
    default: return { skip: "unknown-move-sub" };
  }
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Decode one base64 token (the text after `Program data: `). A token that is not base64 is `malformed`. */
export function decodeWrapperEventTokenV22(token: string): { event: WrapperEventV22 } | { skip: SkipReasonV22 } {
  if (!B64.test(token)) return { skip: "malformed" };
  const raw = Buffer.from(token, "base64");
  // Reject non-canonical encodings (a token that does not round-trip is not what the wrapper printed).
  if (raw.toString("base64").replace(/=+$/, "") !== token.replace(/=+$/, "")) return { skip: "malformed" };
  return decodeWrapperEventV22(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
}

const RUNTIME_LINE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (.*)$/s;
const INVOKE_TAIL = /^invoke \[([0-9]+)\]$/;

/** `Program <id> <tail>` -> `{id, tail}` only when `id` is a canonical 32-byte base58 key. */
function runtimeProgramLine(line: string): { id: string; tail: string } | null {
  const m = RUNTIME_LINE.exec(line);
  if (!m) return null;
  try {
    if (new PublicKey(m[1]).toBase58() !== m[1]) return null;
  } catch {
    return null;
  }
  return { id: m[1], tail: m[2] };
}

export type WrapperTokensV22 = { ok: true; tokens: string[] } | { ok: false; unknown: UnknownReasonV22 };

/**
 * The strict frame walk. Returns the base64 tokens whose frame is `wrapper` (pinned by YOU, never read from the transaction), or
 * `{ ok: false, unknown }` on ANY inconsistency. Each element of `logs` is atomic: it is never joined with its neighbours and never
 * split on a newline.
 */
export function wrapperEventTokensV22(logs: readonly string[] | null | undefined, wrapper: PublicKey): WrapperTokensV22 {
  if (!logs || logs.length === 0) return { ok: false, unknown: "no-logs" };
  if (logs.includes(LOG_TRUNCATED_V22)) return { ok: false, unknown: "truncated" };
  const w = wrapper.toBase58();
  const stack: string[] = [];
  const tokens: string[] = [];
  for (const line of logs) {
    const rl = runtimeProgramLine(line);
    if (rl) {
      const inv = INVOKE_TAIL.exec(rl.tail);
      if (inv) {
        if (Number(inv[1]) !== stack.length + 1) return { ok: false, unknown: "bad-invoke-depth" };
        stack.push(rl.id);
      } else if (rl.tail === "success" || rl.tail.startsWith("failed: ")) {
        if (stack[stack.length - 1] !== rl.id) return { ok: false, unknown: "bad-return" };
        stack.pop();
      }
      // Any other runtime line about a program (`consumed N of M compute units`) changes nothing.
      continue;
    }
    if (line.startsWith("Program data: ")) {
      const top = stack[stack.length - 1];
      if (top === undefined) return { ok: false, unknown: "data-outside-frame" };
      if (top === w) for (const t of line.slice("Program data: ".length).split(" ")) if (t !== "") tokens.push(t);
    }
  }
  if (stack.length !== 0) return { ok: false, unknown: "unclosed-frame" };
  return { ok: true, tokens };
}

/** What a transaction's logs say about wrapper events. */
export type TxEventsV22 =
  | { status: "failed" }
  | { status: "unknown"; reason: UnknownReasonV22 }
  | { status: "known"; events: WrapperEventV22[]; skipped: SkipReasonV22[] };

/**
 * The indexer entry point.
 * @param succeeded  `meta.err == null`. A failed transaction's events describe nothing that happened: `{ status: "failed" }`.
 * @param logs       `meta.logMessages` (null when the RPC kept none: UNKNOWN, not "no fill").
 * @param wrapper    The wrapper program id, pinned in your configuration.
 * @returns `known` with the events in log order (plus the reasons any wrapper token was skipped), or `unknown`. On `unknown`
 *   re-read the affected portfolios from account state and record DERIVED fills (price and fee unknown); never record "no fill".
 */
export function decodeTxEventsV22(succeeded: boolean, logs: readonly string[] | null | undefined, wrapper: PublicKey): TxEventsV22 {
  if (!succeeded) return { status: "failed" };
  const t = wrapperEventTokensV22(logs, wrapper);
  if (!t.ok) return { status: "unknown", reason: t.unknown };
  const events: WrapperEventV22[] = [];
  const skipped: SkipReasonV22[] = [];
  for (const tok of t.tokens) {
    const d = decodeWrapperEventTokenV22(tok);
    if ("event" in d) events.push(d.event);
    else skipped.push(d.skip);
  }
  return { status: "known", events, skipped };
}
