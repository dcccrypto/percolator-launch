/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/backing-bucket.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * @module backing-bucket
 * v17 source-domain backing-bucket state: the read path behind `ExpireBackingBucket` (tag 89).
 *
 * ## Why this module exists
 *
 * The SDK could already *encode* tag 89 but had no way to tell whether a bucket had
 * actually lapsed. A keeper with an encoder and no detector has two bad options: crank
 * every domain every cycle (paying for a guaranteed revert on every healthy domain), or
 * never crank at all (leaving lapsed domains bricked). This module supplies the missing
 * predicate.
 *
 * ## Why lapsing is routine, not exceptional
 *
 * A bucket's `expiry_slot` is fixed when the bucket opens and is **never extended while
 * it stays `Fresh`** — the engine's `fresh_counterparty_backing_expiry_slot`
 * (`percolator/src/v16.rs:6303-6310`) returns the stored value unchanged on a live
 * bucket and only computes a fresh horizon once the bucket is no longer
 * `Fresh`-and-unexpired. **Every backed market therefore lapses eventually.** Seeding a
 * far-future expiry defers the lapse; it does not prevent it.
 *
 * Once lapsed, the domain is a dead end in every direction until tag 89 runs:
 *
 * | Attempt against a lapsed domain | Result |
 * |---|---|
 * | settle a **loss** | `EngineLockActive` Custom(21) |
 * | settle a **gain** | `EngineStale` Custom(19) |
 * | `TopUpBackingBucket` (tag 24) to re-fund it | `EngineLockActive` Custom(21) |
 *
 * The gain path is `validate_source_domain_ledger_current` (`v16.rs:6294-6301`), which
 * returns `Stale` for exactly `status == Fresh && expiry_slot <= current_slot`. It cannot
 * even be paid to come back. Scanning for lapsed domains and expiring them is a standing
 * keeper duty, alongside the fee crank.
 *
 * ## Layout provenance
 *
 * Every offset below was produced by `offset_of!` against the engine's own `#[repr(C)]`
 * account structs (`percolator/src/v16.rs`), not inferred from field order:
 *
 * ```
 * EngineAssetSlotV16Account size=1285   backing_long @ 947   backing_short @ 1044
 * BackingBucketV16Account   size=97
 *     0 market_id            8 fresh_unliened_backing_num   24 valid_liened_backing_num
 *    40 consumed_liened...  56 impaired_liened...           72 utilization_fee_earnings
 *    88 expiry_slot         96 status
 * MarketGroupV16HeaderAccount  config @ 32   current_slot @ 613   mode @ 626
 * V16ConfigAccount             max_portfolio_assets @ 0   max_market_slots @ 2
 * ```
 *
 * Every `V16Pod*` field is an align-1 `[u8; N]` and every struct derives `bytemuck::Pod`
 * (which forbids implicit padding), so these are byte offsets with no alignment gaps.
 *
 * ## v18 update (v16-migration, integration `sync/integration-v16`@a9318945)
 *
 * Re-verified via `cargo run --example dump_layout` against the integration
 * branch's pinned engine (`~/percolator` @ c141d47f):
 *
 * ```
 * EngineAssetSlotV16Account size=1301   backing_long @ 963   backing_short @ 1060
 * ```
 *
 * `BackingBucketV16Account` itself is UNCHANGED (still 97 bytes, same field
 * offsets — re-verified against `~/percolator/src/v16.rs:7294`). The wrapper
 * slot preceding `EngineAssetSlotV16Account` grew 512 -> 1024
 * ({@link V17_ASSET_SLOT_WRAPPER_LEN}, see `slab.ts`'s
 * `V17_ASSET_ORACLE_WRAPPER_LEN`), and `EngineAssetSlotV16Account` itself
 * independently grew 1285 -> 1301 (+16 — the SAME undocumented extra
 * `AssetStateV16Account` field `slab.ts`'s `V17_ASSET_STATE_OI_LONG_REL`
 * doc comment flags), so `backing_long`/`backing_short`'s offsets relative
 * to the engine-slot start both shift +16 (947 -> 963, 1044 -> 1060).
 */

import { resolveMarketGeometry } from "../layout";

// ---------------------------------------------------------------------------
// Little-endian readers (module-local, matching slab.ts's private helpers)
// ---------------------------------------------------------------------------

function readU8At(data: Uint8Array, off: number): number {
  if (off + 1 > data.length) throw new Error(`readU8At: out of bounds at ${off}`);
  return data[off]!;
}

