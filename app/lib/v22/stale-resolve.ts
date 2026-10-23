/**
 * ResolveStalePermissionless (wrapper tag 39), in-app port of percolator-sdk feat/v22-sdk-growth
 * `src/abi/v22-resolve.ts` (a18c199): anyone can permanently resolve a Live market whose last good oracle slot is at least
 * `permissionless_resolve_stale_slots` (18,000 slots on the v2.2 markets) behind the cluster.
 *
 * Wire: `[39, now_slot u64 LE]` (9 bytes); one account, the market (writable, no signer besides the fee payer). The program reads the
 * Clock; `now_slot` is only a fallback. Refusals, in order: mode != Live -> 21, Clock < header.current_slot -> 19,
 * not matured -> 27. Pure: no RPC, no React.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { resolveMarketGeometry } from "./sdk/layout";
import { parseWrapperConfigV17 } from "./sdk/slab";

export const TAG_RESOLVE_STALE_PERMISSIONLESS_V22 = 39;

const U64_MAX = (1n << 64n) - 1n;

/** Seconds per slot the app uses for "minutes" copy (400 ms). */
const SLOT_SECONDS = 0.4;

/** `[39, now_slot u64 LE]`. */
export function encodeResolveStalePermissionlessV22(nowSlot: bigint | number): Uint8Array {
  const s = typeof nowSlot === "number" ? BigInt(nowSlot) : nowSlot;
  if (typeof nowSlot === "number" && !Number.isSafeInteger(nowSlot)) throw new Error(`nowSlot ${nowSlot} is not a safe integer; pass a bigint`);
  if (s < 0n || s > U64_MAX) throw new Error(`nowSlot ${s} is not a u64`);
  const out = new Uint8Array(9);
  out[0] = TAG_RESOLVE_STALE_PERMISSIONLESS_V22;
  new DataView(out.buffer).setBigUint64(1, s, true);
  return out;
}

/** The tag-39 instruction. Permissionless: the fee payer is the only signer. */
export function buildResolveStalePermissionlessIxV22(programId: PublicKey, market: PublicKey, nowSlot: bigint | number): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: market, isSigner: false, isWritable: true }],
    data: Buffer.from(encodeResolveStalePermissionlessV22(nowSlot)),
  });
}

export interface StaleResolveStatusV22 {
  /** Raw market mode byte (0 = Live). */
  mode: number;
  /** `permissionless_resolve_stale_slots` (0 = disabled). */
  staleSlots: bigint;
  /** `last_good_oracle_slot`. */
  lastGoodOracleSlot: bigint;
  /** Slot at which the market matures, or null when disabled. */
  maturesAtSlot: bigint | null;
  /** Slots still to wait at `evaluatedAtSlot` (0 once matured), or null when disabled. */
  slotsRemaining: bigint | null;
  /** The cluster slot the prediction was evaluated at. */
  evaluatedAtSlot: bigint;
  /** Slots since the last good price at `evaluatedAtSlot`. */
  ageSlots: bigint;
  /** Tag 39 would resolve the market now. */
  canResolve: boolean;
  /** The refusal tag 39 would return: 21 already resolved, 19 cluster behind the market, 27 not matured. Null when it would pass. */
  refusalCode: 21 | 19 | 27 | null;
}

/**
 * Predict tag 39 from the market bytes (same checks and order as `handle_resolve_stale_permissionless`).
 * Never throws: bytes that are not a v2.2 market (unknown VERSION, short, foreign) give `null`, so nothing is claimed about them.
 */
