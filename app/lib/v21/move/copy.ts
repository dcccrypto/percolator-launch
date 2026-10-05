/** Copy for the Move flow. Calm, plain, honest about what is locked and why. No jargon. */
import type { StepKind, StepStatus, PlanSummary } from "./plan";

export const MOVE_COPY = {
  title: "Move to v2.1",
  intro:
    "The first Percolator markets are closing to new trades while v2.1 opens. This page moves what you hold, one step at a time. You can stop and come back: it picks up where you left off.",
  closeOnlyBanner: "v1 is close-only. You can close positions and withdraw at any time. New trades are off.",
  closeOnlyLink: "Move to v2.1",
  connect: "Connect your wallet to see what you hold on v1.",
  loading: "Looking at your v1 accounts...",
  scanFailed: "We couldn't read your v1 accounts just now. Nothing was sent. Try again in a moment.",
  nothing: "You hold nothing on v1. There is nothing to move.",
  complete: "Everything is moved.",
  notLive: "v2.1 is not open yet. You can still bring your funds home to your wallet now; deposits open when v2.1 does.",
  whyEarnWait: "Earn withdrawals have a short waiting period so the vault can pay everyone fairly. Your request is saved on chain.",
  summary: {
    "nothing-to-move": "Nothing to move.",
    ready: "Ready for your next step.",
    waiting: "Waiting on a countdown. Come back any time.",
    blocked: "One step needs something first.",
    complete: "All done.",
  } as Record<PlanSummary, string>,
  kind: {
    close: "Close position",
    withdraw: "Withdraw to wallet",
    "earn-request": "Request Earn withdrawal",
    "earn-execute": "Collect Earn withdrawal",
    "claim-creator-fee": "Claim creator fees",
    "deposit-market": "Deposit on v2.1",
    "deposit-earn": "Deposit in v2.1 Earn",
  } as Record<StepKind, string>,
  status: {
    done: "Done",
    ready: "Ready",
    waiting: "Waiting",
    blocked: "Not yet",
    unavailable: "Not available",
    skipped: "Skipped",
  } as Record<StepStatus, string>,
  doIt: "Open",
  runReady: "Do the next step",
  rescan: "Refresh",
} as const;
