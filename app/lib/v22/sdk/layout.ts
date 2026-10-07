/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ adf8fd0 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/abi/layout.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * Account LAYOUT tables keyed on the wrapper VERSION, plus the VERSION / discriminator guard that
 * every slab and portfolio decoder runs before it reads a single field.
 *
 * Why this exists (security reviews of the v2.2 stack, "silent misread" findings): the wrapper
 * hand-lays every account, the engine grows its structs between releases, and a decoder that picks
 * its geometry from the buffer LENGTH alone happily reads a v2.2 market with v2.1 offsets. The
 * result is numbers that look plausible and are wrong. So geometry is chosen by VERSION (the u16 at
 * offset 8 of every wrapper-owned account), the engine layout discriminator is checked wherever the
 * account carries one (portfolios), and anything else is refused with a typed
 * {@link UnknownLayoutError}.
 *
 * Tables:
 *
 * - {@link LAYOUT_V21}: wrapper VERSION 18, engine discriminator 18. FROZEN. Every value equals the constant the v2.1
 *   decoders have always used (pinned by `test/layout-guard.test.ts`).
 * - {@link LAYOUT_V22_VARIANT_B}: wrapper VERSION 19, the v2.2 LAUNCH CANDIDATE (`release/v22-wrapper-rem` c8501d15 on
 *   `release/v22-engine-rem`: per-leg K/F remainders + the 32 B slot tail): leg 217, portfolio 10,603, slot 2,629.
 *   **PROVISIONAL**, pinned against the real crate by `test/fixtures/v22-parity.json` (rustc `offset_of!`).
 * - {@link LAYOUT_V22_STAGE_A}: the earlier stage-A numbers (leg 185, portfolio 10,091, slot 2,597), kept as a named row.
 * - {@link LAYOUT_V22} is the alias every default uses (variant B). Another stacked engine fix may still move numbers:
 *   edit the rows in this file only (and regenerate the fixture); no decoder holds a layout number of its own.
 *
 * @module layout
 */

// ============================================================================
// Typed refusal
// ============================================================================

/** Why a buffer was refused. */
export type LayoutErrorCode =
  | "TOO_SHORT"
  | "BAD_MAGIC"
  | "UNKNOWN_VERSION"
  | "WRONG_KIND"
  | "DISCRIMINATOR_MISMATCH"
  | "PROVENANCE_VERSION"
  | "BAD_LENGTH"
  | "INVALID_RECORD";

/**
 * Thrown by every guarded decoder when the account is not a layout this SDK knows. It extends
 * `Error` and keeps the historical message prefixes, so callers that matched on text keep working;
 * new callers should switch on {@link UnknownLayoutError.code}.
 */
export class UnknownLayoutError extends Error {
  /** Machine-readable reason. */
  readonly code: LayoutErrorCode;
  /** The decoder that refused (for example `parsePortfolioV17`). */
  readonly parser: string;
  /** The VERSION found in the buffer, when it was readable. */
  readonly version?: number;
  /** The engine layout discriminator found in the buffer, when it was readable. */
  readonly discriminator?: number;
  /** The account kind byte found in the buffer, when it was readable. */
  readonly kind?: number;

  constructor(code: LayoutErrorCode, parser: string, message: string, found: { version?: number; discriminator?: number; kind?: number } = {}) {
    super(`${parser}: ${message}`);
    this.name = "UnknownLayoutError";
    this.code = code;
    this.parser = parser;
    if (found.version !== undefined) this.version = found.version;
    if (found.discriminator !== undefined) this.discriminator = found.discriminator;
    if (found.kind !== undefined) this.kind = found.kind;
  }
}

// ============================================================================
// Table shape
// ============================================================================

/** Offsets inside the market-group header (relative to `marketGroupOff + 0`). */
export interface GroupHeaderOffsets {
  /** `V16ConfigAccount` starts here; `config.max_market_slots` is a u32 at +2. */
  config: number;
  maxMarketSlotsInConfig: number;
  assetSlotCapacity: number;
  vault: number;
  insurance: number;
  cTot: number;
  sourceInsuranceCreditReservedTotalAtoms: number;
  insuranceDomainBudgetRemainingTotal: number;
  materializedPortfolioCount: number;
  currentSlot: number;
  mode: number;
}

