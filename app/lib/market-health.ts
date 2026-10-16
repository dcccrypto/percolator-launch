/**
 * v18 market health: LP depleted, payout haircut, and WHY a market is locked.
 *
 * Replaces the dead v12 signals (SlabProvider `accounts` is always [] on
 * v17/v18, so the old `accounts.find(kind === LP).capital === 0n` check never
 * fired — client gotcha class #2) with fields read from the v18 market bytes.
 *
 * Layout: deployed tree `~/deploycand-v182/percolator-prog@6377376a` + engine
 * `35ddd692` (examples/dump_layout.rs; see lib/self-heal.ts for the shared
 * header/slot offsets). Additional fields used here:
 *   MarketGroupV16HeaderAccount: bankruptcy_hlock_active u8 @621,
 *     threshold_stress_active u8 @622, loss_stale_active u8 @623,
 *     recovery_reason (2 B) @624, mode u8 @626 (MarketModeV16 {Live, Resolved,
 *     Recovery}).
 *   EngineAssetSlotV16Account: source_credit_long @595, source_credit_short
 *     @779 (SourceCreditStateV16Account, 184 B, packed: 11 x u128 then
 *     credit_epoch u64 → positive_claim_bound_num @0, credit_rate_num @160).
 *
 * Payout haircut — the engine's own support formula, aggregated per source
 * domain (engine v16.rs `account_source_realizable_support` +
 * `source_credit_state_realizable_support_for_claim_num` +
 * `available_backing_num_for_source_credit_state`):
 *   - a LIENED claim is paid by its lien: counterparty lien backing (only while
 *     the domain's bucket is Fresh and unexpired — C-S-04 drops it otherwise)
 *     plus insurance lien backing;
 *   - the UNLIENED remainder is paid at `credit_rate_num / CREDIT_RATE_SCALE`
 *     (= available / all claims, capped at available backing).
 *   payout = (validLienedCounterparty? + validLienedInsurance
 *             + available * unliened / claims) / claims
 * All `_num` fields share BOUND_SCALE. This is the market-wide expected rate;
 * an individual account's mix of liened/unliened claim can differ.
 *
 * LP depleted: the matcher LP portfolio's `capital` (read separately — lib/lp-portfolio.ts)
 * is below the engine's IM floor `min_nonzero_im_req`, or 0. The engine runs the initial-margin
 * gate on the LP side of every fill that does not reduce its leg, so below the floor EVERY open reverts Custom(49)
 * (STONK 2026-10-07 at 0.84 USDC; COLLECT/TEXTIT/Murphy 2026-09-29 at 0).
 */
import { decodeAssetVaultLpP3 } from "@/lib/v22/records";
import { layoutOf } from "@/lib/v22/layout";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V21, LAYOUT_V22 } from "@/lib/v22/sdk";
import { decodeMarketLiveness, planLivenessRepairs } from "@/lib/self-heal";
import type { LivenessRepair } from "@/lib/self-heal";
import { TICKET_FUNDS_LINE } from "@/lib/limits/copy";
import { decodeAssetRiskLimits, decodeMarketEngineView } from "@/lib/limits/decode";
import { isAdlReduceOnly } from "@/lib/limits/adl-reduce-only";
import { limitsFlags } from "@/lib/limits/flags";
import { COPY } from "@/lib/limits/copy";
import { closeOnlyDurationLine } from "@/lib/adl-since";

