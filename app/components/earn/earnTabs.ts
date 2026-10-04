/**
 * Tab definitions for the Earn hub — the ways to earn on the platform.
 *
 * Pulled out of app/earn/page.tsx so the ORDER is unit-testable without
 * mounting the hub (which would mount a tab's whole surface, its data hooks and
 * its wallet providers). Order is load-bearing: the hub opens on `TABS[0]`, so
 * inserting a tab rather than appending one silently changes which surface a
 * visitor lands on.
 */

export const EARN_TABS = [
  { key: "vault", label: "Vaults" },
  { key: "stake", label: "Fee staking" },
  // Creator fees are a way of earning here too, so the hub that lists the
  // others lists this one. /my-markets keeps its own route — this is a second
  // entry point, not a move.
  { key: "markets", label: "My Markets" },
] as const;

export type EarnTabKey = (typeof EARN_TABS)[number]["key"];

/** The tab the hub opens on when there is no usable hash. */
export const DEFAULT_EARN_TAB: EarnTabKey = EARN_TABS[0].key;

export function isEarnTabKey(value: string): value is EarnTabKey {
  return EARN_TABS.some((t) => t.key === value);
}