/** Offsets inside `AssetStateV16Account` (relative to the engine slot start). */
export interface AssetStateOffsets {
  rawOracleTargetPrice: number;
  effectivePrice: number;
  oiEffLongQ: number;
  oiEffShortQ: number;
}

/** Offsets inside `EngineAssetSlotV16Account` (relative to the engine slot start). */
export interface EngineSlotOffsets {
  insuranceDomainBudgetLong: number;
  insuranceDomainBudgetShort: number;
  insuranceDomainSpentLong: number;
  insuranceDomainSpentShort: number;
  sourceCreditLong: number;
  sourceCreditShort: number;
  backingLong: number;
  backingShort: number;
  insuranceReservationLong: number;
  insuranceReservationShort: number;
}

/** Offsets inside the wrapper-owned prefix of an asset slot (identical in v2.1 and v2.2). */
export interface WrapperSlotOffsets {
  oracleProfile: number;
  controlSequences: number;
  riskLimits: number;
  growth: number;
  vaultLpDraw: number;
  vaultLp: number;
  /** `lot_exp` byte inside the oracle profile (`_padding0[0]`); 0 on v2.1 markets. */
  profileLotExp: number;
  /** `p4_flags` byte inside the oracle profile (`_padding0[1]`). */
  profileP4Flags: number;
}

/** Offsets inside one `PortfolioLegV16Account` (relative to the leg start). */
export interface LegOffsets {
  active: number;
  assetIndex: number;
  marketId: number;
  side: number;
  basisPosQ: number;
  aBasis: number;
  kSnap: number;
  fSnap: number;
  kfEpochSnap: number;
  epochSnap: number;
  lossWeight: number;
  bSnap: number;
  bRem: number;
  bEpochSnap: number;
  bStale: number;
  stale: number;
  /** v2.2 band/rent tail; `null` on v2.1. */
  bandEpochSnap: number | null;
  bandLiqPending: number | null;
  rentSnap: number | null;
  rentCarry: number | null;
}

/** The portfolio geometry (absolute account offsets unless stated). */
export interface PortfolioGeometry {
  /** Total account length: the wrapper's `PORTFOLIO_ACCOUNT_LEN`. */
  accountLen: number;
  legStride: number;
  legCount: number;
  legsOff: number;
  sourceDomainsOff: number;
  sourceDomainStride: number;
  sourceDomainCap: number;
  /** `PortfolioMatcherConfigV16` (104 B) then the 24 B identity trailer follow the engine body. */
  matcherConfigOff: number;
  /** Absolute offset of `ResolvedPayoutReceiptV16Account` (66 B: four u128, `present`, `finalized`). */
  resolvedPayoutReceiptOff: number;
  identityTrailerLen: number;
  /** Provenance header: `version` u16 and `layout_discriminator` u16. */
  provenanceVersionOff: number;
  provenanceDiscriminatorOff: number;
  leg: LegOffsets;
}

/** Body / account lengths of the new standalone accounts (header excluded unless noted). */
export interface StandaloneAccountLens {
  /** Wrapper account header: magic u64, version u16, kind u8, pad[5]. */
  headerLen: number;
  redemptionBody: number;
  /** `LpRedemptionExtV22` appended to the body of a v2.2-form request. */
  redemptionExtBody: number;
  bondTrancheBody: number;
  bondPositionBody: number;
  insuranceUnitsBody: number;
  g9FeedAllowlistBody: number;
  g9FeedAllowlistCap: number;
}

/**
 * Band / holding-rent state words (v2.2 only; null on v2.1). Config offsets are relative to the CONFIG start
 * (marketGroupOff + group.config), asset-state offsets to the ENGINE slot start, growth / vaultLp offsets to the
 * record start (slot + wrapperSlot.growth / slot + wrapperSlot.vaultLp).
 */
