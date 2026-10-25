/**
 * The claim flow after a market is Resolved (percolator ops plan v22-market-lifecycle-plan-2026-10-25, sections 3 and 4).
 *
 * Pure planning, no RPC and no React. Three things live here:
 *
 *  1. {@link planClaimRows}: the rows of the market page's claim panel, in the order money is paid back (positions, then Earn,
 *     then stake), each with its one next action and, for positions, when the owner-only window ends.
 *  2. {@link earnDeadShareFloorPresent}: whether the market carries the Earn vault's dead-share-floor backing bucket. CloseSlab
 *     (wrapper tag 13) refuses with Custom 21 for as long as a funded bucket is stamped `LP_VAULT_BACKING_EXPIRY_SLOT`
 *     (`u64::MAX / 2`), which the floor keeps funded for ever (percolator-prog aca02ba6 `handle_close_slab`,
 *     `lp_vault_dead_share_floor_present`; ledger L5-stake.md section 8, FC-B5). So rent is never reclaimable on such a market.
 *  3. {@link stakeRecoverState}: whether a resolved stake-bound pool still has something for "Recover to stakers" (stake tag 29,
 *     anyone) to book before stakers withdraw.
 *
 * Order and gates, from the deployed programs:
 *  - Positions: CloseResolved (30) is owner-signed during `force_close_delay_slots` after `resolved_slot`, then anyone may run it and
 *    the payout still goes to the owner's token account (wrapper aca02ba6 `handle_close_resolved`). Wizard markets set 216,000 slots.
 *  - Earn: seniors are paid once the market is terminal-flat (materialized_portfolio_count == 0 and c_tot == 0).
 *  - Stake: tag 29 needs a Resolved market; the wrapper's terminal insurance withdraw (tag 41) needs no open portfolio.
 */
import { decodeBackingBucket } from "@/lib/limits/earn-split-pot";
import { marketOffsetsOrNull } from "./market-offsets";
import { SLOT_MS } from "@/lib/limits/resolved-eta";

/** `constants::LP_VAULT_BACKING_EXPIRY_SLOT` (percolator-prog aca02ba6 v16_program.rs:967). */
export const LP_VAULT_BACKING_EXPIRY_SLOT = (2n ** 64n - 1n) / 2n;

/** `BackingBucketStatusV16::Empty` (engine v16.rs:4546). */
const BUCKET_EMPTY = 0;

/**
 * True when some backing domain is funded AND stamped with the LP-vault "never expires" sentinel (the Earn dead-share floor), i.e.
 * CloseSlab refuses with Custom 21 for ever. Needs the whole market account (a `dataSlice` prefix has no buckets). Null when the
 * bytes are not a market of a known layout, or too short to read every domain: nothing is claimed then.
 */
export function earnDeadShareFloorPresent(data: Uint8Array | null | undefined): boolean | null {
  if (!data) return null;
  try {
    const M = marketOffsetsOrNull(data, "earnDeadShareFloorPresent");
    if (!M) return null;
    // Same domain count as the program: 2 per market slot (`v16_domain_count_for_market_slots`). A length that is not a whole
    // number of slots is a truncated read: refuse to answer rather than miss a bucket.
    const slotsBase = M.g + M.layout.marketGroupLen;
    const tail = data.length - slotsBase;
    if (tail <= 0 || tail % M.layout.assetSlotStride !== 0) return null;
    const domains = (tail / M.layout.assetSlotStride) * 2;
    for (let d = 0; d < domains; d++) {
      const b = decodeBackingBucket(data, d);
      if (!b) return null;
      const funded = b.status !== BUCKET_EMPTY || b.freshUnliened > 0n || b.validLiened > 0n || b.consumed > 0n || b.impaired > 0n;
      if (funded && b.expirySlot === LP_VAULT_BACKING_EXPIRY_SLOT) return true;
    }
    return false;
  } catch {
    return null;
  }
}

// ── Claim rows ─────────────────────────────────────────────────────────────────────────────────

export type ClaimRowKind = "positions" | "earn" | "stake";