// Geometry comes from the layout table of the account's VERSION (lib/v22/layout.ts): the group / slot numbers below are the
// v2.1 row (592 / 758 / 1024 / 2325, h-lock bytes at mode-5..mode-3, source credit 595/779, backing 963/1060) and
// are kept only for the flag-off slice length. v2.2 (VERSION 19) moves every one of them.
const MARKET_GROUP_OFF = 592;
const MARKET_GROUP_LEN = 758;
// SourceCreditStateV16Account (184 B, packed V16PodU128 x 11 + u64).
const SC_POSITIVE_CLAIM_BOUND = 0;
const SC_FRESH_RESERVED = 32;
const SC_VALID_LIENED_BACKING = 80;
const SC_IMPAIRED_LIENED_BACKING = 96;
const SC_INSURANCE_RESERVED = 112;
const SC_VALID_LIENED_INSURANCE = 128;
const SC_IMPAIRED_LIENED_INSURANCE = 144;
const SC_CREDIT_RATE = 160;
// BackingBucketV16Account inside the engine slot (see self-heal.ts); the slot offsets are layout.engineSlot.backing*.
const BK_EXPIRY = 88;
const BK_STATUS = 96;
export const CREDIT_RATE_SCALE = 1_000_000_000_000n;
/** engine lib.rs:25 — every `_num` field is atoms * BOUND_SCALE. */
export const BOUND_SCALE = 1_000_000_000_000n;
/** Below this much open profit (1 unit of a 6-dp collateral) no haircut is shown. */
export const MIN_HAIRCUT_CLAIM_ATOMS = 1_000_000n;

/** Bytes needed for header + asset slot 0: RPC `dataSlice` length for cheap reads. */
export const MARKET_HEALTH_SLICE_LEN = isDevnetV22Enabled()
  ? Math.max(LAYOUT_V21.marketGroupOff + LAYOUT_V21.marketGroupLen + LAYOUT_V21.assetSlotStride, LAYOUT_V22.marketGroupOff + LAYOUT_V22.marketGroupLen + LAYOUT_V22.assetSlotStride)
  : MARKET_GROUP_OFF + MARKET_GROUP_LEN + 2325;

export type LockReason =
  | "resolved" //       header.mode == Resolved: closes/withdrawals only
  | "recovery" //       header.mode == Recovery
  | "bankruptcy" //     bankruptcy_hlock_active: gates LP-backing/insurance withdrawals only (NOT trading); clears when pnl_pos_tot == 0
  | "loss-stale" //     loss_stale_active: positioned accounts need a refresh crank (keeper); NO duration is promised: it has run for hours
  | "repairable" //     lapsed backing bucket / ResetPending side — self-heal repairs it in your tx
  | "drain-only" //     a side is DrainOnly: only risk-reducing trades on that side
  | "adl-reduce-only"; // F-3: a_long or a_short != ADL_ONE after a bankruptcy ADL — opens blocked, closes via tag 44

export interface DomainPayout {
  domain: number;
  side: "long" | "short";
  hasClaims: boolean;
  /** Realizable support / claims in bps (10000 = full payout). */
  payoutRateBps: number;
  /** Open positive-PnL claims sourced from this domain, collateral atoms. */
  claimAtoms: bigint;
  /** Of which currently realizable, collateral atoms. */
  supportAtoms: bigint;
}

export interface MarketHealth {
  mode: number;
  bankruptcyHlock: boolean;
  thresholdStress: boolean;
  lossStale: boolean;
  domains: DomainPayout[];
  /**
   * Claim-weighted haircut across both domains, in bps: 1 - sum(support)/sum(claims).
   * 0 when there are no claims, or when open profit is below MIN_HAIRCUT_CLAIM_ATOMS
   * (a percentage of a few cents is noise, not a signal).
   */
  payoutHaircutBps: number;
  /** Open positive-PnL claims across both domains, collateral atoms. */
  openProfitAtoms: bigint;
  /** Of which currently realizable, collateral atoms. */
  realizableProfitAtoms: bigint;
  repairs: LivenessRepair[];
  drainOnlySides: ("long" | "short")[];
  /** LP portfolio capital in collateral atoms; null = unknown. */
  lpCapital: bigint | null;
  lpDepleted: boolean;
  /**
   * Asset 0's counterparty is a bound P3 vault LP, so the Earn vault's funds reach it (senior draw).
   * On any other market Earn and staking deposits never reach the counterparty's capital.
   */
  lpIsVault: boolean;
  /**
   * P1 auto-halt (flag NEXT_PUBLIC_LIMITS_P1): LP capital <= the protocol floor
   * (AssetRiskLimitsV17.lp_floor_atoms @ wrapper-slot 608). Capital bounds IM-lane
   * equity from above, so this never shows a halt that is not real; an LP halted
   * by negative pnl/fee debt with capital above the floor is shown on the trade
   * page (useMarketLimits reads the full LP portfolio). False with P1 off.
   */
  lpHalted: boolean;
  lockReasons: LockReason[];
}