export interface BandRentOffsets {
  configLen: number;
  config: { maxAccrualDtSlots: number; maxPriceMoveBpsPerSlot: number; bandBps: number; bandMaxEpochSlots: number; bandMaxPinSlots: number; rentMaxE9PerSlot: number; bandMaxPositionsPerSide: number; bandMinLegNotional: number };
  assetState: { bandAnchorPrice: number; bandAnchorSlot: number; bandEpoch: number; bandUncertifiedLong: number; bandUncertifiedShort: number; bandLiqPendingLong: number; bandLiqPendingShort: number; bandPinSinceSlot: number; rentIndexLongNum: number; rentIndexShortNum: number; rentUnroutedAtoms: number };
  growth: { rentKinkBps: number; rentNCapQ: number };
  vaultLp: { lpNetQ: number; flags: number };
}

/** One complete layout. */
export interface LayoutTable {
  /** Human name. */
  readonly name: string;
  /** `FROZEN` (deployed / released) or `PROVISIONAL` (final values come from the combined build). */
  readonly status: "FROZEN" | "PROVISIONAL";
  /** Where the numbers come from. */
  readonly source: string;
  /** Wrapper `constants::VERSION` (u16 at account offset 8). */
  readonly version: number;
  /** Engine `V16_LAYOUT_DISCRIMINATOR` (stored in every portfolio's provenance header). */
  readonly engineDiscriminator: number;
  readonly headerLen: number;
  readonly wrapperConfigLen: number;
  /** `HEADER_LEN + WRAPPER_CONFIG_LEN`: where the market-group header starts. */
  readonly marketGroupOff: number;
  /** `MARKET_GROUP_LEN`: size of `MarketGroupV16HeaderAccount`. */
  readonly marketGroupLen: number;
  /** `MARKET_ASSET_SLOT_LEN`: stride of one asset slot (`wrapperSlotLen + engineSlotLen`). */
  readonly assetSlotStride: number;
  /** `ASSET_ORACLE_WRAPPER_LEN`: wrapper prefix of each slot. */
  readonly wrapperSlotLen: number;
  /** `size_of::<EngineAssetSlotV16Account>()`. */
  readonly engineSlotLen: number;
  /** `size_of::<AssetStateV16Account>()`. */
  readonly assetStateLen: number;
  readonly group: GroupHeaderOffsets;
  readonly assetState: AssetStateOffsets;
  readonly engineSlot: EngineSlotOffsets;
  readonly wrapperSlot: WrapperSlotOffsets;
  readonly portfolio: PortfolioGeometry;
  readonly accounts: StandaloneAccountLens;
  /** Band / rent state offsets; `null` on v2.1. */
  readonly bandRent: BandRentOffsets | null;
}

// ============================================================================
// LAYOUT_V21 (wrapper VERSION 18): frozen, equals the constants the v2.1 decoders always used
// ============================================================================

const WRAPPER_SLOT: WrapperSlotOffsets = Object.freeze({
  oracleProfile: 0,
  controlSequences: 512,
  riskLimits: 608,
  growth: 672,
  vaultLpDraw: 832,
  vaultLp: 896,
  profileLotExp: 19,
  profileP4Flags: 20,
});

const STANDALONE_V22: StandaloneAccountLens = Object.freeze({
  headerLen: 16,
  redemptionBody: 96,
  redemptionExtBody: 16,
  bondTrancheBody: 128,
  bondPositionBody: 96,
  insuranceUnitsBody: 192,
  g9FeedAllowlistBody: 520,
  g9FeedAllowlistCap: 16,
});

/**
 * Wrapper VERSION 18 (v2.1; also the `ETDLAdi`-lineage v17/v18 market layout this SDK always read).
 * FROZEN: do not edit; `test/layout-guard.test.ts` pins every value to the legacy constants.
 */
