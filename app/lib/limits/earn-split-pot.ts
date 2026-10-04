/**
 * Earn on a NON-bound (two-pot) vault: what ExecuteRedemption (77) can pay now, and the one repair
 * the app still has to send.
 *
 * Deployed wrapper 553d76f0 (PR #522, live 2026-10-01): a non-bound 77 prices AND pays across both
 * pots. When the payout pot is short it tops itself up from the sibling inside 77
 * (`vault_pot_top_up_from_sibling`, non-bound rules: ledger AVAILABLE principal, sibling clamped to
 * its own available principal and free backing) and relabels the sibling's earnings
 * (`vault_pot_earnings_top_up_from_sibling`). So the app sends 77 alone; the old [91, 77] prefix
 * (#2764) is gone. Verified live on devnet 2026-10-02 (PERC 9EPm8nB8): a plain 77 paid, and
 * [91 drain the payout pot, plain 77] paid with `p3_redeem_pot_top_up from=1 to=0`.
 *
 * What #522 does not cover (M-1, live on SI 8WC8vALs 2026-10-02): a pot whose booked loss exceeds
 * its ledger principal (traders won more than that pot's principal). Every pricing of the vault
 * (75 deposit, 77 payout) then underflows (Custom 25) for every depositor. The program's repair is
 * permissionless RebalanceLpVaultBacking (91) from the healthy pot into the underwater one, of at
 * least the deficit (`loss - recovery - principal`); one atom short still fails. No tokens move and
 * both pots belong to the same holders, so the vault's value after the move is exactly its true
 * value (the loss is shared). `repairUnderwaterPot` plans it; the app prepends it to the user's
 * own 75 / 77.
 *
 * A 100% exit can still fail 77's stay-fully-backed gate (Custom 21: the pot's source credit rate
 * must stay at scale while traders hold positive claims against it). `planSplitPotRedemption` is
 * that gate solved for shares, so the app can offer "Withdraw max available now" instead.
 *
 * Every formula mirrors the deployed wrapper (percolator-prog 553d76f0, src/v16_program.rs):
 *   - sync_backing_domain_ledger / lp_vault_domain_available_principal_atoms / lp_vault_nav_atoms
 *   - handle_rebalance_lp_vault_backing (source gates, available-principal clamp, refill)
 *   - handle_execute_redemption (+ vault_pot_free_backing_num and both sibling top-ups)
 * Pure; the hook reads the accounts.
 */
import { SystemProgram, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNTS_REBALANCE_LP_VAULT_BACKING,
  WELL_KNOWN,
  buildAccountMetas,
  buildIx,
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  encodeRebalanceLpVaultBacking,
  parseLpVaultRegistry,
} from "@percolatorct/sdk";
import * as C from "./constants";
import { decodeLpVaultRegistryBound, decodeLpVaultRegistryOiThresholdBps, decodeMarketEngineView, decodeResolvedMarket, u128 } from "./decode";
import { harvestableFeeAtoms } from "./vault-tranche";
import { earnNavFloorLive } from "@/lib/program-upgrade-detect";

const BS = C.BOUND_SCALE;

/** `BackingBucketStatusV16::Fresh`. */
export const BUCKET_STATUS_FRESH = 1;
/** CancelRedemption (tag 81): data is the tag alone. */
export const TAG_CANCEL_REDEMPTION = 81;
/** Headroom kept below the exact cap: claims can grow between the request and the payout. */
export const SPLIT_POT_CAP_SAFETY_BPS = 10n; // 0.1%

export interface BackingBucket {
  freshUnliened: bigint;
  validLiened: bigint;
  consumed: bigint;
  impaired: bigint;
  utilFeeEarnings: bigint;
  status: number;
  /** `expiry_slot` (read by decodeBackingBucket; optional so hand-built test buckets stay valid). */
  expirySlot?: bigint;
}

export interface SourceCredit {
  positiveClaimBound: bigint;
  freshReserved: bigint;
  validLienedBacking: bigint;
  insuranceCreditReserved: bigint;
  validLienedInsurance: bigint;
  impairedLienedInsurance: bigint;
}

export interface DomainLedger {
  totalPrincipal: bigint;
  totalEarnings: bigint;
  totalEarningsWithdrawn: bigint;
  lastObsBucketEarnings: bigint;
  cumulativeLoss: bigint;
  cumulativeRecovery: bigint;
  lastObsUnavailable: bigint;
}

export interface DomainState {
  bucket: BackingBucket;
  source: SourceCredit;
  /** null = the ledger account does not exist yet (the program seeds it from the bucket). */
  ledger: DomainLedger | null;
}

// ── Decoders (asset 0; domain even = long, odd = short) ─────────────────────────────────────

const SOURCE_LONG = C.SLOT_BACKING_LONG - 368;
const SOURCE_SHORT = C.SLOT_BACKING_LONG - 184;

function dv64(d: Uint8Array, off: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(off, true);
}

