/**
 * A market whose price never connected (launch #3637): pure classification and copy. No RPC, no React.
 *
 * What the chain can tell a creator, in order of strength:
 *  1. Whether any price was ever pushed. `last_good_oracle_slot` (WrapperConfigV16, config +152) is written by InitMarket (the
 *     creation slot) and by ConfigureAuthMark / ConfigureHybridOracle / ConfigureEwmaMark (launch-time config, tags 62 / 34 / 35,
 *     which can land tens to hundreds of slots after creation), and advanced by every accepted price push (tags 63 PushAuthMark,
 *     36 PushEwmaMark; `max(cfg.last_good_oracle_slot, authenticated_slot)`, asset 0; percolator-prog aca02ba6
 *     `src/v16_program.rs`). So the decisive read is the transaction AT `last_good_oracle_slot`: launch-time config means no price
 *     was ever pushed (lib/v22/creator-onchain.ts `readNeverPushed`). Only when that cannot be read does the creation-slot
 *     fallback apply, with a wide slack and a staleness requirement.
 *  2. The registration refusal (#3676: a final refusal such as oracle-not-keeper). It corroborates; it never overrides a
 *     chain read that shows a price was pushed. Alone (history unreadable) it also needs the price to be stale today.
 *
 * What happens next (percolator-prog `permissionless_stale_matured`): once `now - last_good_oracle_slot >=
 * permissionless_resolve_stale_slots` (18,000 slots, about 2 hours, on every wizard launch) ANYONE can send tag 39 and
 * the market settles at its last price. A market with 0 there has no permissionless path.
 */
import { PublicKey } from "@solana/web3.js";
import { staleResolveStatusV22, type StaleResolveStatusV22 } from "./stale-resolve";
import { parseWrapperConfigV17 } from "./sdk/slab";
import { readLaunchFootprint } from "@/lib/unfinished-launch";

/** Seconds per slot used for countdown copy (matches lib/v22/stale-resolve.ts). */
const SLOT_SECONDS = 0.4;

/**
 * FALLBACK only (when the transaction at `last_good_oracle_slot` cannot be read): a launch is several transactions, so
 * `last_good_oracle_slot` (written again by ConfigureAuthMark, tag 62) can sit tens to hundreds of slots after the creation
 * slot (devnet gaps seen: 37, 47, 60, up to 516). The fallback therefore allows 1,000 slots (about 7 minutes) AND requires the
 * market to be stale (see `staleEnough`).
 */
export const NEVER_CONNECTED_FALLBACK_SLACK_SLOTS = 1_000n;

/** A market younger than this (about 10 minutes) is not called never-connected: its first push may simply not have landed yet. */
export const LAUNCH_WAIT_SLOTS = 1_500n;

/** Wrapper tags that set `last_good_oracle_slot` at LAUNCH time and carry no price: InitMarket 0, ConfigureHybridOracle 34, ConfigureEwmaMark 35, ConfigureAuthMark 62. */
export const LAUNCH_TIME_TAGS: readonly number[] = [0, 34, 35, 62];
/** Tags that deliver a price: PushEwmaMark 36, PushAuthMark / PushAuthMarkDepth 63. Any tag outside both lists counts as a price too (conservative). */
export const PUSH_TAGS: readonly number[] = [36, 63];

export type NeverConnectedEvidence = "chain" | "chain+registration" | "registration";

/** waiting: Live, not matured. settle: Live, anyone can settle now. no-path: Live, no permissionless window at all. settled: Resolved. */
export type NeverConnectedPhase = "waiting" | "settle" | "no-path" | "settled";

export interface NeverConnectedView {
  phase: NeverConnectedPhase;
  evidence: NeverConnectedEvidence;
  /** `permissionless_resolve_stale_slots` (0 = disabled). */
  staleSlots: bigint;
  /** Slots until the market can be settled (0 once matured); null when there is no permissionless window. */
  slotsRemaining: bigint | null;
  status: StaleResolveStatusV22;
}

export interface NeverConnectedInput {
  /** Market account bytes. */
  raw: Uint8Array | null | undefined;
  clusterSlot: bigint | null;
  /** Oldest successful transaction slot on the slab, or null when it could not be read. */
  creationSlot: bigint | null;
  /**
   * Decided from the transaction at `last_good_oracle_slot` (lib/v22/creator-onchain.ts): true = it was launch-time configuration
   * (no price ever pushed), false = a price push, null/absent = could not be read (the slack fallback applies).
   */
  neverPushed?: boolean | null;
  /** #3676: the keeper registration was refused for good for this market. Optional; absent means "not known". */
  registrationRefused?: boolean;
}

