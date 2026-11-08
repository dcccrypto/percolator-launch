/**
 * The PERC holder vote: fixed poll, fixed choices, and the exact text a wallet
 * signs. Pure and client-safe (no env, no I/O).
 *
 * buildVoteMessage MUST stay byte-identical to perc_vote._message in the
 * vote migration (20261108010000_perc_vote.sql); the database
 * rebuilds the message itself and refuses any mismatch (a DB test compares
 * the two implementations).
 */
export const VOTE_POLL_KEY = "perc-fee-policy-2026-11";
export const VOTE_DOMAIN = "percolator.trade";
export const VOTE_ACTION = "cast-vote";
/** Exact body confirmation the admin start endpoint requires. */
export const START_CONFIRMATION = `START ${VOTE_POLL_KEY}`;

export const VOTE_CHOICES = ["weekly-fee-claims", "buy-and-burn"] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];
/** Ties and zero votes resolve to this choice. */
export const DEFAULT_CHOICE: VoteChoice = "buy-and-burn";

export const VOTE_CHOICE_LABELS: Readonly<Record<VoteChoice, string>> = Object.freeze({
  "weekly-fee-claims": "Weekly fee claims",
  "buy-and-burn": "Buy and burn",
});

export function isVoteChoice(v: unknown): v is VoteChoice {
  return typeof v === "string" && (VOTE_CHOICES as readonly string[]).includes(v);
}

/** Database timestamp format: UTC, millisecond precision, e.g. 2026-11-08T01:02:03.004Z */
export const VOTE_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const VOTE_NONCE_RE = /^[0-9a-f]{64}$/;

export interface VoteMessageFields {
  choice: VoteChoice;
  wallet: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function buildVoteMessage(f: VoteMessageFields): string {
  return [
    "percolator.trade PERC holder vote",
    `Action: ${VOTE_ACTION}`,
    `Domain: ${VOTE_DOMAIN}`,
    `Poll: ${VOTE_POLL_KEY}`,
    `Choice: ${f.choice}`,
    `Wallet: ${f.wallet}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expires At: ${f.expiresAt}`,
    "Signing records a vote only. It is not a transaction and moves no funds.",
  ].join("\n");
}