export function decodeBackingBucket(d: Uint8Array, domain: number): BackingBucket | null {
  const b = C.assetEngineOff(Math.floor(domain / 2)) + (domain % 2 === 0 ? C.SLOT_BACKING_LONG : C.SLOT_BACKING_SHORT);
  if (d.length < b + 97) return null;
  return {
    freshUnliened: u128(d, b + 8),
    validLiened: u128(d, b + 24),
    consumed: u128(d, b + 40),
    impaired: u128(d, b + 56),
    utilFeeEarnings: u128(d, b + 72),
    status: d[b + 96],
    expirySlot: dv64(d, b + 88),
  };
}

export function decodeSourceCredit(d: Uint8Array, domain: number): SourceCredit | null {
  const s = C.assetEngineOff(Math.floor(domain / 2)) + (domain % 2 === 0 ? SOURCE_LONG : SOURCE_SHORT);
  if (d.length < s + 16 * 10) return null;
  const f = (i: number) => u128(d, s + i * 16);
  return {
    positiveClaimBound: f(0),
    freshReserved: f(2),
    validLienedBacking: f(5),
    insuranceCreditReserved: f(7),
    validLienedInsurance: f(8),
    impairedLienedInsurance: f(9),
  };
}

/** `BackingDomainLedgerAccountV16` (16 B discriminator/version + 64 B keys, then u128 fields). */
export function decodeDomainLedger(d: Uint8Array | null): DomainLedger | null {
  if (!d || d.length < 80 + 16 * 9) return null;
  const f = (i: number) => u128(d, 80 + i * 16);
  return {
    totalPrincipal: f(0),
    totalEarnings: f(3),
    totalEarningsWithdrawn: f(4),
    lastObsBucketEarnings: f(5),
    cumulativeLoss: f(6),
    cumulativeRecovery: f(7),
    lastObsUnavailable: f(8),
  };
}

// ── Program math ─────────────────────────────────────────────────────────────────────────────

/** `backing_unavailable_principal_atoms`. */
function unavailableAtoms(b: BackingBucket): bigint {
  return (b.consumed + b.impaired) / BS;
}

/** `read_or_new_backing_domain_ledger` + `sync_backing_domain_ledger`, as every handler runs it. */
export function syncedLedger(dom: DomainState): DomainLedger {
  const b = dom.bucket;
  if (!dom.ledger) {
    // new_backing_domain_ledger (what 77 / 91 read for a ledger that does not exist yet): zero
    // principal, watermarks pinned to the bucket, so the sync below books nothing.
    return {
      totalPrincipal: 0n,
      totalEarnings: 0n,
      totalEarningsWithdrawn: 0n,
      lastObsBucketEarnings: b.utilFeeEarnings,
      cumulativeLoss: 0n,
      cumulativeRecovery: 0n,
      lastObsUnavailable: unavailableAtoms(b),
    };
  }
  const l = { ...dom.ledger };
  if (b.utilFeeEarnings >= l.lastObsBucketEarnings) l.totalEarnings += b.utilFeeEarnings - l.lastObsBucketEarnings;
  l.lastObsBucketEarnings = b.utilFeeEarnings;
  const unavailable = unavailableAtoms(b);
  if (unavailable >= l.lastObsUnavailable) l.cumulativeLoss += unavailable - l.lastObsUnavailable;
  else l.cumulativeRecovery += l.lastObsUnavailable - unavailable;
  l.lastObsUnavailable = unavailable;
  return l;
}

/**
 * `lp_vault_domain_available_principal_atoms`. `floored = false` (the live 553d76f0/cc5095fb
 * wrapper): null = the program would underflow (Custom 25). `floored = true` (wrapper 7a3ac04c+,
 * non-bound NAV floor): `principal.saturating_sub(loss.saturating_sub(recovery))`, never null —
 * an over-impaired pot is worth 0 (`backing_ledger_available_principal_atoms`).
 */
export function availablePrincipal(l: DomainLedger, floored = false): bigint | null {
  const net = l.cumulativeLoss - l.cumulativeRecovery;
  if (floored) {
    const n = net > 0n ? net : 0n;
    return l.totalPrincipal > n ? l.totalPrincipal - n : 0n;
  }
  if (net < 0n || l.totalPrincipal < net) return null;
  return l.totalPrincipal - net;
}

/** `lp_vault_nav_atoms` (`floored`: 7a3ac04c `lp_vault_nav_atoms_floored`). */
export function domainNav(l: DomainLedger, feeShareBps: number, floored = false): bigint | null {
  const avail = availablePrincipal(l, floored);
  if (avail === null) return null;
  const netEarnings = l.totalEarnings - l.totalEarningsWithdrawn;
  if (netEarnings < 0n) return null;
  return avail + (netEarnings * BigInt(feeShareBps)) / 10_000n;
}

/** Source backing still available to cover claims (`source_credit_available_backing_num`). */
function sourceAvailableNum(s: SourceCredit): bigint {
  const insuranceFree = s.insuranceCreditReserved - (s.validLienedInsurance + s.impairedLienedInsurance);
  return s.freshReserved - s.validLienedBacking + (insuranceFree > 0n ? insuranceFree : 0n);
}

