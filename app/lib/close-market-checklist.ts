import { UNFINISHED_COPY } from "@/lib/unfinished-launch";

/**
 * UX WP-9 (audit §3.11, MM-2): the close-market preconditions as a checklist shown BEFORE the
 * button ("Fees claimed ✓ · No open accounts ✓ · Insurance empty ✓"). The button is disabled with
 * the FIRST unmet item. An item the app cannot read is shown as unknown and does not block (the
 * one-approval close simulates first, so a real blocker still never opens the wallet).
 */
export type CheckState = "ok" | "unmet" | "unknown";

export interface CloseCheck {
  key: "fees" | "accounts" | "insurance";
  label: string;
  state: CheckState;
  /** What to do, for the disabled button's reason line. */
  unmetLine: string;
}

export function closeMarketChecklist(i: {
  /** Claimable creator fees in atoms; null = unknown. */
  claimableFeeAtoms: bigint | null;
  /** Accounts other than the creator's own (their cleanup rides in the close); null = unknown. */
  otherOpenAccounts: number | null;
  insuranceAtoms: bigint | null;
  /**
   * The market is a launch that never finished (marketauth still the creator). Its funded insurance
   * is not something the creator can drain: it went in at launch step 3, and a launch past that can
   * only be finished, so the reason says that instead of leaving a dead end (#3266).
   */
  unfinished?: boolean;
}): CloseCheck[] {
  const st = (v: bigint | number | null): CheckState => (v === null ? "unknown" : BigInt(v) > 0n ? "unmet" : "ok");
  return [
    { key: "fees", label: "Fees claimed", state: st(i.claimableFeeAtoms), unmetLine: "Claim your fees first: closing the market would give them up." },
    { key: "accounts", label: "No open accounts", state: st(i.otherOpenAccounts), unmetLine: "Other traders still have accounts on this market." },
    { key: "insurance", label: "Insurance empty", state: st(i.insuranceAtoms), unmetLine: i.unfinished ? UNFINISHED_COPY.insuranceBlocked : "The market's insurance fund still holds funds." },
  ];
}

export const firstUnmet = (c: readonly CloseCheck[]): CloseCheck | null => c.find((x) => x.state === "unmet") ?? null;

export const CLOSE_MARKET_COPY = {
  title: (sym: string) => `Close ${sym} market`,
  body: (sym: string, sol: string | null) =>
    sol ? `Close ${sym} market and get back ≈ ${sol} SOL rent. You can't reopen it.` : `Close ${sym} market and get back its rent. You can't reopen it.`,
  confirm: "Close market · 1 approval",
  unfinishedTitle: "Reclaim rent from this unfinished launch",
  unfinishedBody: "Remove this unfinished launch and get back its rent. You can't reopen it.",
  /** Only when the chain read confirms nothing is funded. */
  unfinishedBodyConfirmedEmpty: "Remove this unfinished launch and get back its rent. No funds, portfolio or backing were found on it. You can't reopen it.",
  unfinishedConfirm: "Reclaim rent · 1 approval",
  mark: (s: CheckState) => (s === "ok" ? "✓" : s === "unmet" ? "✗" : "?"),
} as const;