export const LAYOUT_V21: LayoutTable = Object.freeze({
  name: "v2.1",
  status: "FROZEN" as const,
  source: "percolator-prog release/v21-wrapper ff65ec50 on engine 1c053113 (VERSION 18, discriminator 18)",
  version: 18,
  engineDiscriminator: 18,
  headerLen: 16,
  wrapperConfigLen: 576,
  marketGroupOff: 592,
  marketGroupLen: 758,
  assetSlotStride: 2325,
  wrapperSlotLen: 1024,
  engineSlotLen: 1301,
  assetStateLen: 515,
  group: Object.freeze({
    config: 32,
    maxMarketSlotsInConfig: 2,
    assetSlotCapacity: 281,
    vault: 285,
    insurance: 301,
    cTot: 317,
    sourceInsuranceCreditReservedTotalAtoms: 445,
    insuranceDomainBudgetRemainingTotal: 461,
    materializedPortfolioCount: 517,
    currentSlot: 613,
    mode: 626,
  }),
  assetState: Object.freeze({ rawOracleTargetPrice: 17, effectivePrice: 25, oiEffLongQ: 289, oiEffShortQ: 305 }),
  engineSlot: Object.freeze({
    insuranceDomainBudgetLong: 515,
    insuranceDomainBudgetShort: 531,
    insuranceDomainSpentLong: 547,
    insuranceDomainSpentShort: 563,
    sourceCreditLong: 595,
    sourceCreditShort: 779,
    backingLong: 963,
    backingShort: 1060,
    insuranceReservationLong: 1157,
    insuranceReservationShort: 1229,
  }),
  wrapperSlot: WRAPPER_SLOT,
  portfolio: Object.freeze({
    accountLen: 9563,
    legStride: 152,
    legCount: 16,
    legsOff: 356,
    sourceDomainsOff: 356 + 16 * 152,
    sourceDomainStride: 196,
    sourceDomainCap: 32,
    matcherConfigOff: 9563 - 104 - 24,
    resolvedPayoutReceiptOff: 9369,
    identityTrailerLen: 24,
    provenanceVersionOff: 112,
    provenanceDiscriminatorOff: 114,
    leg: Object.freeze({
      active: 0, assetIndex: 1, marketId: 5, side: 13, basisPosQ: 14, aBasis: 30, kSnap: 46, fSnap: 62,
      kfEpochSnap: 78, epochSnap: 86, lossWeight: 94, bSnap: 110, bRem: 126, bEpochSnap: 142, bStale: 150, stale: 151,
      bandEpochSnap: null, bandLiqPending: null, rentSnap: null, rentCarry: null,
    }),
  }),
  accounts: STANDALONE_V22,
  bandRent: null,
});

// ============================================================================
// LAYOUT_V22 (wrapper VERSION 19): PROVISIONAL, THE ONE TABLE TO EDIT
// ============================================================================

const BAND_RENT_V22: BandRentOffsets = Object.freeze({
  configLen: 297,
  config: Object.freeze({ maxAccrualDtSlots: 118, maxPriceMoveBpsPerSlot: 142, bandBps: 249, bandMaxEpochSlots: 257, bandMaxPinSlots: 265, rentMaxE9PerSlot: 273, bandMaxPositionsPerSide: 281, bandMinLegNotional: 289 }),
  assetState: Object.freeze({ bandAnchorPrice: 515, bandAnchorSlot: 523, bandEpoch: 531, bandUncertifiedLong: 539, bandUncertifiedShort: 547, bandLiqPendingLong: 555, bandLiqPendingShort: 563, bandPinSinceSlot: 571, rentIndexLongNum: 579, rentIndexShortNum: 595, rentUnroutedAtoms: 611 }),
  growth: Object.freeze({ rentKinkBps: 42, rentNCapQ: 48 }),
  vaultLp: Object.freeze({ lpNetQ: 32, flags: 90 }),
});