/** Most backing (atoms) that can leave this source while its credit rate stays at scale. */
function creditRoomAtoms(s: SourceCredit): bigint {
  const avail = sourceAvailableNum(s);
  if (s.positiveClaimBound === 0n) return s.freshReserved / BS;
  const room = avail - s.positiveClaimBound;
  if (room <= 0n) return 0n;
  const r = room / BS;
  const cap = s.freshReserved / BS;
  return r < cap ? r : cap;
}

const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const pos = (x: bigint) => (x > 0n ? x : 0n);

/** Combined NAV and available principal of the two pots, as 75 / 77 price them (`floored`: 7a3ac04c+). */
export function combinedVault(own: DomainState, sib: DomainState, feeShareBps: number, floored = false): { nav: bigint; available: bigint } | null {
  const lo = syncedLedger(own);
  const ls = syncedLedger(sib);
  const ao = availablePrincipal(lo, floored);
  const as = availablePrincipal(ls, floored);
  const no = domainNav(lo, feeShareBps, floored);
  const ns = domainNav(ls, feeShareBps, floored);
  if (ao === null || as === null || no === null || ns === null) return null;
  return { nav: no + ns, available: ao + as };
}

/**
 * BOUND (P3) vault backing NAV, as 75 / 77 price it: wrapper `lp_vault_combined_nav_parts_p3` ->
 * `vault_lp_v18::bound_vault_nav` (deployed 553d76f0). Per pot the vault owns
 * `min(principal, held)` with `held = (fresh_unliened + valid_liened) / BOUND_SCALE` (backing
 * above principal is the vault LP's settled loss reserved for winners; below it is a real loss),
 * plus each pot's LP earnings `floor((earnings - withdrawn) * fee_share / 10_000)` from its synced
 * ledger. The ledgers' impairment counters are deliberately NOT used (B24).
 */
export function boundVaultNav(own: DomainState, sib: DomainState, feeShareBps: number): { nav: bigint; available: bigint } | null {
  if (feeShareBps < 0 || feeShareBps > 10_000) return null;
  const pot = (d: DomainState) => {
    const l = syncedLedger(d);
    const held = (d.bucket.freshUnliened + d.bucket.validLiened) / BS;
    const owned = l.totalPrincipal < held ? l.totalPrincipal : held;
    const net = l.totalEarnings - l.totalEarningsWithdrawn;
    const earnings = net > 0n ? (net * BigInt(feeShareBps)) / 10_000n : 0n;
    return { owned, earnings };
  };
  const a = pot(own);
  const b = pot(sib);
  const available = a.owned + b.owned;
  return { available, nav: available + a.earnings + b.earnings };
}

/** The most principal 91 can move out of `sib` (0 when nothing can move). */
export function movablePrincipal(sib: DomainState): bigint {
  if (sib.bucket.status !== BUCKET_STATUS_FRESH) return 0n;
  const ls = syncedLedger(sib);
  const avail = availablePrincipal(ls);
  if (avail === null) return 0n;
  return pos(min(avail, ls.totalPrincipal, sib.bucket.freshUnliened / BS, creditRoomAtoms(sib.source)));
}

/**
 * `vault_pot_free_backing_num` / BOUND_SCALE: a pot's fresh idle backing its live winner claims do
 * not reserve (what can leave it while it stays fully backed). 0 for a non-Fresh pot.
 */
function potFreeAtoms(d: DomainState): bigint {
  if (d.bucket.status !== BUCKET_STATUS_FRESH) return 0n;
  const s = d.source;
  return pos(min(d.bucket.freshUnliened, s.freshReserved - s.positiveClaimBound, sourceAvailableNum(s) - s.positiveClaimBound)) / BS;
}

/** Most principal 77's own sibling top-up can bring into the payout pot (non-bound rules). */
function siblingTopUpAtoms(sib: DomainState, floored = false): bigint {
  if (!sib.ledger) return 0n; // the program skips an uninitialised sibling ledger
  const avail = availablePrincipal(syncedLedger(sib), floored);
  if (avail === null) return 0n;
  return min(potFreeAtoms(sib), avail);
}

/** Gross utilization-fee earnings 77 can relabel from the sibling onto the payout pot. */
function siblingEarningsTopUp(sib: DomainState): bigint {
  if (!sib.ledger) return 0n;
  const ls = syncedLedger(sib);
  return min(sib.bucket.utilFeeEarnings, pos(ls.totalEarnings - ls.totalEarningsWithdrawn));
}

export interface SplitPotPlan {
  /** What 77 pays for `shares`, and its principal part. */
  atoms: bigint;
  principal: bigint;
  /** Largest share count 77 can pay right now (its own cross-pot top-up included), before the safety margin. */
  maxShares: bigint;
  /** `shares <= maxShares`. */
  payable: boolean;
}

