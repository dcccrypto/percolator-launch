/**
 * How a trade-history row names its side (#3314).
 *
 * A row is one FILL, and the indexer stores `side` from the sign of its size: a buy is
 * "long", a sell is "short". Whether that fill opened or closed a position depends on the
 * position at the time, which the row doesn't carry, so closing a long is a sell and used to
 * read "SHORT" (one row per leg of a split close). A fill is labelled for what it is: BUY or
 * SELL. Positions keep LONG / SHORT; this is for fill rows only.
 */
export type FillSide = "buy" | "sell";

/** "long"/"buy" → buy, "short"/"sell" → sell (the chart feed already accepts both spellings);
 *  anything else (null, unknown) → null. */
export function fillSide(side: string | null | undefined): FillSide | null {
  const s = side?.toLowerCase();
  if (s === "long" || s === "buy") return "buy";
  if (s === "short" || s === "sell") return "sell";
  return null;
}

export function fillSideLabel(side: string | null | undefined): "BUY" | "SELL" | "—" {
  const f = fillSide(side);
  return f === "buy" ? "BUY" : f === "sell" ? "SELL" : "—";
}

/** Text colour: buys in the long colour, sells in the short colour, unknown muted. */
export function fillSideColor(side: string | null | undefined): string {
  const f = fillSide(side);
  return f === "buy" ? "text-[var(--long)]" : f === "sell" ? "text-[var(--short)]" : "text-[var(--text-muted)]";
}