function readU32LEAt(data: Uint8Array, off: number): number {
  if (off + 4 > data.length) throw new Error(`readU32LEAt: out of bounds at ${off}`);
  return new DataView(data.buffer, data.byteOffset + off, 4).getUint32(0, true);
}

function readU64LEAt(data: Uint8Array, off: number): bigint {
  if (off + 8 > data.length) throw new Error(`readU64LEAt: out of bounds at ${off}`);
  return new DataView(data.buffer, data.byteOffset + off, 8).getBigUint64(0, true);
}

function readU128LEAt(data: Uint8Array, off: number): bigint {
  if (off + 16 > data.length) throw new Error(`readU128LEAt: out of bounds at ${off}`);
  const dv = new DataView(data.buffer, data.byteOffset + off, 16);
  const lo = dv.getBigUint64(0, true);
  const hi = dv.getBigUint64(8, true);
  return (hi << 64n) | lo;
}

// ---------------------------------------------------------------------------
// Layout constants — all verified with offset_of! (see module doc)
// ---------------------------------------------------------------------------

/** `MarketGroupV16HeaderAccount::config` (V16ConfigAccount), relative to the group header. */
export const V17_GROUP_CONFIG_REL = 32;
/** `MarketGroupV16HeaderAccount::current_slot` (u64), relative to the group header. */
export const V17_GROUP_CURRENT_SLOT_REL = 613;
/** `MarketGroupV16HeaderAccount::mode` (u8), relative to the group header. 0=Live, 1=Resolved, 2=Recovery. */
export const V17_GROUP_MODE_REL = 626;
/** `V16ConfigAccount::max_market_slots` (u32), relative to the config block. */
export const V17_CONFIG_MAX_MARKET_SLOTS_REL = 2;

/**
 * The wrapper oracle-storage prefix that precedes `EngineAssetSlotV16Account`
 * in `Market<T>`. v18 (integration `a9318945`): grew 512 -> 1024 — see this
 * module's own doc comment and `slab.ts`'s `V17_ASSET_ORACLE_WRAPPER_LEN`.
 */
export const V17_ASSET_SLOT_WRAPPER_LEN = 1024;
/** `EngineAssetSlotV16Account::backing_long`, relative to the engine slot start. v18: 947 -> 963 (see module doc comment). */
export const V17_ENGINE_BACKING_LONG_REL = 963;
/** `EngineAssetSlotV16Account::backing_short`, relative to the engine slot start. v18: 1044 -> 1060 (see module doc comment). */
export const V17_ENGINE_BACKING_SHORT_REL = 1060;
/** `size_of::<BackingBucketV16Account>()`. */
export const V17_BACKING_BUCKET_LEN = 97;

// BackingBucketV16Account field offsets, relative to the bucket start.
const BB_MARKET_ID = 0;
const BB_FRESH_UNLIENED = 8;
const BB_VALID_LIENED = 24;
const BB_CONSUMED_LIENED = 40;
const BB_IMPAIRED_LIENED = 56;
const BB_UTILIZATION_FEE = 72;
const BB_EXPIRY_SLOT = 88;
const BB_STATUS = 96;

/** Market mode discriminant (`MarketGroupV16HeaderAccount::mode`). */
export const V17_MARKET_MODE_LIVE = 0;

/**
 * `BackingBucketStatusV16` (`percolator/src/v16.rs:1674-1679`), a fieldless Rust enum
 * serialized as a single `u8` in declaration order.
 *
 * Only `Fresh` is expirable — see {@link isBackingBucketExpirable}.
 */
export enum BackingBucketStatus {
  Empty = 0,
  Fresh = 1,
  Expired = 2,
  Impaired = 3,
}

/** Human-readable name for a {@link BackingBucketStatus}, or `Unknown(n)` for an unmapped byte. */
export function backingBucketStatusName(status: number): string {
  switch (status) {
    case BackingBucketStatus.Empty:
      return "Empty";
    case BackingBucketStatus.Fresh:
      return "Fresh";
    case BackingBucketStatus.Expired:
      return "Expired";
    case BackingBucketStatus.Impaired:
      return "Impaired";
    default:
      return `Unknown(${status})`;
  }
}