/** FALLBACK rule: `last_good_oracle_slot` is within the fallback slack of the creation slot. */
export function priceNeverAdvanced(lastGoodOracleSlot: bigint, creationSlot: bigint): boolean {
  return lastGoodOracleSlot <= creationSlot + NEVER_CONNECTED_FALLBACK_SLACK_SLOTS;
}

/** The price has been missing for a large part of the stale window (or, with no window, at least 9,000 slots). */
export function staleEnough(status: StaleResolveStatusV22): boolean {
  return status.staleSlots > 0n ? status.ageSlots * 2n >= status.staleSlots : status.ageSlots >= 9_000n;
}

/**
 * Null unless this market is (still) a never-connected one. A market whose price was pushed is NOT never-connected even if its
 * registration was refused. Evidence order: the transaction read (`neverPushed`), else the creation-slot fallback + staleness,
 * else a recorded refusal alone, which also needs the price to be stale today (a permanent flag never overrides a current price).
 * A young market (< LAUNCH_WAIT_SLOTS) is never listed on chain evidence alone.
 */
export function neverConnectedView(i: NeverConnectedInput): NeverConnectedView | null {
  if (!i.raw || i.clusterSlot === null) return null;
  const status = staleResolveStatusV22(i.raw, i.clusterSlot);
  if (status === null) return null;
  const refused = i.registrationRefused === true;
  const np = i.neverPushed ?? null;
  if (np === false) return null;
  const launchAge = i.clusterSlot - (i.creationSlot ?? status.lastGoodOracleSlot);
  let chain: boolean;
  if (np === true) chain = true;
  else chain = i.creationSlot !== null && priceNeverAdvanced(status.lastGoodOracleSlot, i.creationSlot) && staleEnough(status);
  let evidence: NeverConnectedEvidence;
  if (chain && (launchAge > LAUNCH_WAIT_SLOTS || refused)) evidence = refused ? "chain+registration" : "chain";
  else if (refused && staleEnough(status)) evidence = "registration";
  else return null;
  const mode = status.mode;
  const staleSlots = status.staleSlots;
  if (mode === 1) return { phase: "settled", evidence, staleSlots, slotsRemaining: null, status };
  if (mode !== 0) return null; // Recovery or unknown: nothing is claimed
  if (staleSlots === 0n) return { phase: "no-path", evidence, staleSlots, slotsRemaining: null, status };
  if (status.canResolve) return { phase: "settle", evidence, staleSlots, slotsRemaining: 0n, status };
  return { phase: "waiting", evidence, staleSlots, slotsRemaining: status.slotsRemaining, status };
}