export function staleResolveStatusV22(marketData: Uint8Array | null | undefined, clusterSlot: bigint | null): StaleResolveStatusV22 | null {
  if (!marketData || clusterSlot === null) return null;
  try {
    const g = resolveMarketGeometry(marketData, { parser: "staleResolveStatusV22", strictLength: false });
    const dv = new DataView(marketData.buffer, marketData.byteOffset, marketData.byteLength);
    const mode = marketData[g.groupOff + g.layout.group.mode] as number;
    const currentSlot = dv.getBigUint64(g.groupOff + g.layout.group.currentSlot, true);
    const cfg = parseWrapperConfigV17(marketData);
    const staleSlots = cfg.permissionlessResolveStaleSlots;
    const lastGood = cfg.lastGoodOracleSlot;
    const ageSlots = clusterSlot > lastGood ? clusterSlot - lastGood : 0n;
    const maturesAtSlot = staleSlots === 0n ? null : lastGood + staleSlots;
    const matured = staleSlots !== 0n && ageSlots >= staleSlots;
    let refusalCode: StaleResolveStatusV22["refusalCode"] = null;
    if (mode !== 0) refusalCode = 21;
    else if (clusterSlot < currentSlot) refusalCode = 19;
    else if (!matured) refusalCode = 27;
    const slotsRemaining = maturesAtSlot === null ? null : maturesAtSlot > clusterSlot ? maturesAtSlot - clusterSlot : 0n;
    return { mode, staleSlots, lastGoodOracleSlot: lastGood, maturesAtSlot, slotsRemaining, evaluatedAtSlot: clusterSlot, ageSlots, canResolve: refusalCode === null, refusalCode };
  } catch {
    return null;
  }
}

/** The market's mode byte is Resolved (terminal). False for anything that is not a v2.2 market. Needs no cluster slot. */
export function marketResolvedV22(marketData: Uint8Array | null | undefined): boolean {
  if (!marketData) return false;
  try {
    const g = resolveMarketGeometry(marketData, { parser: "marketResolvedV22", strictLength: false });
    return marketData[g.groupOff + g.layout.group.mode] === 1;
  } catch {
    return false;
  }
}

/** The notice shows only on a Live market that has matured (never on an unmatured, disabled or already-resolved one). */
export function showStaleSettle(status: StaleResolveStatusV22 | null): status is StaleResolveStatusV22 {
  return status !== null && status.canResolve;
}

/** Whole minutes without a price at `ageSlots` (rounded down: "over N minutes" is always true). */
export function staleMinutes(ageSlots: bigint): number {
  return Math.floor((Number(ageSlots) * SLOT_SECONDS) / 60);
}

export const STALE_SETTLE_COPY = {
  line: (minutes: number): string => `This market has had no price for over ${minutes} minutes and can be settled. Settle it to get your funds back.`,
  lineNoFunds: (minutes: number): string => `This market has had no price for over ${minutes} minutes and can be settled.`,
  button: "Settle market",
  busy: "Settling…",
  settled: "Settled. Your funds are back in your wallet.",
  /** A market that is already settled: the normal Close is replaced by this one. */
  settledLine: "This market is settled. Close your position to get your funds back.",
  settledButton: "Close and withdraw",
  settledNoFunds: "Settled.",
  /** Settled, but the payout needs a moment (a winner is paid after the loser settles). */
  settledPayoutSoon: "The market is settled. Your payout will be ready shortly; try again in a moment.",
  notYet: "This market's price hasn't been missing for long enough to settle yet. Try again in a few minutes.",
  behind: "The network is a little behind. Try again in a moment.",
  alreadySettled: "This market is already settled.",
  cancelled: "Cancelled. Nothing was sent.",
  /** The wallet declined the exit AFTER the market was settled: the market is settled, the funds are still in it. */
  declinedAfterSettle: "The market is settled. Choose Close and withdraw when you are ready to get your funds back.",
  generic: "Couldn't settle the market. Nothing was lost; try again in a moment.",
} as const;

/** Plain copy for a tag-39 refusal code (21 / 19 / 27); null for any other code (the caller's generic line applies). */
export function staleResolveRefusalCopy(code: number): string | null {
  if (code === 27) return STALE_SETTLE_COPY.notYet;
  if (code === 19) return STALE_SETTLE_COPY.behind;
  if (code === 21) return STALE_SETTLE_COPY.alreadySettled;
  return null;
}