/** One source-domain backing bucket, decoded from a v17 market account. */
export interface BackingBucketV17 {
  /** Domain index. `domain = assetIndex * 2 + (side === "short" ? 1 : 0)`. */
  domain: number;
  /** `domain / 2` — the asset slot this domain belongs to. */
  assetIndex: number;
  /** `domain % 2` — even domains are LONG, odd domains are SHORT. */
  side: "long" | "short";
  /** `BackingBucketV16Account::market_id`. */
  marketId: bigint;
  /** Principal that is reserved but carries no lien. Forfeited to the junior pool on expiry. */
  freshUnlienedBackingNum: bigint;
  /** Principal under a live lien. Moves to `impairedLienedBackingNum` on expiry. */
  validLienedBackingNum: bigint;
  /** Principal already consumed by settlement. */
  consumedLienedBackingNum: bigint;
  /** Principal whose lien has been impaired. */
  impairedLienedBackingNum: bigint;
  /** Utilization fees accrued to this bucket. */
  utilizationFeeEarnings: bigint;
  /** Slot at which a `Fresh` bucket lapses. Fixed when the bucket opens; never extended. */
  expirySlot: bigint;
  /** Raw status byte. */
  status: number;
  /** `backingBucketStatusName(status)`. */
  statusName: string;
  /**
   * `status === Fresh && nowSlot >= expirySlot`.
   *
   * This is the *deadlock* condition — settlement against this domain fails in both
   * directions. It is necessary but NOT sufficient for tag 89; see {@link expirable},
   * which additionally applies the wrapper's mode and domain-bound gates.
   */
  lapsed: boolean;
  /**
   * `true` iff `ExpireBackingBucket` (tag 89) will be ACCEPTED for this domain right now.
   * See {@link isBackingBucketExpirable} for the full derivation.
   */
  expirable: boolean;
}

/** Whole-market backing-bucket snapshot, as returned by {@link parseBackingBucketsV17}. */
export interface BackingBucketMarketState {
  /** `header.mode` — 0 Live, 1 Resolved, 2 Recovery. Tag 89 requires 0. */
  mode: number;
  /** `header.current_slot` — the engine's own monotone slot counter. */
  headerCurrentSlot: bigint;
  /**
   * `max(chainSlot, header.current_slot)` — the slot the program itself will use.
   * Mirrors `authenticated_market_slot_or_fallback_view` (`v16_program.rs:6332-6339`).
   */
  nowSlot: bigint;
  /** `config.max_market_slots` — the wrapper's domain bound is `max_market_slots * 2`. */
  maxMarketSlots: number;
  /** Asset slots physically present in the account buffer. */
  physicalAssetSlots: number;
  /**
   * `min(maxMarketSlots, physicalAssetSlots) * 2` — the number of domains that are BOTH
   * within the wrapper's declared bound and actually backed by bytes. Domains at or above
   * this index are never expirable; see {@link isBackingBucketExpirable}.
   */
  addressableDomainCount: number;
  /** One entry per addressable domain, ascending by `domain`. */
  buckets: BackingBucketV17[];
}

/** Context needed to evaluate the tag-89 acceptance predicate for a single bucket. */
export interface BackingBucketExpiryContext {
  /** `header.mode`. */
  mode: number;
  /** `max(chainSlot, header.current_slot)`. */
  nowSlot: bigint;
  /** `min(config.max_market_slots, physicalAssetSlots) * 2`. */
  addressableDomainCount: number;
}