/** The one next action of a row. `none` = nothing for this wallet here. */
export type ClaimAction =
  /** Close and withdraw the wallet's own portfolios here (CloseResolved 30 / top-up 46 / ClosePortfolio 8, owner-signed, one approval). */
  | "close-and-withdraw"
  /** Earn: finish and withdraw on the Earn page (VaultLpSettleResolved 101, then redeem 76 / 77). */
  | "open-earn"
  /** Stake: "Recover to stakers" (stake 29, anyone) on the stake page, before Withdraw. */
  | "recover-to-stakers"
  /** Stake: withdraw on the stake page. */
  | "withdraw-stake"
  | "none";

export type ClaimStatus = "none" | "ready" | "waiting";

export interface ClaimRow {
  kind: ClaimRowKind;
  status: ClaimStatus;
  /** What to do next, in order (stake can have two: recover first, then withdraw). */
  actions: ClaimAction[];
  /** Why a `waiting` row waits: the thing it needs. */
  waitingOn: "positions" | null;
}

export interface ClaimMarketState {
  /** Engine mode byte; only 1 (Resolved) has claims. */
  mode: number;
  resolvedSlot: bigint;
  forceCloseDelaySlots: bigint;
  cTot: bigint;
  materializedPortfolioCount: bigint;
}

export interface ClaimViewer {
  /** The wallet's own portfolios here that still hold something to settle or close. Null = not read yet. */
  positions: number | null;
  /** Earn shares (wallet + escrowed). Null = not read, 0n = none. */
  earnShares: bigint | null;
  /** Stake LP in this market's stake pool. Null = not read, 0n = none or no pool. */
  stakeShares: bigint | null;
  /** The stake pool still has terminal insurance to recover (see {@link stakeRecoverState}). */
  stakeNeedsRecover: boolean;
}

/** Terminal-flat: no portfolio left and no user capital (what Earn redemption and the wrapper's insurance withdraw need). */
export const terminalFlat = (m: ClaimMarketState): boolean => m.materializedPortfolioCount === 0n && m.cTot === 0n;

/**
 * The claim panel's rows, senior first: traders' own positions, then Earn, then stake. Empty for a market that is not Resolved.
 * A row with nothing for the wallet is `none` and has no action (the panel hides it).
 */
export function planClaimRows(m: ClaimMarketState, v: ClaimViewer): ClaimRow[] {
  if (m.mode !== 1) return [];
  const flat = terminalFlat(m);
  const rows: ClaimRow[] = [];
  const hasPositions = (v.positions ?? 0) > 0;
  rows.push({ kind: "positions", status: hasPositions ? "ready" : "none", actions: hasPositions ? ["close-and-withdraw"] : [], waitingOn: null });
  const hasEarn = (v.earnShares ?? 0n) > 0n;
  rows.push({
    kind: "earn",
    status: !hasEarn ? "none" : flat ? "ready" : "waiting",
    actions: hasEarn ? ["open-earn"] : [],
    waitingOn: hasEarn && !flat ? "positions" : null,
  });
  const hasStake = (v.stakeShares ?? 0n) > 0n;
  const stakeActions: ClaimAction[] = hasStake ? [...(v.stakeNeedsRecover ? (["recover-to-stakers"] as const) : []), "withdraw-stake"] : [];
  rows.push({ kind: "stake", status: hasStake ? "ready" : "none", actions: stakeActions, waitingOn: null });
  return rows;
}

// ── Owner-only window ──────────────────────────────────────────────────────────────────────────

export interface OwnerWindow {
  /** The market's `force_close_delay_slots` is set (0 = no owner-only window). */
  configured: boolean;
  /** Now is inside the window: only position owners can settle their positions. */
  ownerOnly: boolean;
  /** Slot the window ends at (`resolved_slot + force_close_delay_slots`), null when none. */
  endsAtSlot: bigint | null;
  /** Estimated wall-clock end (ms since epoch) from the cluster slot at `nowMs`, or null. */
  endsAtMs: number | null;
}

/**
 * The owner-only window (wrapper `handle_close_resolved`: an owner signature is required while
 * `authenticated_slot - resolved_slot < force_close_delay_slots`; `authenticated_slot` = max(Clock, engine clock)).
 */