function u128(dv: DataView, off: number): bigint {
  return dv.getBigUint64(off, true) | (dv.getBigUint64(off + 8, true) << 64n);
}

/**
 * Decode health from market bytes (full account or a >= MARKET_HEALTH_SLICE_LEN
 * slice from offset 0). Only asset slot 0 is read — every live market is
 * single-asset.
 */
export function decodeMarketHealth(
  data: Uint8Array,
  readSlot: bigint,
  lpCapital: bigint | null,
): MarketHealth {
  if (data.length < MARKET_HEALTH_SLICE_LEN) {
    throw new Error(`decodeMarketHealth: need ${MARKET_HEALTH_SLICE_LEN} bytes, got ${data.length}`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // VERSION-keyed geometry; an unknown VERSION throws the typed UnknownLayoutError (flag on).
  const L = layoutOf(data, "decodeMarketHealth", ACCOUNT_KIND.Market);
  const g = L.marketGroupOff;
  const H_MODE = L.group.mode;
  const H_BANKRUPTCY_HLOCK = H_MODE - 5;
  const H_THRESHOLD_STRESS = H_MODE - 4;
  const H_LOSS_STALE = H_MODE - 3;
  const H_CURRENT_SLOT = L.group.currentSlot;
  const SLOT_SOURCE_CREDIT = [L.engineSlot.sourceCreditLong, L.engineSlot.sourceCreditShort] as const;
  const SLOT_BACKING = [L.engineSlot.backingLong, L.engineSlot.backingShort] as const;
  const mode = data[g + H_MODE];
  // P2b: the byte is 0 (off), 1 (unattributed) or `1 | mask << 1` (attributed). Active = non-zero.
  const bankruptcyHlock = data[g + H_BANKRUPTCY_HLOCK] !== 0;
  const thresholdStress = data[g + H_THRESHOLD_STRESS] === 1;
  const lossStale = data[g + H_LOSS_STALE] === 1;

  const engine = g + L.marketGroupLen + L.wrapperSlotLen;
  const currentSlot = dv.getBigUint64(g + H_CURRENT_SLOT, true);
  const domains: DomainPayout[] = ([0, 1] as const).map((s) => {
    const sc = engine + SLOT_SOURCE_CREDIT[s];
    const claims = u128(dv, sc + SC_POSITIVE_CLAIM_BOUND);
    if (claims === 0n) {
      return { domain: s, side: s === 0 ? "long" : "short", hasClaims: false, payoutRateBps: 10_000, claimAtoms: 0n, supportAtoms: 0n };
    }
    const rd = (o: number) => u128(dv, sc + o);
    const validCp = rd(SC_VALID_LIENED_BACKING);
    const validIns = rd(SC_VALID_LIENED_INSURANCE);
    const liened = validCp + rd(SC_IMPAIRED_LIENED_BACKING) + validIns + rd(SC_IMPAIRED_LIENED_INSURANCE);
    const freshReserved = rd(SC_FRESH_RESERVED);
    const insReserved = rd(SC_INSURANCE_RESERVED);
    const insEncumbered = validIns + rd(SC_IMPAIRED_LIENED_INSURANCE);
    const available =
      (freshReserved > validCp ? freshReserved - validCp : 0n) + (insReserved > insEncumbered ? insReserved - insEncumbered : 0n);
    const rate = rd(SC_CREDIT_RATE);
    const unliened = claims > liened ? claims - liened : 0n;
    const b = engine + SLOT_BACKING[s];
    const bucketLive = data[b + BK_STATUS] === 1 && dv.getBigUint64(b + BK_EXPIRY, true) > currentSlot;
    let unlienedSupport = (unliened * (rate > CREDIT_RATE_SCALE ? CREDIT_RATE_SCALE : rate)) / CREDIT_RATE_SCALE;
    if (unlienedSupport > available) unlienedSupport = available;
    let support = (bucketLive ? validCp : 0n) + validIns + unlienedSupport;
    if (support > claims) support = claims;
    return {
      domain: s,
      side: s === 0 ? "long" : "short",
      hasClaims: true,
      payoutRateBps: Number((support * 10_000n) / claims),
      claimAtoms: claims / BOUND_SCALE,
      supportAtoms: support / BOUND_SCALE,
    };
  });
  const openProfitAtoms = domains.reduce((a, d) => a + d.claimAtoms, 0n);
  const realizableProfitAtoms = domains.reduce((a, d) => a + d.supportAtoms, 0n);
  const payoutHaircutBps =
    openProfitAtoms >= MIN_HAIRCUT_CLAIM_ATOMS && openProfitAtoms > 0n
      ? 10_000 - Number((realizableProfitAtoms * 10_000n) / openProfitAtoms)
      : 0;

  const liveness = decodeMarketLiveness(data, readSlot);
  const repairs = planLivenessRepairs(liveness).filter((r) => (r.kind === "expire" ? r.domain < 2 : r.assetIndex === 0));
  const drainOnlySides = liveness.sides
    .filter((x) => x.assetIndex === 0 && x.mode === 1)
    .map((x): "long" | "short" => (x.side === 0 ? "long" : "short"));

  // Engine v16.rs margin_requirement: IM(q) = max(ceil(q·p·im_bps/1e4), min_nonzero_im_req), checked on
  // BOTH accounts of a fill. The deployed wrapper clips every fill to the LP's exposure cap (equity x
  // 1e4/im_bps), so the LP's proportional IM never exceeds its equity and the one LP-side failure left
  // is the floor: measured on STONK, LP 1.999999 USDC -> Custom(49) on every open, 2.000000 -> fills.
  // The route serves `capital`, which bounds the engine equity from above unless the LP holds realizable
  // positive pnl (v16.rs account_haircut_equity): a sub-floor LP reads as paused even in the rare case a
  // winning leg would let it fill, and an LP dragged under the floor by losses or fee debt alone is missed.
  // Read here, not via lib/v17-engine-config (its module-scope SDK import breaks tests that mock the SDK
  // partially): V16ConfigAccount sits at MARKET_GROUP_OFF + 32 (group header), min_nonzero_im_req at
  // +22 (u128), the same offsets v17-engine-config.ts documents. A floor of 0 keeps the exact-zero rule.
  const LP_IM_FLOOR_OFF = MARKET_GROUP_OFF + 32 + 22;
  const lpImFloor = data.length >= LP_IM_FLOOR_OFF + 16 ? u128(dv, LP_IM_FLOOR_OFF) : 0n;
  const lpDepleted = lpCapital !== null && (lpCapital === 0n || lpCapital < lpImFloor);
  let lpIsVault = false;
  try {
    lpIsVault = decodeAssetVaultLpP3(data, 0).bound === true;
  } catch {
    // Older layout / undecodable: treat as a non-vault counterparty.
  }
  const p1Limits = limitsFlags().p1 ? decodeAssetRiskLimits(data, 0) : null;
  const lpHalted = p1Limits !== null && lpCapital !== null && lpCapital <= p1Limits.lpFloorAtoms;
  const lockReasons: LockReason[] = [];
  if (mode === 1) lockReasons.push("resolved");
  if (mode === 2) lockReasons.push("recovery");
  if (bankruptcyHlock) lockReasons.push("bankruptcy");
  if (lossStale) lockReasons.push("loss-stale");
  if (repairs.length > 0) lockReasons.push("repairable");
  if (drainOnlySides.length > 0) lockReasons.push("drain-only");
  // F-3 / R1 (not flag-gated: deployed v18.2 engine behaviour, v16.rs:15883).
  if (isAdlReduceOnly(decodeMarketEngineView(data, 0))) lockReasons.push("adl-reduce-only");

  return {
    mode,
    bankruptcyHlock,
    thresholdStress,
    lossStale,
    domains,
    payoutHaircutBps,
    openProfitAtoms,
    realizableProfitAtoms,
    repairs,
    drainOnlySides,
    lpCapital,
    lpDepleted,
    lpIsVault,
    lpHalted,
    lockReasons,
  };
}

export type HealthBadgeTone = "danger" | "warning" | "info";
export interface HealthBadge {
  id: "v1" | "lp-depleted" | "lp-halted" | "adl-reduce-only" | "payout-haircut" | "resolved" | "recovery" | "bankruptcy" | "loss-stale" | "repairable" | "drain-only";
  label: string;
  tone: HealthBadgeTone;
  detail: string;
}

/** Format bps as a percent with at most one decimal ("12.5%", "0.1%", "100%"). */
export function formatBpsPercent(bps: number): string {
  const pct = bps / 100;
  const s = pct >= 10 || Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1);
  return `${s}%`;
}

/**
 * A "dead" (v1, close-only) market: ADL reduce-only after a bankruptcy, or recovery mode. Opens stay blocked
 * until the engine itself recovers; closing and withdrawing still work. Derived from on-chain state only.
 * An LP-depleted market is NOT dead: a brand-new market waits for its first deposit, and funding it reopens it
 * (it gets "Needs liquidity" instead).
 */
export function isDeadMarket(h: Pick<MarketHealth, "lockReasons">): boolean {
  return h.lockReasons.includes("adl-reduce-only") || h.lockReasons.includes("recovery");
}

/** "No room for new positions": LP capital 0 or at the floor. Recoverable by funding, so not "dead". */
export function needsLiquidity(h: Pick<MarketHealth, "lpDepleted" | "lpHalted">): boolean {
  return h.lpDepleted || h.lpHalted;
}

/** The label that marks a market of the first generation that can now only be closed. */
export const V1_BADGE_LABEL = "v1";

/**
 * Badges for market cards / the trade page, most severe first. Pure.
 * `adlSinceMs` = when this market was first seen close-only (lib/adl-since.ts), `nowMs` the clock for its duration.
 */
export function healthBadges(h: MarketHealth, adlSinceMs: number | null = null, nowMs: number = Date.now()): HealthBadge[] {
  const out: HealthBadge[] = [];
  if (h.lockReasons.includes("resolved")) {
    out.push({ id: "resolved", label: "Settled", tone: "danger", detail: "This market has settled. Close any position and withdraw; there's nothing else to do." });
  }
  if (h.lockReasons.includes("recovery")) {
    out.push({ id: "recovery", label: "Close-only", tone: "danger", detail: "Closing works normally; new positions reopen on their own once the market recovers." });
  }
  if (h.lpHalted) {
    // P1: supersedes "LP depleted" (a depleted LP is halted under P1, and closes still work).
    out.push({
      id: "lp-halted",
      label: "Needs liquidity",
      tone: "danger",
      detail: "The market has no room for new positions right now. Closing works normally.",
    });
  } else if (h.lpDepleted) {
    out.push({
      id: "lp-depleted",
      label: "Needs liquidity",
      tone: "danger",
      detail: h.lpIsVault
        ? "Needs liquidity: deposit in Earn to reopen new positions. Closing works normally."
        : `${TICKET_FUNDS_LINE(false)} Closing works normally.`,
    });
  }
  if (h.payoutHaircutBps > 0) {
    out.push({
      id: "payout-haircut",
      label: `Payout haircut ${formatBpsPercent(h.payoutHaircutBps)}`,
      tone: h.payoutHaircutBps >= 1000 ? "danger" : "warning",
      detail:
        `Winning positions can currently realize ${formatBpsPercent(10_000 - h.payoutHaircutBps)} of their open profit: ` +
        "the backing from the losing side covers only part of it right now. Losses are not affected.",
    });
  }
  if (h.lockReasons.includes("adl-reduce-only")) {
    out.push({
      id: "adl-reduce-only",
      label: "Close-only",
      tone: "warning",
      detail: [COPY.adlReduceOnly, closeOnlyDurationLine(adlSinceMs, nowMs)].filter(Boolean).join(" "),
    });
  }
  if (h.lockReasons.includes("bankruptcy")) {
    // The h-lock gates ONLY LP-backing / insurance withdrawals and admin oracle reconfiguration
    // (wrapper tags 50/52/57); trading, deposits, user withdrawals and liquidations are unaffected.
    // Info tone + not a list badge + not a header state: it is surfaced only where badges are
    // rendered in full, never as a trading lock.
    out.push({ id: "bankruptcy", label: "LP withdrawals paused", tone: "info", detail: "LP and insurance withdrawals are paused until open profits in this market are settled. Trading, closing and your own deposits and withdrawals are not affected." });
  }
  if (h.lockReasons.includes("drain-only")) {
    out.push({ id: "drain-only", label: `${h.drainOnlySides.join(" & ")} close-only`, tone: "warning", detail: "One side of this market only accepts trades that reduce positions right now." });
  }
  if (h.lockReasons.includes("repairable")) {
    out.push({ id: "repairable", label: "Catching up", tone: "info", detail: "The market is catching up. Your next transaction includes the update automatically." });
  }
  if (h.lockReasons.includes("loss-stale")) {
    out.push({ id: "loss-stale", label: "Refreshing", tone: "info", detail: "Positions are being refreshed after a price move. New positions wait until that finishes." });
  }
  if (isDeadMarket(h)) {
    // Right after the first close-only badge, so a two-badge market card shows "Close-only" and "v1".
    const first = out.findIndex((b) => b.id === "recovery" || b.id === "lp-halted" || b.id === "lp-depleted" || b.id === "adl-reduce-only");
    out.splice(first + 1, 0, {
      id: "v1",
      label: V1_BADGE_LABEL,
      tone: "info",
      detail: "This is a v1 market and it is close-only for now: you can close positions and withdraw, but not open new ones.",
    });
  }
  return out;
}

// ── /api/markets/health wire (route + client hook share these) ──────────────

export const MAX_HEALTH_SLABS = 50;

/** JSON row served by /api/markets/health (bigints as decimal strings). */
export interface MarketHealthRow {
  lpCapital: string | null;
  lpDepleted: boolean;
  /** See MarketHealth.lpIsVault. Optional: a cached row from before this field reads as false. */
  lpIsVault?: boolean;
  payoutHaircutBps: number;
  openProfitAtoms: string;
  realizableProfitAtoms: string;
  lockReasons: LockReason[];
  badges: HealthBadge[];
  /** Unix ms this market was first seen close-only (ADL); null/absent = not close-only or unknown. A lower bound. */
  adlSinceMs?: number | null;
}

/** `slabs` query param → distinct canonical base58 keys, or null if invalid / empty / > MAX. */
export function parseSlabsParam(raw: string | null): string[] | null {
  if (!raw) return null;
  const parts = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (parts.length === 0 || parts.length > MAX_HEALTH_SLABS) return null;
  for (const p of parts) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p)) return null;
  }
  return parts;
}