/**
 * Decide whether `ExpireBackingBucket` (tag 89) will be ACCEPTED for a domain.
 *
 * This predicate is the conjunction of every gate on the tag-89 path, read from the
 * program rather than from prose. In order of evaluation on chain:
 *
 * 1. **Live only.** `handle_expire_backing_bucket` (`v16_program.rs:10098-10100`):
 *    `if group.header.mode != 0 { return Err(EngineLockActive) }` → Custom(21). A resolved
 *    market reaches the same transition through the engine's own
 *    `realize_source_backed_claims_for_resolved_close_not_atomic` sweep.
 * 2. **Wrapper domain bound.** `v16_program.rs:10102-10105`:
 *    `if domain >= max_market_slots * 2 { return Err(InvalidInstruction) }` → Custom(9).
 * 3. **Engine domain bound.** `domain_asset_side` (`v16.rs:6043-6059`) rejects
 *    `domain >= configured_domain_count` and, separately, `asset_index >= markets.len()`
 *    → `InvalidLeg`. The second test is why `physicalAssetSlots` participates: a market
 *    may be *configured* for more slots than its account was *sized* for.
 * 4. **The lapse itself.** `expire_source_backing_bucket_not_atomic` (`v16.rs:6434-6440`):
 *    `if bucket.status != Fresh || now_slot < bucket.expiry_slot { return Err(Stale) }`
 *    → Custom(19). Note `>=`, not `>`: at exactly `nowSlot === expirySlot` the bucket is
 *    both deadlocked and expirable, and the two boundaries agree
 *    (`validate_source_domain_ledger_current` uses `expiry_slot <= current_slot`).
 *
 * `now_slot` is never caller-supplied — the program computes
 * `max(Clock::get().slot, header.current_slot)` itself
 * (`authenticated_market_slot_or_fallback_view`, `v16_program.rs:6332-6339`). Callers must
 * pass the same `max` in `ctx.nowSlot`. Using the chain slot alone is a **false negative**
 * whenever the engine counter runs ahead, and a false negative here means a domain stays
 * bricked. It cannot produce a false positive, because the program recomputes the same
 * `max` and no caller can lower it.
 *
 * **Not modelled:** the engine's `CounterUnderflow` arm (`v16.rs:6444-6449`), which fires
 * only if the domain's `SourceCreditState` has drifted below its own bucket's totals. That
 * is a broken-invariant state, not a reachable steady state, and gating on it would need
 * two more u128 reads to defend against something that indicates corruption anyway.
 *
 * @param bucket - A decoded bucket from {@link parseBackingBucketsV17}.
 * @param ctx    - Market-level gates: mode, resolved `nowSlot`, addressable domain count.
 * @returns `true` iff the program will accept tag 89 for `bucket.domain` right now.
 *
 * @example
 * ```ts
 * const state = parseBackingBucketsV17(marketData, { chainSlot: await conn.getSlot() });
 * for (const b of state.buckets) {
 *   if (isBackingBucketExpirable(b, state)) {
 *     await send(encodeExpireBackingBucket({ domain: b.domain }));
 *   }
 * }
 * ```
 */
export function isBackingBucketExpirable(
  bucket: Pick<BackingBucketV17, "domain" | "status" | "expirySlot">,
  ctx: BackingBucketExpiryContext,
): boolean {
  // (1) Live-only mode gate.
  if (ctx.mode !== V17_MARKET_MODE_LIVE) return false;
  // (2)+(3) Wrapper bound AND engine bound, folded into one addressable count.
  if (bucket.domain < 0 || bucket.domain >= ctx.addressableDomainCount) return false;
  // (4) The lapse condition, exactly as the engine states it.
  if (bucket.status !== BackingBucketStatus.Fresh) return false;
  return ctx.nowSlot >= bucket.expirySlot;
}

/** Options for {@link parseBackingBucketsV17}. */
export interface ParseBackingBucketsOptions {
  /**
   * The current chain slot (`connection.getSlot()`).
   *
   * Omitting it is equivalent to the program's own fallback when `Clock::get()` fails:
   * `nowSlot` collapses to `header.current_slot`. That is safe (it can only under-report
   * lapses, never over-report them) but a keeper should always supply it — a market whose
   * `current_slot` lags produces false negatives, and a false negative leaves a domain
   * bricked.
   */
  chainSlot?: bigint | number;
}

/**
 * Decode every addressable source-domain backing bucket from a raw v17 market account.
 *
 * Reads `header.mode`, `header.current_slot` and `config.max_market_slots` once, then walks
 * the asset slots, emitting the LONG (`2i`) and SHORT (`2i+1`) bucket for each. Each bucket
 * carries both `lapsed` (the settlement deadlock condition) and `expirable` (whether tag 89
 * will actually be accepted) so a keeper never has to reconstruct the gates itself.
 *
 * @param data - Raw bytes of the v17 market group account.
 * @param opts - See {@link ParseBackingBucketsOptions}.
 * @returns The whole-market snapshot, including the resolved `nowSlot` used for the predicate.
 * @throws If the buffer is too short, or is not a v17 market account (bad magic/version/kind).
 *
 * @example
 * ```ts
 * const info = await connection.getAccountInfo(marketPk);
 * const state = parseBackingBucketsV17(new Uint8Array(info!.data), {
 *   chainSlot: await connection.getSlot(),
 * });
 * console.log(`${state.buckets.filter((b) => b.expirable).length} domain(s) need tag 89`);
 * ```
 */