/**
 * What a non-bound 77 can pay for `shares` out of `own` (the registry's domain). The app sends 77
 * alone: the program moves the sibling's principal and earnings in by itself when `own` is short.
 * null = the vault's counters could not be priced (the program would refuse too).
 */
export function planSplitPotRedemption(p: {
  own: DomainState;
  sib: DomainState;
  totalShares: bigint;
  shares: bigint;
  feeShareBps: number;
  /** Wrapper 7a3ac04c+ per-pot NAV floor is live (lib/program-upgrade-detect.ts). Default false. */
  navFloor?: boolean;
}): SplitPotPlan | null {
  if (p.totalShares <= 0n) return null;
  const floored = p.navFloor === true;
  const v = combinedVault(p.own, p.sib, p.feeShareBps, floored);
  if (!v) return null;
  const ownAvail = availablePrincipal(syncedLedger(p.own), floored);
  if (ownAvail === null) return null;
  const principalFor = (s: bigint) => (s * v.available) / p.totalShares;
  const atomsFor = (s: bigint) => (s * v.nav) / p.totalShares;

  // Most principal the payout pot can release once 77 has moved `r` in from the sibling: its
  // ledger gate (available principal), its fresh backing and its stay-fully-backed credit room
  // all grow by r.
  const ownCap = (r: bigint) =>
    pos(min(ownAvail + r, (p.own.bucket.freshUnliened + r * BS) / BS, creditRoomAtoms({ ...p.own.source, freshReserved: p.own.source.freshReserved + r * BS })));
  const capMax = ownCap(siblingTopUpAtoms(p.sib, floored));
  // 77's earnings gate: the gross LP earnings slice (ceil(earnings * 10_000 / fee_share_bps)) must
  // fit the payout pot's bucket after 77 relabels the sibling's unwithdrawn earnings onto it.
  const earningsRoom = p.own.bucket.utilFeeEarnings + siblingEarningsTopUp(p.sib);
  const earningsOk = (s: bigint) => {
    const earnings = atomsFor(s) - principalFor(s);
    if (earnings <= 0n) return true;
    if (p.feeShareBps <= 0) return false;
    const fee = BigInt(p.feeShareBps);
    return (earnings * 10_000n + fee - 1n) / fee <= earningsRoom;
  };
  const payableFor = (s: bigint) => principalFor(s) <= capMax && earningsOk(s);

  // Largest payable share count (both gates are monotone in s, up to floor wobble): binary search.
  let lo = 0n;
  let hi = p.totalShares;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (payableFor(mid)) lo = mid;
    else hi = mid - 1n;
  }
  return { atoms: atomsFor(p.shares), principal: principalFor(p.shares), maxShares: lo, payable: payableFor(p.shares) };
}

// ── Underwater pot (M-1): the reverse-91 repair ─────────────────────────────────────────────

/** A pot's booked loss beyond its ledger principal (atoms); > 0 = every 75 / 77 on the vault fails 25. */
export function potDeficit(l: DomainLedger): bigint {
  const net = l.cumulativeLoss - l.cumulativeRecovery;
  return net > l.totalPrincipal ? net - l.totalPrincipal : 0n;
}

/** Headroom over the exact deficit, so a little more loss between read and landing does not re-fail. */
export const POT_REPAIR_HEADROOM_BPS = 10n; // 0.1%

export interface PotRepair {
  /** Absolute domains (even = long, odd = short). */
  fromDomain: number;
  toDomain: number;
  amount: bigint;
}

/**
 * The vault as the program sees it after the repair (`state`), and the 91 to send first (`repair`,
 * null when no pot is underwater). Returns null when a pot is underwater and the other pot cannot
 * cover the deficit (both underwater, or not enough free principal): nothing the app can send fixes
 * that, and the program's own refusal is what the user sees.
 */
