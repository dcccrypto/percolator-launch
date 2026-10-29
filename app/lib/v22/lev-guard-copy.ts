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
  // The program checks deposits minus withdrawals after the action (tags 96 / 97 / 103), so the line covers both directions:
  // a deposit that stays under $500, and a withdrawal that would leave between $0 and $500 (review S-2 / D-9).
  creatorStake:
    "The creator stake has to be at least $500 in total, or none at all. A deposit must bring it to $500 or more, and a withdrawal can't leave less than $500 behind. Nothing was changed.",
  /** 132 */
  required:
    "This market needs its safety guard account on opening trades, and it wasn't sent. Refresh the page and try again. If it keeps happening, the market's guard may not be set up yet, so new positions can't open here for now. Closing still works. Nothing was changed.",
  /** 133 by reason; `unknown` when the logs did not name one. */
  refused: {
    // The clock starts when the market's guard was created (its launch), not when the token was minted (review L-4 / M-2).
    age_under_6h: "New market: opening positions unlocks 6 hours after this market launched. You can still close.",
    // Checked on the whole position after the fill, so an existing position can need more margin, not just a lower slider.
    leverage: "That leverage is above this market's current safety limit. Lower the leverage, or add margin, and try again.",
    // The program checks the market's total room (the liquidity pool's net position), not this account's own size.
    size: "This market's room for new positions on this side is used up right now. Try a smaller size, or the other side.",
    // Structural, not price-driven: users' shorts <= longs x min(1, MMR/m) + beta x backing / m (lev_guard_v22 short_users_cap_notional).
    short_dump_cap: "New shorts are limited on this market: total shorts can't grow past what its longs and backing can cover. Try a smaller short, or go long.",
    lp_stop_round: "This market's liquidity is rebalancing after a loss, so it can't take on new positions for now. Try again shortly.",
    unknown:
      "This market's safety guard declined that opening trade right now (a newly launched market, a size or leverage above the current limit, or a sharp price move). Try a smaller size or lower leverage, or try again shortly. Nothing was changed.",
  } satisfies Record<LevGuardRefusalReason | "unknown", string>,
  /** 134 */
  invalid: "This market's safety guard setup isn't valid. Nothing was changed. Refresh the page and try again; if it keeps happening, the app is out of date.",
  /** 135 */
  lpStopNotTriggered: "Nothing to do: this market's liquidity loss stop isn't triggered right now. Nothing was changed.",
} as const;

/** The 133 line for a reason (null / unknown reason = the general line). */
export function levGuardRefusedCopy(reason: LevGuardRefusalReason | null): string {
  return LEV_GUARD_COPY.refused[reason ?? "unknown"];
}

/** Titles for the structured resolver, by reason. */
export const LEV_GUARD_REFUSED_TITLE: Record<LevGuardRefusalReason | "unknown", string> = {
  age_under_6h: "New market",
  leverage: "Leverage too high",
  size: "Size too big",
  short_dump_cap: "Shorts capped",
  lp_stop_round: "Liquidity rebalancing",
  unknown: "Not right now",
};

// ── the trade ticket, before signing (app bug 2026-10-29, product review finding 4 / R2) ────────────────────────────────────────────

/** "about 2 h" / "about 25 min" for a slot count (0.4 s a slot), never "0 min". */
export function slotsWait(slots: bigint): string {
  const mins = Math.max(1, Math.ceil(Number(slots) * 0.4 / 60));
  if (mins < 60) return `about ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

export const LEV_GUARD_TICKET_COPY = {
  newMarket: (wait: string): string => `New market: opening positions unlocks in ${wait}, 6 hours after this market launched. You can still close.`,
  missing: "This market's safety guard isn't set up yet, so new positions can't open here for now. Closing still works.",
} as const;

/**
 * The ticket's line when the guard closes every open: `null` for any other closed reason (the growth copy handles those).
 * `reason` is the side quote's `closedReason` (lib/v21/growth-market.ts GuardClosedReason).
 */
export function levGuardTicketClosed(
  view: { guard: { input: { nowSlot: bigint }; limits: { opensAtSlot: bigint | null } } | null } | null | undefined,
  reason: string | null,
): { title: string; message: string } | null {
  if (reason === "guard-missing") return { title: "Opening unavailable", message: LEV_GUARD_TICKET_COPY.missing };
  if (reason !== "guard-new-market") return null;
  const at = view?.guard?.limits.opensAtSlot ?? null;
  const now = view?.guard?.input.nowSlot ?? null;
  if (at === null || now === null) return { title: LEV_GUARD_REFUSED_TITLE.age_under_6h, message: LEV_GUARD_COPY.refused.age_under_6h };
  return { title: LEV_GUARD_REFUSED_TITLE.age_under_6h, message: LEV_GUARD_TICKET_COPY.newMarket(slotsWait(at > now ? at - now : 1n)) };
}