export function ownerWindow(m: Pick<ClaimMarketState, "resolvedSlot" | "forceCloseDelaySlots">, nowSlot: bigint | null, nowMs: number): OwnerWindow {
  if (m.forceCloseDelaySlots === 0n) return { configured: false, ownerOnly: false, endsAtSlot: null, endsAtMs: null };
  const endsAtSlot = m.resolvedSlot + m.forceCloseDelaySlots;
  if (nowSlot === null) return { configured: true, ownerOnly: false, endsAtSlot, endsAtMs: null };
  const ownerOnly = nowSlot < endsAtSlot;
  return { configured: true, ownerOnly, endsAtSlot, endsAtMs: ownerOnly ? nowMs + Number(endsAtSlot - nowSlot) * SLOT_MS : null };
}

// ── Stake recovery ─────────────────────────────────────────────────────────────────────────────

export interface StakeRecoverState {
  /** The market is Resolved: tag 29 is allowed at all (else Custom 30 MarketNotTerminal). */
  resolved: boolean;
  /** Tag 29 amount to send: the wrapper's terminal insurance capacity (0 = book-only). */
  amount: bigint;
  /** The wrapper still has open portfolios: its terminal insurance withdraw (tag 41) refuses until they are closed. */
  blockedByPositions: boolean;
  /** Offer "Recover to stakers": Resolved, and either insurance to move or a surplus that may need booking. */
  offer: boolean;
}

/**
 * From the market's terminal capacity (lib/v22/sdk/records/stake-wind-down.ts `decodeTerminalInsuranceCapacity(data, 0)`).
 * A Resolved bound pool is always offered the recovery: with `amount` 0 it books a surplus someone else pushed, and the program
 * answers 31 (NothingToRecover) when there is nothing, which the caller shows as "nothing left to recover".
 */
export function stakeRecoverState(cap: { resolved: boolean; terminalCapacity: bigint; materializedPortfolioCount: bigint }): StakeRecoverState {
  const blockedByPositions = cap.materializedPortfolioCount !== 0n;
  return {
    resolved: cap.resolved,
    amount: blockedByPositions ? 0n : cap.terminalCapacity,
    blockedByPositions,
    offer: cap.resolved,
  };
}

// ── Copy ───────────────────────────────────────────────────────────────────────────────────────

export const CLAIM_COPY = {
  title: "This market is settled",
  intro: "Trading has stopped. Pay-backs go in this order: positions, then Earn, then stake.",
  rows: {
    positions: { label: "Your positions", action: "Close and withdraw", hint: "Pays your collateral and profit back to your wallet in one approval." },
    earn: { label: "Your Earn deposit", action: "Open Earn", hint: "Earn is paid after every position has been settled." },
    stake: { label: "Your stake", recover: "Recover to stakers", withdraw: "Open Stake", hint: "Recover to stakers first, then withdraw." },
  },
  waitingOnPositions: "Waiting for open positions to be settled.",
  none: "Nothing of yours is left here.",
  ownerWindow: (until: string): string => `Only position owners can settle a position until ${until}. After that, anyone can settle a position, and the payout still goes to its owner.`,
  ownerWindowOver: "The owner-only window has passed: anyone can settle a position here, and the payout still goes to its owner.",
  ownerWindowNone: "Anyone can settle a position here, and the payout still goes to its owner.",
} as const;

/** The /stake wording for a resolved pool. */
export const RECOVER_COPY = {
  title: "This market is settled",
  body: "Recover to stakers first: it moves the market's remaining insurance back into the pool so every staker can withdraw it. Anyone can run it.",
  button: "Recover to stakers",
  busy: "Recovering…",
  done: "Recovered. You can withdraw now.",
  nothing: "Nothing left to recover. You can withdraw now.",
  waitingOnPositions: "Open positions in this market have to be settled first. Try again once they are.",
  failed: "Couldn't recover right now. Nothing was lost; try again in a moment.",
} as const;

/** Rent line for a v2.2 Earn market (FC-B5): shown instead of a close that the program will always refuse. */
export const EARN_FLOOR_COPY = {
  line: "Rent is not reclaimable on v2.2 Earn markets. The program keeps a small permanent balance in every Earn vault, so the market account can never be closed.",
  action: "Settle and withdraw everything",
  confirmTitle: "Settle this market?",
  confirmBody: "Settling stops trading for good. Then you withdraw your positions, Earn and stake from the market page. The market's rent stays locked.",
  confirm: "Settle market",
  settledToast: "Market settled. Withdraw what is yours from the market page.",
} as const;