export function repairUnderwaterPot(sp: SplitPotState): { state: SplitPotState; repair: PotRepair | null } | null {
  // Wrapper 7a3ac04c+ (NAV floor live): NEVER repair. Pricing no longer fails on an over-impaired
  // pot (it is worth 0), and a 91 into it books principal while the impairment stays, so it only
  // moves Earn holders' money into that pot (security review 2026-10-03 B-2; SI ~79.6M atoms).
  if (sp.navFloor === true) return { state: sp, repair: null };
  const lo = syncedLedger(sp.own);
  const ls = syncedLedger(sp.sib);
  if (lo.cumulativeLoss < lo.cumulativeRecovery || ls.cumulativeLoss < ls.cumulativeRecovery) return null;
  const dOwn = potDeficit(lo);
  const dSib = potDeficit(ls);
  if (dOwn === 0n && dSib === 0n) return { state: sp, repair: null };
  if (dOwn > 0n && dSib > 0n) return null;
  const ownUnder = dOwn > 0n;
  const under = ownUnder ? sp.own : sp.sib;
  const healthy = ownUnder ? sp.sib : sp.own;
  const deficit = ownUnder ? dOwn : dSib;
  const movable = movablePrincipal(healthy);
  if (movable < deficit) return null;
  const want = deficit + pos((deficit * POT_REPAIR_HEADROOM_BPS) / 10_000n) + 1n;
  const amount = want < movable ? want : movable;
  const num = amount * BS;

  // Source side (handle_rebalance_lp_vault_backing): synced ledger loses `amount` of principal.
  const hl = syncedLedger(healthy);
  const healthyAfter: DomainState = {
    bucket: { ...healthy.bucket, freshUnliened: healthy.bucket.freshUnliened - num },
    source: { ...healthy.source, freshReserved: healthy.source.freshReserved - num },
    ledger: { ...hl, totalPrincipal: hl.totalPrincipal - amount },
  };
  // Destination: sync against the pre-refill bucket, refill pays the provider receivable
  // (= consumed) down and adds fresh backing, watermark pinned to the post-refill bucket.
  const ul = syncedLedger(under);
  const refill = num < under.bucket.consumed ? num : under.bucket.consumed;
  const ub = { ...under.bucket, consumed: under.bucket.consumed - refill, freshUnliened: under.bucket.freshUnliened + num };
  const underAfter: DomainState = {
    bucket: ub,
    source: { ...under.source, freshReserved: under.source.freshReserved + num },
    ledger: { ...ul, totalPrincipal: ul.totalPrincipal + amount, lastObsUnavailable: unavailableAtoms(ub) },
  };
  const ownDomain = sp.ownDomain;
  return {
    state: { ...sp, own: ownUnder ? underAfter : healthyAfter, sib: ownUnder ? healthyAfter : underAfter },
    repair: { fromDomain: ownUnder ? ownDomain ^ 1 : ownDomain, toDomain: ownUnder ? ownDomain : ownDomain ^ 1, amount },
  };
}

/**
 * Share-price collapse guard (security review 2026-10-03 H-1): a deposit at a near-zero NAV mints
 * almost every share and captures the existing holders' future recovery (live OTC 6Y4bf: NAV 3
 * atoms vs 2,000,000,000 shares). The H-1 wrapper refuses 75 when `nav * 1000 < total_shares`;
 * the app never sends one in that state, before or after the upgrade (pre-upgrade the same
 * boundary state is exploitable on the live bytes, B-1 "pre-existing").
 */
export const EARN_PRICE_COLLAPSE_FACTOR = 1_000n;

/**
 * Wrapper 7c906e45 `LP_VAULT_MAX_DEPOSIT_IMPAIRMENT_BPS` (security R-1): a non-bound 75 is
 * refused while the vault's total net impairment exceeds 10% of its total principal.
 */
export const EARN_MAX_DEPOSIT_IMPAIRMENT_BPS = 1_000n;

/**
 * Port of 7c906e45 `lp_vault_impairment_exceeds`: `impairment > floor(principal * bps / 10_000)`
 * (exact; `principal == 0` is never impaired).
 */
export function vaultImpairmentExceeds(impairment: bigint, principal: bigint, maxBps: bigint = EARN_MAX_DEPOSIT_IMPAIRMENT_BPS): boolean {
  return impairment > (principal * maxBps) / 10_000n;
}

/**
 * One pot's (principal, min(loss − recovery, principal)) from its SYNCED ledger, as 7c906e45
 * `lp_vault_pot_impairment_parts` (a missing ledger reads as new: principal 0, impairment 0).
 */
export function potImpairmentParts(l: DomainLedger): { principal: bigint; impairment: bigint } {
  const net = l.cumulativeLoss - l.cumulativeRecovery;
  const imp = net > 0n ? net : 0n;
  return { principal: l.totalPrincipal, impairment: imp < l.totalPrincipal ? imp : l.totalPrincipal };
}

export type EarnDepositPlan =
  | { ok: true; domain: number }
  | { ok: false; reason: "pot-impaired" | "vault-impaired" | "price-collapsed" | "unpriceable" };

/**
 * Where a NON-bound Earn deposit (75) goes, or why the app must not send it.
 *
 * Judged on the pots as the program will see them when 75 runs:
 *   - live wrapper (navFloor false): after the repair 91 `splitPotPrefixIxs` prepends (it is what
 *     makes 75 price at all today); no repair possible while a pot is underwater -> Custom 25.
 *   - upgraded wrapper (navFloor true): the raw pots (no prefix; B-2). H-1 refuses 75 when EITHER
 *     pot is over-impaired (7a3ac04c alone refuses only the target pot, Custom 91).
 * So in both regimes, in the program's order (7c906e45 tag 75): any pot over-impaired ->
 * "pot-impaired"; vault-total impairment > 10% of vault-total principal -> "vault-impaired";
 * NAV (+ harvestable fees, A-1) collapsed against the share supply -> "price-collapsed".
 * Otherwise the vault's own pot.
 */
