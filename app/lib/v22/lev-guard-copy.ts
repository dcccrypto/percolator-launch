/**
 * Plain-English copy for the v2.2 leverage-guard wrapper errors 131..=135 (percolator-prog `PercolatorError`, ledger
 * `v22-lev-guard-wire-spec-2026-10-28.md`), shared by the plain-string table (`lib/v22/error-copy.ts`) and the structured resolver
 * (`lib/v22/error-message.ts`). No protocol vocabulary, no codes: calm, one or two lines, and "Nothing was changed" where it is true.
 *
 * 133 is the guard refusing an opening trade. The program logs `lev_guard_refused <why>` just before it fails, so when the error
 * carries its logs the line names the real cause; without logs it falls back to a line that covers every cause.
 */

/** 133's log reasons (`lev_guard_refused <why>`). */
export const LEV_GUARD_REFUSAL_REASONS = ["age_under_6h", "leverage", "size", "short_dump_cap", "lp_stop_round"] as const;
export type LevGuardRefusalReason = (typeof LEV_GUARD_REFUSAL_REASONS)[number];

/** Pull the reason out of an error's log lines, a joined log string, or a raw message. Null when there is none (or an unknown one). */
export function parseLevGuardRefusal(source: string | readonly string[] | null | undefined): LevGuardRefusalReason | null {
  if (!source) return null;
  const text = typeof source === "string" ? source : source.join("\n");
  const m = /lev_guard_refused\s+([a-z0-9_]+)/.exec(text);
  if (!m) return null;
  return (LEV_GUARD_REFUSAL_REASONS as readonly string[]).includes(m[1]!) ? (m[1] as LevGuardRefusalReason) : null;
}

export const LEV_GUARD_COPY = {
  /** 131 */
  creatorStake: "The creator stake has to be at least $500, or none at all. Add to the stake and try again. Nothing was changed.",
  /** 132 */
  required:
    "This market needs its safety guard account on opening trades, and this page didn't send it. Refresh the page and try again; if it keeps happening, the app is out of date. Nothing was changed.",
  /** 133 by reason; `unknown` when the logs did not name one. */
  refused: {
    age_under_6h: "New token: opening positions unlocks 6 hours after launch. You can still close.",
    leverage: "That leverage is above this market's current safety limit. Lower the leverage and try again.",
    size: "That position is bigger than this market's current safety limit. Try a smaller size.",
    short_dump_cap: "New shorts are capped on this market right now, after a sharp move down. Try a smaller short, or go long.",
    lp_stop_round: "The LP is rebalancing after a loss; try again shortly.",
    unknown:
      "This market's safety guard declined that opening trade right now (a new token, a size or leverage above the current limit, or a sharp price move). Try a smaller size or lower leverage, or try again shortly. Nothing was changed.",
  } satisfies Record<LevGuardRefusalReason | "unknown", string>,
  /** 134 */
  invalid: "This market's safety guard setup isn't valid. Nothing was changed. Refresh the page and try again; if it keeps happening, the app is out of date.",
  /** 135 */
  lpStopNotTriggered: "Nothing to do: the LP's loss stop isn't triggered right now. Nothing was changed.",
} as const;

/** The 133 line for a reason (null / unknown reason = the general line). */
export function levGuardRefusedCopy(reason: LevGuardRefusalReason | null): string {
  return LEV_GUARD_COPY.refused[reason ?? "unknown"];
}

/** Titles for the structured resolver, by reason. */
export const LEV_GUARD_REFUSED_TITLE: Record<LevGuardRefusalReason | "unknown", string> = {
  age_under_6h: "New token",
  leverage: "Leverage too high",
  size: "Size too big",
  short_dump_cap: "Shorts capped",
  lp_stop_round: "LP rebalancing",
  unknown: "Not right now",
};