function v22Row(o: {
  name: string; source: string; slotStride: number; engineSlotLen: number; portfolioLen: number; legStride: number;
  leg: LegOffsets; receiptOff: number;
}): LayoutTable {
  return Object.freeze({
    name: o.name,
    status: "PROVISIONAL" as const,
    source: o.source,
    version: 19,
    engineDiscriminator: 19,
    headerLen: 16,
    wrapperConfigLen: 576,
    marketGroupOff: 592,
    marketGroupLen: 806,
    assetSlotStride: o.slotStride,
    wrapperSlotLen: 1024,
    engineSlotLen: o.engineSlotLen,
    assetStateLen: 627,
    group: Object.freeze({
      config: 32, maxMarketSlotsInConfig: 2, assetSlotCapacity: 329, vault: 333, insurance: 349, cTot: 365,
      sourceInsuranceCreditReservedTotalAtoms: 493, insuranceDomainBudgetRemainingTotal: 509,
      materializedPortfolioCount: 565, currentSlot: 661, mode: 674,
    }),
    assetState: Object.freeze({ rawOracleTargetPrice: 17, effectivePrice: 25, oiEffLongQ: 289, oiEffShortQ: 305 }),
    engineSlot: Object.freeze({
      insuranceDomainBudgetLong: 627, insuranceDomainBudgetShort: 643, insuranceDomainSpentLong: 659, insuranceDomainSpentShort: 675,
      sourceCreditLong: 707, sourceCreditShort: 891, backingLong: 1075, backingShort: 1172,
      insuranceReservationLong: 1269, insuranceReservationShort: 1341,
    }),
    wrapperSlot: WRAPPER_SLOT,
    portfolio: Object.freeze({
      accountLen: o.portfolioLen,
      legStride: o.legStride,
      legCount: 16,
      legsOff: 356,
      sourceDomainsOff: 356 + 16 * o.legStride,
      sourceDomainStride: 196,
      sourceDomainCap: 32,
      matcherConfigOff: o.portfolioLen - 104 - 24,
      resolvedPayoutReceiptOff: o.receiptOff,
      identityTrailerLen: 24,
      provenanceVersionOff: 112,
      provenanceDiscriminatorOff: 114,
      leg: Object.freeze(o.leg),
    }),
    accounts: STANDALONE_V22,
    bandRent: BAND_RENT_V22,
  });
}

const LEG_V21_PREFIX = { active: 0, assetIndex: 1, marketId: 5, side: 13, basisPosQ: 14, aBasis: 30, kSnap: 46, fSnap: 62 } as const;

/**
 * Wrapper VERSION 19, STAGE A (release/v22-wrapper b4390fe0 on engine release/v22-engine 73ef2c32): leg 185,
 * portfolio 10,091, slot 2,597. Kept as a named row for comparison and fixtures; NOT the launch candidate.
 */
export const LAYOUT_V22_STAGE_A: LayoutTable = v22Row({
  name: "v2.2 stage A (PROVISIONAL)",
  source: "percolator-prog release/v22-wrapper b4390fe0 on engine release/v22-engine 73ef2c32",
  slotStride: 2597, engineSlotLen: 1573, portfolioLen: 10091, legStride: 185, receiptOff: 9897,
  leg: {
    ...LEG_V21_PREFIX, kfEpochSnap: 78, epochSnap: 86, lossWeight: 94, bSnap: 110, bRem: 126, bEpochSnap: 142, bStale: 150, stale: 151,
    bandEpochSnap: 152, bandLiqPending: 160, rentSnap: 161, rentCarry: 177,
  },
});

/**
 * Wrapper VERSION 19, VARIANT B: the v2.2 LAUNCH CANDIDATE (branches release/v22-engine-rem and
 * release/v22-wrapper-rem, coordinator report 2026-10-06): per-leg K/F remainders (`k_rem_num` @78, `f_rem_num` @94,
 * every later leg field +32) and a second 32 B slot tail. Leg 217, portfolio 10,603, slot 2,629.
 *
 * The in-slot ENGINE offsets below assume the extra 32 B slot tail sits after the existing fields (so no offset moves);
 * `test/layout-guard.test.ts` verifies the whole row against `layout-v22.json` when that file is present. PROVISIONAL:
 * another stacked engine fix may still move numbers: edit this row only.
 */
export const LAYOUT_V22_VARIANT_B: LayoutTable = v22Row({
  name: "v2.2 variant B (PROVISIONAL, launch candidate)",
  source: "percolator-prog release/v22-wrapper-rem on engine release/v22-engine-rem; numbers from the coordinator table",
  slotStride: 2629, engineSlotLen: 1605, portfolioLen: 10603, legStride: 217, receiptOff: 10409,
  leg: {
    ...LEG_V21_PREFIX, kfEpochSnap: 110, epochSnap: 118, lossWeight: 126, bSnap: 142, bRem: 158, bEpochSnap: 174, bStale: 182, stale: 183,
    bandEpochSnap: 184, bandLiqPending: 192, rentSnap: 193, rentCarry: 209,
  },
});

/** The named v2.2 rows. */
export const LAYOUT_V22_ROWS = Object.freeze({ stageA: LAYOUT_V22_STAGE_A, variantB: LAYOUT_V22_VARIANT_B } as const);

