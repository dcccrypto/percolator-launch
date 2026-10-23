/**
 * What an Open-tab order DID to the position, from the MEASURED change (lib/position-change.ts:
 * the ADL-effective signed quantity before and after the trade), never from the requested size
 * or the raw pre-trade position: a raw 8 long that ADL scaled to an effective 3, sold for 5, is
 * a flip (closed 3, opened 2), not "reduced by 5".
 *
 * `orderHeading` (lib/trading.ts) is the PRE-trade heading and stays request-based on purpose:
 * before the trade there is nothing measured to word it from.
 */
import { TICKET_COPY } from "@/lib/limits/copy";
import type { PositionChange } from "@/lib/position-change";

export type OrderOutcome =
  | { effect: "unmeasured" }
  | { effect: "zero" }
  | {
      effect: "open" | "add" | "reduce" | "close" | "flip";
      /** Measured |after - before|. */
      filled: bigint;
      /** The side that was held before (reduce / close / flip / add); the order's side for an open. */
      held: "long" | "short";
      /** The side the order is on. */
      side: "long" | "short";
      /** Measured size closed (close / flip) and opened (open / flip). */
      closed: bigint;
      opened: bigint;
      /** Less filled than requested. */
      partial: boolean;
      requested: bigint;
    };

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * `requestedQ` is the unsigned requested size. A null change, no movement of the position's
 * sign direction the order asked for, or a delta larger than the request (something else traded
 * in between) is "unmeasured": no specific claim. A zero delta is "zero".
 */
export function classifyOrderChange(direction: "long" | "short", requestedQ: bigint, change: PositionChange | null): OrderOutcome {
  if (!change) return { effect: "unmeasured" };
  const { beforeQ, afterQ } = change;
  const delta = afterQ - beforeQ;
  if (delta === 0n) return { effect: "zero" };
  const s = direction === "long" ? 1n : -1n;
  const along = delta * s; // > 0 when the position moved the way the order asked
  const filled = abs(delta);
  if (along < 0n || filled > requestedQ) return { effect: "unmeasured" };
  const side = direction;
  const beforeS = beforeQ * s; // > 0: already on the order's side
  const afterS = afterQ * s;
  const heldSide: "long" | "short" = beforeQ > 0n ? "long" : "short";
  const partial = filled < requestedQ;
  const base = { filled, side, partial, requested: requestedQ, held: heldSide, closed: 0n, opened: 0n };
  if (beforeQ === 0n) return { effect: "open", ...base, held: side, opened: afterS };
  if (beforeS > 0n) return { effect: "add", ...base, opened: filled };
  // The position was on the other side of the order.
  if (afterS > 0n) return { effect: "flip", ...base, closed: abs(beforeQ), opened: afterS };
  if (afterS === 0n) return { effect: "close", ...base, closed: abs(beforeQ) };
  return { effect: "reduce", ...base };
}

/** The result line body for a measured outcome (not "zero": that keeps TICKET_COPY.result.zero). */
export function orderResultBody(o: Exclude<OrderOutcome, { effect: "zero" }>, fmt: (q: bigint) => string, sym: string, price: string): string {
  if (o.effect === "unmeasured") return TICKET_COPY.result.unmeasured;
  const p = o.partial ? null : price;
  const tail = o.partial ? `. ${TICKET_COPY.result.partialTail}` : "";
  switch (o.effect) {
    case "open":
      return o.partial ? TICKET_COPY.result.partial(fmt(o.filled), fmt(o.requested), sym) : TICKET_COPY.result.full(fmt(o.opened), sym, o.side, price);
    case "add":
      return TICKET_COPY.result.added(fmt(o.filled), sym, o.held, p) + tail;
    case "reduce":
      return TICKET_COPY.result.reduced(fmt(o.filled), sym, o.held, p) + tail;
    case "close":
      return TICKET_COPY.result.closed(fmt(o.closed), sym, o.held, p) + tail;
    case "flip":
      return TICKET_COPY.result.flipped(fmt(o.closed), fmt(o.opened), sym, o.held, o.side, p) + tail;
  }
}
