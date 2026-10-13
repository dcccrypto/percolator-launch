/**
 * Mobile card layout for the positions dock (below lg, where the trade page uses its phone layout).
 *
 * The dock's rows are a 10-column table that is far wider than a phone. Below lg the same row becomes a
 * 3-column grid: the header row hides, each value cell shows its own label from data-label, and the
 * actions take a full-width row under the values instead of a column pinned over them. One DOM serves both
 * layouts, so the desktop table and the tests that query it are unchanged.
 *
 * Used by PositionsDock and OtherMarketPositions. Kept as literal strings so Tailwind's scanner sees them.
 */
export const MOBILE_CARD_ROW = "max-lg:grid max-lg:grid-cols-3 max-lg:gap-x-3 max-lg:gap-y-2.5 max-lg:px-4 max-lg:py-3";

export const MOBILE_CARD_CELL =
  "max-lg:p-0 max-lg:text-left max-lg:before:mb-0.5 max-lg:before:block max-lg:before:text-[8px] max-lg:before:font-medium max-lg:before:uppercase max-lg:before:tracking-[0.15em] max-lg:before:text-[var(--text-secondary)] max-lg:before:content-[attr(data-label)]";

export const MOBILE_CARD_ACTIONS =
  "max-lg:col-span-3 max-lg:border-l-0 max-lg:border-t max-lg:bg-transparent max-lg:p-0 max-lg:pt-2.5 max-lg:text-left";