/** The v2.2 layout every default uses: variant B (the launch candidate). Swap the alias to change the default. */
export const LAYOUT_V22: LayoutTable = LAYOUT_V22_VARIANT_B;

/** Every layout this SDK can decode, keyed on the wrapper VERSION. */
export const LAYOUTS_BY_VERSION: ReadonlyMap<number, LayoutTable> = new Map<number, LayoutTable>([
  [LAYOUT_V21.version, LAYOUT_V21],
  [LAYOUT_V22.version, LAYOUT_V22],
]);

/** Wrapper account magic (`"PERCV16\0"` little-endian). */
export const WRAPPER_ACCOUNT_MAGIC = 0x5045_5243_5631_3600n;

/** Account kind bytes (header byte 10). */
export const ACCOUNT_KIND = Object.freeze({
  Market: 1,
  Portfolio: 2,
  BackingDomainLedger: 3,
  InsuranceLedger: 4,
  LpVaultRegistry: 5,
  LpRedemption: 6,
  NftRegistry: 7,
  ClosedMarket: 8,
  VaultLpState: 9,
  VaultLpExt: 10,
  BondTranche: 11,
  BondPosition: 12,
  InsuranceUnits: 13,
  G9FeedAllowlist: 15,
} as const);

// ============================================================================
// The guard
// ============================================================================

