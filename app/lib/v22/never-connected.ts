/**
 * A market whose price never connected (launch #3637): pure classification and copy. No RPC, no React.
 *
 * What the chain can tell a creator, in order of strength:
 *  1. `last_good_oracle_slot` (WrapperConfigV16, config +152). InitMarket writes it as the creation slot
 *     (percolator-prog aca02ba6 `src/v16_program.rs` ~4812, `last_good_oracle_slot: slot`); every accepted price push
 *     advances it (`max(cfg.last_good_oracle_slot, authenticated_slot)`, asset 0). So "never connected" is
 *     `last_good_oracle_slot` still at the creation slot. The creation slot is the oldest successful transaction on the
 *     slab (lib/v22/creator-onchain.ts); the slack below absorbs a slab created a few slots before InitMarket.
 *  2. The registration refusal (#3676: a final refusal such as oracle-not-keeper). It corroborates; it never overrides a
 *     chain read that shows the price did advance. It is the only signal when the creation slot cannot be read.
 *
 * What happens next (percolator-prog `permissionless_stale_matured`): once `now - last_good_oracle_slot >=
 * permissionless_resolve_stale_slots` (18,000 slots, about 2 hours, on every wizard launch) ANYONE can send tag 39 and
 * the market settles at its last price. A market with 0 there has no permissionless path.
 */
import { staleResolveStatusV22, type StaleResolveStatusV22 } from "./stale-resolve";

/** Seconds per slot used for countdown copy (matches lib/v22/stale-resolve.ts). */
const SLOT_SECONDS = 0.4;

/**
 * A price push this many slots (or fewer) after the creation slot still counts as "no price ever": covers a slab that was
 * created in a transaction slightly before InitMarket. Small on purpose (about 13 seconds).
 */
export const NEVER_CONNECTED_SLACK_SLOTS = 32n;

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
  /** #3676: the keeper registration was refused for good for this market. Optional; absent means "not known". */
  registrationRefused?: boolean;
}

/** `last_good_oracle_slot` has not moved off the creation slot. */
export function priceNeverAdvanced(lastGoodOracleSlot: bigint, creationSlot: bigint): boolean {
  return lastGoodOracleSlot <= creationSlot + NEVER_CONNECTED_SLACK_SLOTS;
}

/**
 * Null unless this market is (still) a never-connected one. A market whose price advanced after creation is NOT
 * never-connected even if its registration was refused: a push did land.
 */
export function neverConnectedView(i: NeverConnectedInput): NeverConnectedView | null {
  if (!i.raw || i.clusterSlot === null) return null;
  const status = staleResolveStatusV22(i.raw, i.clusterSlot);
  if (status === null) return null;
  const mode = status.mode;
  let evidence: NeverConnectedEvidence;
  if (i.creationSlot !== null) {
    if (!priceNeverAdvanced(status.lastGoodOracleSlot, i.creationSlot)) return null;
    evidence = i.registrationRefused === true ? "chain+registration" : "chain";
  } else if (i.registrationRefused === true) {
    evidence = "registration";
  } else {
    return null;
  }
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

export const NEVER_CONNECTED_COPY = {
  title: "The price for this market never connected",
  /** Always true once classified: no price was ever accepted, so nobody could trade it. */
  lead: "No price was ever accepted for this market, so it could not trade.",
  registrationOnly: "The live-price connection for this market was refused, and the price history could not be read. Treat the price as not connected.",
  waiting: (t: string): string => `Anyone can settle this market once its price has been missing for the stale window. That is ${t} from now.`,
  settle: "The stale window has passed. Anyone can settle this market now, and you can do it from here.",
  noPath: "This market has no permissionless settle window, so nobody but its operator can settle it. There is no automatic path from here.",
  settled: "This market is settled. Take your money out with the steps below.",
  settleNote: "Settling closes your trading account and returns its funds to your wallet in one approval. It cannot be undone.",
  stepsTitle: "Get your money back",
  rentTitle: "What about the rent?",
  rentOnChain:
    "On chain, the market account's rent and the stake pool, vault and LP-mint account rent are not returned by any instruction, so they stay locked. Your deposited collateral, your trading account's rent and your Earn seed can all be taken back.",
  rentMainnet:
    "On mainnet the treasury refunds that locked rent to the creator of a market whose price never connected.",
  rentDevnet:
    "On devnet no rent refund is paid: devnet SOL comes from a faucet. The settle and withdraw path above works the same.",
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

/** The existing exits, in the order that pays out (senior first). Wrapper tags: portfolio 30/46/8, Earn 101 then 76/77, stake 29. */
export const RECOVER_STEPS: readonly RecoverStep[] = [
  {
    id: "portfolio",
    title: "1. Your own portfolio",
    body: "Settle the market with the button above. It also closes your trading account and returns the collateral and the account rent.",
    href: () => "/portfolio",
    linkLabel: "Open portfolio",
  },
  {
    id: "earn",
    title: "2. Your Earn seed",
    body: "Once the market is settled, withdraw the liquidity you seeded from the market's Earn page.",
    href: (slab) => `/earn/${slab}`,
    linkLabel: "Open Earn",
  },
  {
    id: "stake",
    title: "3. Your stake pool seed",
    body: "Recover the pool's insurance seed on the stake page. Anyone can start it; the part booked to you comes back to your wallet.",
    href: () => "/stake",
    linkLabel: "Open Stake",
  },
];

/** The rent paragraph for the cluster the app is on: the on-chain facts, then the policy for THIS cluster only. */
export function rentRefundCopy(network: RefundNetwork): string[] {
  return [NEVER_CONNECTED_COPY.rentOnChain, network === "mainnet" ? NEVER_CONNECTED_COPY.rentMainnet : NEVER_CONNECTED_COPY.rentDevnet, NEVER_CONNECTED_COPY.noFund];
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