/** "under a minute", "about 12 minutes", "about 1 hour 5 minutes" (rounded up: never promises sooner than it is). */
export function formatSlotsAsTime(slots: bigint): string {
  const seconds = Math.ceil(Number(slots) * SLOT_SECONDS);
  if (seconds < 60) return "under a minute";
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `about ${totalMinutes} ${totalMinutes === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const hours = `${h} ${h === 1 ? "hour" : "hours"}`;
  return m === 0 ? `about ${hours}` : `about ${hours} ${m} ${m === 1 ? "minute" : "minutes"}`;
}

export type RefundNetwork = "mainnet" | "devnet";

/** What the market actually has, read from its bytes: decides which steps and which rent lines are true for it. */
export interface MarketFeatures {
  /** An Earn (vault LP) seed is on the market: its Earn floor bucket is funded. */
  earn: boolean;
  /** A stake pool is bound (marketauth is no longer the creator wallet). */
  stake: boolean;
}

/** Unknown is shown as "has both": steps are worded "if you ..." and nothing is hidden from someone who needs it. */
export const UNKNOWN_FEATURES: MarketFeatures = { earn: true, stake: true };

export const NEVER_CONNECTED_COPY = {
  title: "The price for this market never connected",
  /** Always true once classified: no price was ever accepted, so nobody could trade it. */
  lead: "No price was ever accepted for this market, so it could not trade.",
  registrationOnly: "The live-price connection for this market was refused, and the price history could not be read. Treat the price as not connected.",
  waiting: (t: string): string => `Anyone can settle this market once its price has been missing for the stale window. That is ${t} from now.`,
  settle: "The stale window has passed. Anyone can settle this market now, and you can do it from here.",
  noPath: "This market has no permissionless settle window, so nobody but its operator can settle it. There is no automatic path from here.",
  settled: "This market is settled. Take your money out with the steps below.",
  settleNote:
    "Your wallet asks to approve the settle first. If you hold funds here, a second approval closes your trading account and returns its collateral. Settling cannot be undone.",
  /** Shown instead of the generic "funds are back" line: that line is only true for the trading account. */
  settledDone: "Settled. Your trading account's funds are back in your wallet. Anything you seeded into Earn or the stake pool is still to be taken out with the steps below.",
  stepsTitle: "Get your money back",
  rentTitle: "What about the rent?",
  rentEarn:
    "The market account's rent cannot be reclaimed on chain: closing a market is refused while its Earn floor is funded, which is every Earn market.",
  rentNoEarn: "This market has no Earn pool, so its admin can close the market account and get its rent back.",
  rentStake: "The stake pool, vault and LP-mint account rent is not returned by any instruction either.",
  rentFreed: "Your trading account's rent comes back when you close it.",
  rentMainnet: "On mainnet the treasury refunds that locked rent to the creator of a market whose price never connected.",
  rentDevnet: "On devnet no rent refund is paid: devnet SOL comes from a faucet. The settle and withdraw path above works the same.",
  noFund: "Transaction fees are not refunded.",
} as const;

export interface RecoverStep {
  id: "portfolio" | "earn" | "stake";
  title: string;
  body: string;
  /** Existing flow it points at (nothing is rebuilt here). */
  href: (slab: string) => string;
  linkLabel: string;
}

const STEP_DEFS: readonly RecoverStep[] = [
  {
    id: "portfolio",
    title: "Your own portfolio",
    body: "Settle the market with the button above. It also closes your trading account and returns the collateral and the account rent.",
    href: () => "/portfolio",
    linkLabel: "Open portfolio",
  },
  {
    id: "earn",
    title: "Your Earn seed",
    body: "Once the market is settled, withdraw the liquidity you seeded from the market's Earn page.",
    href: (slab) => `/earn/${slab}`,
    linkLabel: "Open Earn",
  },
  {
    id: "stake",
    title: "Your stake pool seed",
    body: "Recover the pool's insurance seed on the stake page. Anyone can start it; the part booked to you comes back to your wallet.",
    href: () => "/stake",
    linkLabel: "Open Stake",
  },
];

/** The existing exits that apply to this market, numbered in the order that pays out (senior first). Wrapper tags: portfolio 30/46/8, Earn 101 then 76/77, stake 29. */
export function recoverSteps(f: MarketFeatures): RecoverStep[] {
  return STEP_DEFS.filter((s) => s.id === "portfolio" || (s.id === "earn" ? f.earn : f.stake)).map((s, i) => ({ ...s, title: `${i + 1}. ${s.title}` }));
}

/**
 * The rent lines for this market and cluster: only what is true for its features, then the policy for THIS cluster, and only when
 * something is actually locked (the Earn market account or the stake pool accounts).
 */
export function rentRefundCopy(network: RefundNetwork, f: MarketFeatures = UNKNOWN_FEATURES): string[] {
  const C = NEVER_CONNECTED_COPY;
  const lines: string[] = [f.earn ? C.rentEarn : C.rentNoEarn];
  if (f.stake) lines.push(C.rentStake);
  lines.push(C.rentFreed);
  if (f.earn || f.stake) lines.push(network === "mainnet" ? C.rentMainnet : C.rentDevnet);
  lines.push(C.noFund);
  return lines;
}

/** The status line for a phase. */
export function phaseLine(v: NeverConnectedView): string {
  switch (v.phase) {
    case "waiting":
      return NEVER_CONNECTED_COPY.waiting(formatSlotsAsTime(v.slotsRemaining ?? 0n));
    case "settle":
      return NEVER_CONNECTED_COPY.settle;
    case "no-path":
      return NEVER_CONNECTED_COPY.noPath;
    case "settled":
      return NEVER_CONNECTED_COPY.settled;
  }
}

/**
 * What this market has, from its bytes. Earn: a vault-LP backing bucket is funded (the Earn floor; lib/unfinished-launch.ts).
 * Stake: `marketauth` is neither the creator wallet (an unfinished launch) nor zero (burned). Unreadable = both (UNKNOWN_FEATURES).
 */
export function marketFeatures(raw: Uint8Array | null | undefined, wallet: PublicKey | null): MarketFeatures {
  if (!raw) return UNKNOWN_FEATURES;
  const fp = readLaunchFootprint(raw);
  let stake = true;
  try {
    const auth = parseWrapperConfigV17(raw).marketauth;
    stake = !(wallet !== null && auth.equals(wallet)) && !auth.equals(PublicKey.default);
  } catch {
    stake = true;
  }
  return { earn: fp ? fp.backingFunded : true, stake };
}