export function planEarnDeposit(sp: SplitPotState, ownDomain = sp.ownDomain): EarnDepositPlan {
  const fixed = repairUnderwaterPot(sp);
  if (!fixed) return { ok: false, reason: "pot-impaired" };
  const st = fixed.state;
  const ownOver = potDeficit(syncedLedger(st.own)) > 0n;
  const sibOver = potDeficit(syncedLedger(st.sib)) > 0n;
  if (ownOver || sibOver) return { ok: false, reason: "pot-impaired" };
  // R-1 (7c906e45): vault-total net impairment above 10% of vault-total principal.
  const a = potImpairmentParts(syncedLedger(st.own));
  const b = potImpairmentParts(syncedLedger(st.sib));
  if (vaultImpairmentExceeds(a.impairment + b.impairment, a.principal + b.principal)) return { ok: false, reason: "vault-impaired" };
  const v = combinedVault(st.own, st.sib, st.feeShareBps, sp.navFloor === true);
  if (!v) return { ok: false, reason: "unpriceable" };
  // A-1: the program checks the FINAL pricing NAV = floored pots + harvestable LP fees.
  // `harvestableAtoms === null` = the program's harvestable read underflows (25): don't send.
  if (sp.harvestableAtoms === null) return { ok: false, reason: "unpriceable" };
  const pricingNav = v.nav + (sp.harvestableAtoms ?? 0n);
  if (st.totalShares > 0n && pricingNav * EARN_PRICE_COLLAPSE_FACTOR < st.totalShares) return { ok: false, reason: "price-collapsed" };
  // Either-pot rule: reaching here means neither pot is over-impaired, so the vault's own pot
  // (principal >= its impairment) always takes it - today's routing.
  return { ok: true, domain: ownDomain };
}

/** Thrown before the wallet opens when `planEarnDeposit` says the deposit must not be sent. */
export class EarnDepositsPausedError extends Error {
  constructor(public readonly reason: Exclude<EarnDepositPlan, { ok: true }>["reason"]) {
    super("Earn deposits are paused while this vault settles. Nothing was sent.");
    this.name = "EarnDepositsPausedError";
  }
}

/** Combined NAV / available principal as the program prices them once any underwater pot is repaired. */
export function vaultValue(sp: SplitPotState): { nav: bigint; available: bigint } | null {
  const fixed = repairUnderwaterPot(sp);
  return fixed ? combinedVault(fixed.state.own, fixed.state.sib, fixed.state.feeShareBps, sp.navFloor === true) : null;
}

/** The repair 91 for `sp` (accounts from the read). */
export function buildPotRepairIx(p: { programId: PublicKey; cranker: PublicKey; market: PublicKey; registry: PublicKey; sp: SplitPotState; repair: PotRepair }): TransactionInstruction {
  const ledgerOf = (d: number) => (d === p.sp.ownDomain ? p.sp.ownLedger : p.sp.sibLedger);
  return buildRebalanceBackingIx({
    programId: p.programId, cranker: p.cranker, market: p.market, registry: p.registry,
    fromLedger: ledgerOf(p.repair.fromDomain), toLedger: ledgerOf(p.repair.toDomain),
    fromDomain: p.repair.fromDomain, toDomain: p.repair.toDomain, amount: p.repair.amount,
  });
}

/** The share count to re-request when the full amount cannot pay: the cap less the safety margin. */
export function cappedShares(maxShares: bigint, held: bigint): bigint {
  const s = (maxShares * (10_000n - SPLIT_POT_CAP_SAFETY_BPS)) / 10_000n;
  return s < held ? s : held;
}

// ── Instructions ─────────────────────────────────────────────────────────────────────────────

/** RebalanceLpVaultBacking (91): [cranker (s,w), market (w), registry, fromLedger (w), toLedger (w), system]. */
export function buildRebalanceBackingIx(p: {
  programId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  fromLedger: PublicKey;
  toLedger: PublicKey;
  fromDomain: number;
  toDomain: number;
  amount: bigint;
}): TransactionInstruction {
  return buildIx({
    programId: p.programId,
    keys: buildAccountMetas(ACCOUNTS_REBALANCE_LP_VAULT_BACKING, [p.cranker, p.market, p.registry, p.fromLedger, p.toLedger, SystemProgram.programId]),
    data: encodeRebalanceLpVaultBacking({ fromDomain: p.fromDomain, toDomain: p.toDomain, amount: p.amount.toString() }),
  });
}