export function parseBackingBucketsV17(
  data: Uint8Array,
  opts: ParseBackingBucketsOptions = {},
): BackingBucketMarketState {
  // VERSION-keyed geometry + typed refusal of unknown layouts (v2.1 = VERSION 18, v2.2 = VERSION 19).
  const geom = resolveMarketGeometry(data, { parser: "parseBackingBucketsV17", strictLength: false });
  const L = geom.layout;

  const groupOff = geom.groupOff;
  const mode = readU8At(data, groupOff + L.group.mode);
  const headerCurrentSlot = readU64LEAt(data, groupOff + L.group.currentSlot);
  const maxMarketSlots = readU32LEAt(
    data,
    groupOff + L.group.config + L.group.maxMarketSlotsInConfig,
  );

  // `authenticated_market_slot_or_fallback_view`: max(Clock, header.current_slot).
  // No chainSlot => the program's Clock-unavailable fallback, i.e. header.current_slot.
  const chainSlot =
    opts.chainSlot === undefined ? 0n : BigInt(opts.chainSlot);
  if (chainSlot < 0n) {
    throw new Error(`parseBackingBucketsV17: chainSlot must be non-negative, got ${chainSlot}`);
  }
  const nowSlot = chainSlot > headerCurrentSlot ? chainSlot : headerCurrentSlot;

  const physicalAssetSlots = geom.slotCount;
  const addressableAssetSlots = Math.min(maxMarketSlots, physicalAssetSlots);
  const addressableDomainCount = addressableAssetSlots * 2;

  const ctx: BackingBucketExpiryContext = { mode, nowSlot, addressableDomainCount };
  const buckets: BackingBucketV17[] = [];

  for (let assetIndex = 0; assetIndex < addressableAssetSlots; assetIndex++) {
    const engineBase = geom.engineOff(assetIndex);
    for (const side of ["long", "short"] as const) {
      const bucketOff =
        engineBase +
        (side === "long" ? L.engineSlot.backingLong : L.engineSlot.backingShort);
      if (bucketOff + V17_BACKING_BUCKET_LEN > data.length) break;

      const domain = assetIndex * 2 + (side === "short" ? 1 : 0);
      const status = readU8At(data, bucketOff + BB_STATUS);
      const expirySlot = readU64LEAt(data, bucketOff + BB_EXPIRY_SLOT);
      const lapsed = status === BackingBucketStatus.Fresh && nowSlot >= expirySlot;

      const bucket: BackingBucketV17 = {
        domain,
        assetIndex,
        side,
        marketId: readU64LEAt(data, bucketOff + BB_MARKET_ID),
        freshUnlienedBackingNum: readU128LEAt(data, bucketOff + BB_FRESH_UNLIENED),
        validLienedBackingNum: readU128LEAt(data, bucketOff + BB_VALID_LIENED),
        consumedLienedBackingNum: readU128LEAt(data, bucketOff + BB_CONSUMED_LIENED),
        impairedLienedBackingNum: readU128LEAt(data, bucketOff + BB_IMPAIRED_LIENED),
        utilizationFeeEarnings: readU128LEAt(data, bucketOff + BB_UTILIZATION_FEE),
        expirySlot,
        status,
        statusName: backingBucketStatusName(status),
        lapsed,
        expirable: false,
      };
      bucket.expirable = isBackingBucketExpirable(bucket, ctx);
      buckets.push(bucket);
    }
  }

  return {
    mode,
    headerCurrentSlot,
    nowSlot,
    maxMarketSlots,
    physicalAssetSlots,
    addressableDomainCount,
    buckets,
  };
}

/**
 * Convenience wrapper over {@link parseBackingBucketsV17}: the domains that need tag 89 now.
 *
 * Returns domain indices in ascending order, ready to feed straight into
 * `encodeExpireBackingBucket({ domain })`. Returns `[]` when there is nothing to do — the
 * common case on a healthy market, and the case in which a keeper must send nothing.
 *
 * @param data - Raw bytes of the v17 market group account.
 * @param opts - See {@link ParseBackingBucketsOptions}.
 * @returns Ascending list of expirable domain indices; empty when none are due.
 *
 * @example
 * ```ts
 * const domains = findExpirableBackingDomains(marketData, { chainSlot: slot });
 * for (const domain of domains) {
 *   tx.add(new TransactionInstruction({
 *     programId: WRAPPER_ID,
 *     keys: [{ pubkey: marketPk, isSigner: false, isWritable: true }],
 *     data: Buffer.from(encodeExpireBackingBucket({ domain })),
 *   }));
 * }
 * ```
 */
export function findExpirableBackingDomains(
  data: Uint8Array,
  opts: ParseBackingBucketsOptions = {},
): number[] {
  return parseBackingBucketsV17(data, opts)
    .buckets.filter((b) => b.expirable)
    .map((b) => b.domain);
}