function dv(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Read the 16-byte wrapper header.
 *
 * @param data  Raw account bytes.
 * @param parser  Caller name for error messages.
 * @returns `{ magic, version, kind }`.
 * @throws {@link UnknownLayoutError} `TOO_SHORT` when fewer than 16 bytes.
 * @example
 * ```ts
 * const { version, kind } = readWrapperHeader(info.data, "myDecoder");
 * ```
 */
export function readWrapperHeader(data: Uint8Array, parser = "readWrapperHeader"): { magic: bigint; version: number; kind: number } {
  if (data.length < 16) throw new UnknownLayoutError("TOO_SHORT", parser, `data too short (${data.length} < 16)`);
  const v = dv(data);
  return { magic: v.getBigUint64(0, true), version: v.getUint16(8, true), kind: data[10] };
}

/** Options for {@link resolveLayout}. */
export interface ResolveLayoutOptions {
  /** Caller name, used as the error prefix. */
  parser: string;
  /** Required account kind byte; omit to accept any kind. */
  kind?: number;
  /**
   * Restrict to these VERSIONs (for decoders that only know one geometry). Default: every version in
   * {@link LAYOUTS_BY_VERSION}.
   */
  versions?: readonly number[];
  /** Table registry override (tests). */
  registry?: ReadonlyMap<number, LayoutTable>;
}

/**
 * The VERSION guard: check magic, VERSION and (optionally) kind, and return the layout table for the
 * account's VERSION. NEVER infers the layout from the buffer length.
 *
 * @param data  Raw account bytes.
 * @param opts  See {@link ResolveLayoutOptions}.
 * @returns The layout table of the account's VERSION.
 * @throws {@link UnknownLayoutError} `TOO_SHORT`, `BAD_MAGIC`, `UNKNOWN_VERSION` or `WRONG_KIND`.
 * @example
 * ```ts
 * const L = resolveLayout(info.data, { parser: "myDecoder", kind: ACCOUNT_KIND.Market });
 * ```
 */
export function resolveLayout(data: Uint8Array, opts: ResolveLayoutOptions): LayoutTable {
  const { parser } = opts;
  const { magic, version, kind } = readWrapperHeader(data, parser);
  if (magic !== WRAPPER_ACCOUNT_MAGIC) throw new UnknownLayoutError("BAD_MAGIC", parser, "invalid v17 magic", { version, kind });
  const registry = opts.registry ?? LAYOUTS_BY_VERSION;
  const table = registry.get(version);
  const allowed = opts.versions === undefined || opts.versions.includes(version);
  if (!table || !allowed) {
    const known = (opts.versions ?? [...registry.keys()]).join(", ");
    throw new UnknownLayoutError(
      "UNKNOWN_VERSION",
      parser,
      `invalid v17 version (${version} is not a known layout; this SDK decodes VERSION ${known}). Refusing to read it with another layout's offsets.`,
      { version, kind },
    );
  }
  if (opts.kind !== undefined && kind !== opts.kind) {
    throw new UnknownLayoutError("WRONG_KIND", parser, `invalid v17 account kind (${kind} !== ${opts.kind})`, { version, kind });
  }
  return table;
}

/** Geometry of a market account resolved by VERSION. */
export interface MarketGeometry {
  readonly layout: LayoutTable;
  /** Absolute offset of the market-group header. */
  readonly groupOff: number;
  /** Absolute offset of asset slot 0. */
  readonly slotsBase: number;
  /** Number of whole asset slots physically present. */
  readonly slotCount: number;
  /** Absolute offset of asset slot `i` (wrapper prefix start). */
  slotOff(i: number): number;
  /** Absolute offset of asset `i`'s engine slot (`slotOff(i) + wrapperSlotLen`). */
  engineOff(i: number): number;
}

/** Options for {@link resolveMarketGeometry}. */
export interface MarketGeometryOptions {
  /** Caller name. */
  parser: string;
  /** Require the account to be an exact `groupEnd + n * stride` (default true; InitMarket enforces it). */
  strictLength?: boolean;
  /** Restrict to these VERSIONs. */
  versions?: readonly number[];
  registry?: ReadonlyMap<number, LayoutTable>;
}

/**
 * Resolve the geometry of a MARKET account (kind 1) by VERSION.
 *
 * @param data  Raw market account bytes.
 * @param opts  See {@link MarketGeometryOptions}.
 * @returns The geometry.
 * @throws {@link UnknownLayoutError}: `TOO_SHORT`, `BAD_MAGIC`, `UNKNOWN_VERSION`, `WRONG_KIND`, or
 *   `BAD_LENGTH` when the slot region is not a whole number of this VERSION's strides.
 * @example
 * ```ts
 * const g = resolveMarketGeometry(info.data, { parser: "myDecoder" });
 * const insurance = readU128(info.data, g.groupOff + g.layout.group.insurance);
 * ```
 */
export function resolveMarketGeometry(data: Uint8Array, opts: MarketGeometryOptions): MarketGeometry {
  const registry = opts.registry ?? LAYOUTS_BY_VERSION;
  // Shortest group end across the known layouts: anything below it cannot be a market of any of them.
  let minEnd = Infinity;
  for (const t of registry.values()) minEnd = Math.min(minEnd, t.marketGroupOff + t.marketGroupLen);
  if (data.length < minEnd) {
    throw new UnknownLayoutError("TOO_SHORT", opts.parser, `buffer too short: need >= ${minEnd} bytes, got ${data.length}`);
  }
  let layout: LayoutTable;
  try {
    layout = resolveLayout(data, { parser: opts.parser, kind: ACCOUNT_KIND.Market, versions: opts.versions, registry: opts.registry });
  } catch (e) {
    if (e instanceof UnknownLayoutError && (e.code === "BAD_MAGIC" || e.code === "WRONG_KIND" || e.code === "UNKNOWN_VERSION")) {
      // Keep the historical phrase so callers that matched on it still do.
      throw new UnknownLayoutError(e.code, opts.parser, `${e.code === "WRONG_KIND" ? `not a market account (kind ${e.kind}); ` : ""}not a v17 market account (bad magic, version, or kind): ${e.message.slice(opts.parser.length + 2)}`, { version: e.version, kind: e.kind });
    }
    throw e;
  }
  const groupOff = layout.marketGroupOff;
  const slotsBase = groupOff + layout.marketGroupLen;
  if (data.length < slotsBase) {
    throw new UnknownLayoutError("TOO_SHORT", opts.parser, `buffer too short: need >= ${slotsBase} bytes for a VERSION ${layout.version} market, got ${data.length}`, { version: layout.version, kind: ACCOUNT_KIND.Market });
  }
  const tail = data.length - slotsBase;
  if ((opts.strictLength ?? true) && tail % layout.assetSlotStride !== 0) {
    throw new UnknownLayoutError(
      "BAD_LENGTH",
      opts.parser,
      `market length ${data.length} is not ${slotsBase} + n x ${layout.assetSlotStride} (VERSION ${layout.version}); refusing to guess the layout from the length`,
      { version: layout.version, kind: ACCOUNT_KIND.Market },
    );
  }
  const stride = layout.assetSlotStride;
  return {
    layout,
    groupOff,
    slotsBase,
    slotCount: Math.floor(tail / stride),
    slotOff: (i: number) => slotsBase + i * stride,
    engineOff: (i: number) => slotsBase + i * stride + layout.wrapperSlotLen,
  };
}

/** Options for {@link resolvePortfolioLayout}. */
export interface PortfolioGuardOptions {
  parser: string;
  /** Require the exact account length of the VERSION (default false: legacy decoders tolerate truncation). */
  strictLength?: boolean;
  versions?: readonly number[];
  registry?: ReadonlyMap<number, LayoutTable>;
}

/**
 * Guard a PORTFOLIO account (kind 2): VERSION picks the table, then the engine provenance header must
 * carry that table's `layout_discriminator` and `version == 1`. A portfolio whose wrapper VERSION was
 * bumped but whose leg stride was not (the NFT finding) fails here instead of reading legs 1..15 at
 * the wrong offsets.
 *
 * @param data  Raw portfolio account bytes.
 * @param opts  See {@link PortfolioGuardOptions}.
 * @returns The layout table.
 * @throws {@link UnknownLayoutError}: any {@link LayoutErrorCode}.
 * @example
 * ```ts
 * const L = resolvePortfolioLayout(info.data, { parser: "parsePortfolioV17" });
 * ```
 */
export function resolvePortfolioLayout(data: Uint8Array, opts: PortfolioGuardOptions): LayoutTable {
  const layout = resolveLayout(data, { parser: opts.parser, kind: ACCOUNT_KIND.Portfolio, versions: opts.versions, registry: opts.registry });
  const g = layout.portfolio;
  if (data.length < g.provenanceDiscriminatorOff + 2) {
    throw new UnknownLayoutError("TOO_SHORT", opts.parser, `data too short (${data.length} < ${g.provenanceDiscriminatorOff + 2}) to carry the provenance header`, { version: layout.version, kind: ACCOUNT_KIND.Portfolio });
  }
  const v = dv(data);
  const provVersion = v.getUint16(g.provenanceVersionOff, true);
  const disc = v.getUint16(g.provenanceDiscriminatorOff, true);
  if (provVersion !== 1) {
    throw new UnknownLayoutError("PROVENANCE_VERSION", opts.parser, `provenance header version ${provVersion} !== 1`, { version: layout.version, discriminator: disc, kind: ACCOUNT_KIND.Portfolio });
  }
  if (disc !== layout.engineDiscriminator) {
    throw new UnknownLayoutError(
      "DISCRIMINATOR_MISMATCH",
      opts.parser,
      `engine layout discriminator ${disc} !== ${layout.engineDiscriminator} expected for wrapper VERSION ${layout.version}`,
      { version: layout.version, discriminator: disc, kind: ACCOUNT_KIND.Portfolio },
    );
  }
  if (opts.strictLength === true && data.length !== g.accountLen) {
    throw new UnknownLayoutError("BAD_LENGTH", opts.parser, `portfolio length ${data.length} !== ${g.accountLen} (VERSION ${layout.version})`, { version: layout.version, discriminator: disc, kind: ACCOUNT_KIND.Portfolio });
  }
  return layout;
}

/**
 * `getProgramAccounts` size filter for portfolios of one VERSION. Always pair it with a `memcmp` on
 * the VERSION so a length collision between layouts cannot match.
 *
 * @param layout  Table (default {@link LAYOUT_V22}).
 * @returns `{ dataSize, versionMemcmp }` ready to spread into `filters`.
 * @example
 * ```ts
 * const f = portfolioFilterForLayout(LAYOUT_V22);
 * ```
 */
export function portfolioFilterForLayout(layout: LayoutTable = LAYOUT_V22): { dataSize: number; versionMemcmp: { offset: number; bytes: string } } {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, layout.version, true);
  return { dataSize: layout.portfolio.accountLen, versionMemcmp: { offset: 8, bytes: base58Encode(b) } };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out === "" ? "1" : out;
}