/** CancelRedemption (81): [redeemer (s,w), registry, redemption (w), lpMint, redeemerLpAta (w), escrow (w), tokenProgram]. */
export function buildCancelRedemptionIx(p: {
  programId: PublicKey;
  redeemer: PublicKey;
  registry: PublicKey;
  redemption: PublicKey;
  lpMint: PublicKey;
  redeemerLpAta: PublicKey;
  escrow: PublicKey;
}): TransactionInstruction {
  return buildIx({
    programId: p.programId,
    keys: [
      { pubkey: p.redeemer, isSigner: true, isWritable: true },
      { pubkey: p.registry, isSigner: false, isWritable: false },
      { pubkey: p.redemption, isSigner: false, isWritable: true },
      { pubkey: p.lpMint, isSigner: false, isWritable: false },
      { pubkey: p.redeemerLpAta, isSigner: false, isWritable: true },
      { pubkey: p.escrow, isSigner: false, isWritable: true },
      { pubkey: WELL_KNOWN.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([TAG_CANCEL_REDEMPTION]),
  });
}

/**
 * Thrown before the wallet opens when the pending (or requested) redemption is larger than the
 * vault can pay right now. The UI turns it into "Withdraw max available now: X".
 */
export class EarnPayoutCapError extends Error {
  constructor(public readonly maxShares: bigint, public readonly maxAtoms: bigint) {
    super("Earn payout above what the vault can pay now");
    this.name = "EarnPayoutCapError";
  }
}

/**
 * The instructions the app puts in front of a non-bound 75 / 77: only the underwater-pot repair
 * (91), never a payout 91 (553d76f0's 77 tops itself up from the sibling). With `payoutShares`
 * (a 77), refuses before the wallet opens when 77 cannot pay that many now (EarnPayoutCapError).
 * `sp` null (a BOUND vault, or unreadable) = nothing to add.
 */
export function splitPotPrefixIxs(p: {
  programId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  sp: SplitPotState | null;
  payoutShares?: bigint | null;
}): TransactionInstruction[] {
  if (!p.sp) return [];
  const fixed = repairUnderwaterPot(p.sp);
  if (!fixed) return [];
  const sp = fixed.state;
  if (p.payoutShares != null) {
    const plan = planSplitPotRedemption({ own: sp.own, sib: sp.sib, totalShares: sp.totalShares, shares: p.payoutShares, feeShareBps: sp.feeShareBps, navFloor: sp.navFloor });
    if (plan && !plan.payable) {
      const capped = cappedShares(plan.maxShares, p.payoutShares);
      const v = combinedVault(sp.own, sp.sib, sp.feeShareBps, sp.navFloor === true);
      throw new EarnPayoutCapError(capped, v ? (capped * v.nav) / sp.totalShares : 0n);
    }
  }
  return fixed.repair
    ? [buildPotRepairIx({ programId: p.programId, cranker: p.cranker, market: p.market, registry: p.registry, sp: p.sp, repair: fixed.repair })]
    : [];
}

// ── Read (one round trip) ────────────────────────────────────────────────────────────────────

export interface SplitPotState {
  own: DomainState;
  sib: DomainState;
  ownDomain: number;
  totalShares: bigint;
  feeShareBps: number;
  ownLedger: PublicKey;
  sibLedger: PublicKey;
  /**
   * The upgraded wrapper (7a3ac04c+) is live: per-pot NAV floor, no repair prefix, 75 refused
   * into an impaired / collapsed vault. Absent / false = today's live program (fail closed, 25).
   */
  navFloor?: boolean;
  /**
   * `lp_vault_harvestable_fee_atoms` from the market (what a tag-78 crank would add to NAV now).
   * Tag 75 prices on `combined NAV + harvestable` and runs the collapse check on that sum
   * (bc228e1b :24607-24623). null / absent = unreadable (the program would fail 25 then).
   */
  harvestableAtoms?: bigint | null;
  /**
   * Market-level facts tag 77 gates on (7c906e45 handle_execute_redemption): mode (0 Live, 1 Resolved,
   * 2 Recovery), terminal-flat, the engine clock, and `header.vault` (a payout above it is refused).
   * Absent = unread: the withdraw view then reports nothing rather than guessing "open".
   */
  market?: { mode: number; terminalFlat: boolean; currentSlot: bigint; vaultAtoms: bigint };
  /** Registry `oi_reservation_threshold_bps` (0 = guard off). */
  oiReservationThresholdBps?: number;
}

/**
 * Market + registry + both pot ledgers. null = a BOUND (P3) vault (its 77 tops the pot up from
 * the sibling by itself), or anything unreadable (the caller then sends the plain 77).
 */
export async function readSplitPotState(
  connection: Connection,
  programId: PublicKey,
  market: PublicKey,
): Promise<SplitPotState | null> {
  const st = await readVaultPotState(connection, programId, market);
  if (!st || st.bound) return null;
  const { bound: _bound, ...rest } = st;
  return rest;
}

/** The two pot ledgers a two-pot vault's state needs; null = BOUND vault or unreadable registry. */
export function splitPotLedgerKeys(
  programId: PublicKey,
  market: PublicKey,
  registryData: Uint8Array | Buffer,
): { ownLedger: PublicKey; sibLedger: PublicKey } | null {
  const k = vaultPotLedgerKeys(programId, market, registryData);
  return k && !k.bound ? { ownLedger: k.ownLedger, sibLedger: k.sibLedger } : null;
}

/** Both pot ledgers of ANY vault, with its bound flag; null = unreadable or invalid registry. */
export function vaultPotLedgerKeys(
  programId: PublicKey,
  market: PublicKey,
  registryData: Uint8Array | Buffer,
): { ownLedger: PublicKey; sibLedger: PublicKey; bound: boolean } | null {
  try {
    const rd = new Uint8Array(registryData);
    const bound = decodeLpVaultRegistryBound(rd);
    if (bound !== true && bound !== false) return null;
    const ownDomain = Number(parseLpVaultRegistry(rd).domain);
    return {
      ownLedger: deriveLpBackingLedger(programId, market, ownDomain)[0],
      sibLedger: deriveLpBackingLedger(programId, market, ownDomain ^ 1)[0],
      bound,
    };
  } catch {
    return null;
  }
}

/**
 * readSplitPotState from accounts the caller already fetched (registry, market, both ledgers), for
 * batching many vaults into one read. Same null cases.
 */
export function splitPotStateFromAccounts(
  programId: PublicKey,
  market: PublicKey,
  registryData: Uint8Array | Buffer,
  marketData: Uint8Array | Buffer | null,
  ownLedgerData: Uint8Array | Buffer | null,
  sibLedgerData: Uint8Array | Buffer | null,
  navFloor = false,
): SplitPotState | null {
  const st = vaultPotStateFromAccounts(programId, market, registryData, marketData, ownLedgerData, sibLedgerData, navFloor);
  if (!st || st.bound) return null;
  const { bound: _bound, ...rest } = st;
  return rest;
}

/** Both pots of ANY vault (bound or not) from fetched accounts; null = unreadable. */
export function vaultPotStateFromAccounts(
  programId: PublicKey,
  market: PublicKey,
  registryData: Uint8Array | Buffer,
  marketData: Uint8Array | Buffer | null,
  ownLedgerData: Uint8Array | Buffer | null,
  sibLedgerData: Uint8Array | Buffer | null,
  navFloor = false,
): (SplitPotState & { bound: boolean }) | null {
  try {
    const keys = vaultPotLedgerKeys(programId, market, registryData);
    if (!keys || !marketData) return null;
    const reg = parseLpVaultRegistry(new Uint8Array(registryData));
    const ownDomain = Number(reg.domain);
    const md = new Uint8Array(marketData);
    const dom = (i: number, a: Uint8Array | Buffer | null): DomainState | null => {
      const bucket = decodeBackingBucket(md, i);
      const source = decodeSourceCredit(md, i);
      return bucket && source ? { bucket, source, ledger: decodeDomainLedger(a ? new Uint8Array(a) : null) } : null;
    };
    const own = dom(ownDomain, ownLedgerData);
    const sib = dom(ownDomain ^ 1, sibLedgerData);
    if (!own || !sib) return null;
    return {
      own,
      sib,
      ownDomain,
      totalShares: BigInt(reg.totalLpSharesOutstanding),
      feeShareBps: Number(reg.feeShareBps),
      ownLedger: keys.ownLedger,
      sibLedger: keys.sibLedger,
      bound: keys.bound,
      navFloor,
      harvestableAtoms: (() => {
        const e = decodeMarketEngineView(md, 0);
        return e ? harvestableFeeAtoms(e) : null;
      })(),
      market: (() => {
        const e = decodeMarketEngineView(md, 0);
        const rm = decodeResolvedMarket(md);
        return e && rm
          ? { mode: e.mode, terminalFlat: rm.mode === 1 && rm.materializedPortfolioCount === 0n && rm.cTot === 0n, currentSlot: e.currentSlot, vaultAtoms: e.vaultAtoms }
          : undefined;
      })(),
      oiReservationThresholdBps: decodeLpVaultRegistryOiThresholdBps(new Uint8Array(registryData)) ?? undefined,
    };
  } catch {
    return null;
  }
}

/** The backing NAV the program prices a vault at: bound -> boundVaultNav, two-pot -> combinedVault. */
export function vaultBackingNav(st: SplitPotState & { bound: boolean }): bigint | null {
  const v = st.bound ? boundVaultNav(st.own, st.sib, st.feeShareBps) : combinedVault(st.own, st.sib, st.feeShareBps, st.navFloor === true);
  return v ? v.nav : null;
}

/** Both pots of ANY vault (bound or not) in one round trip; null = unreadable. */
export async function readVaultPotState(
  connection: Connection,
  programId: PublicKey,
  market: PublicKey,
): Promise<(SplitPotState & { bound: boolean }) | null> {
  try {
    const [registry] = deriveLpVaultRegistry(programId, market);
    const r = await connection.getAccountInfo(registry, "confirmed");
    if (!r || !r.owner.equals(programId)) return null;
    const keys = vaultPotLedgerKeys(programId, market, r.data);
    if (!keys) return null;
    const [[m, lo, ls], navFloor] = await Promise.all([
      connection.getMultipleAccountsInfo([market, keys.ownLedger, keys.sibLedger], "confirmed"),
      earnNavFloorLive(connection, programId).catch(() => false),
    ]);
    return vaultPotStateFromAccounts(programId, market, r.data, m?.data ?? null, lo?.data ?? null, ls?.data ?? null, navFloor);
  } catch {
    return null;
  }
}
