/*
 * LOCAL ADAPTER PORT, not original code: from percolator-sdk feat/v22-sdk-growth @ 7aeb7a13a1b95892a291e86f9e0b8453f85f1c61 (#427)
 * (tag 124 leverage guard, additive, no version bump; ported pieces identical to f1cada61 / #426), src/abi/lev-guard-v22.ts + src/solana/lev-guard-v22.ts. Ported minimally for the
 * app: constants, the instruction-data encoders, the op account lists, the age band, the guard / program-data PDAs, the op 0 INIT builder and
 * the TradeCpi / EvictAndTradeCpi guard tail. The kind-17 account DECODER and the keeper-side builders (ops 1 to 6) are not ported (the app only
 * needs to know the guard exists, not read it). Only the imports are retargeted (installed @percolatorct/sdk 8.0.0 root, ./v22-wire).
 * Account length note: the guard is 4,456 B here (`LEV_GUARD_ACCOUNT_LEN_V22`); percolator-prog #605 (burst-memory layout) makes it 4,472 B and the SDK decoder
 * (percolator-sdk #429) accepts both. The app never decodes a guard; its rent is costed at 4,472 B (`LEV_GUARD_RENT_ACCOUNT_LEN` in ../lev-guard.ts).
 * Delete when @percolatorct/sdk >= 9.0.0 ships these and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { buildAccountMetas, concatBytes, encU16, encU64, encU8 } from "@percolatorct/sdk";
import type { AccountSpec } from "@percolatorct/sdk";
import { IX_TAG_EXTENDED_V22, IX_TAG_V22 } from "./v22-wire";

/** The upgradeable loader (the wrapper's ProgramData lives under it). */
const BPF_LOADER_UPGRADEABLE_V22 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// ============================================================================
// Constants
// ============================================================================

/** Wrapper instruction tag (`constants::TAG_LEV_GUARD`). */
export const TAG_LEV_GUARD_V22 = 124;

/** Tag 124 ops (`lev_guard_v22::OP_*`). */
export const LEV_GUARD_OP_V22 = Object.freeze({
  Init: 0,
  SetRiskKey: 1,
  Report: 2,
  Tighten: 3,
  Poke: 4,
  LpStop: 5,
  SetT0: 6,
} as const);
export type LevGuardOpV22 = (typeof LEV_GUARD_OP_V22)[keyof typeof LEV_GUARD_OP_V22];

/** PDA seeds (`LEV_GUARD_SEED`, `VAULT_LP_STATE_SEED`, `VAULT_LP_EXT_SEED`, `DEPTH_SOURCE_SEED`). */
export const LEV_GUARD_SEEDS_V22 = Object.freeze({
  guard: "lev_guard",
  vaultLpState: "vault_lp",
  vaultLpExt: "vault_lp_ext",
  depthSource: "depth_src",
} as const);

/** Record length (`LEV_GUARD_REC_LEN`). */
export const LEV_GUARD_REC_LEN_V22 = 344;
/** Touched-set capacity (`W1_TOUCHED_CAP`). */
export const LEV_GUARD_TOUCHED_CAP_V22 = 512;
/** Touched-set byte length (`8 * W1_TOUCHED_CAP`). */
export const LEV_GUARD_TOUCHED_LEN_V22 = 8 * LEV_GUARD_TOUCHED_CAP_V22;
/** Body length (record + touched set). */
export const LEV_GUARD_BODY_LEN_V22 = LEV_GUARD_REC_LEN_V22 + LEV_GUARD_TOUCHED_LEN_V22;
/** Account length: 16-byte header + body = 4456. */
export const LEV_GUARD_ACCOUNT_LEN_V22 = 16 + LEV_GUARD_BODY_LEN_V22;
/** The only record version (`LEV_GUARD_VERSION`). */
export const LEV_GUARD_VERSION_V22 = 1;

/** `flags` bits. */
export const LEV_GUARD_FLAG_V22 = Object.freeze({ MINT_AUTH_LIVE: 1, FREEZE_AUTH_LIVE: 2 } as const);

/** Slots per hour / day (`SLOTS_PER_HOUR`, `SLOTS_PER_DAY`). */
export const LEV_SLOTS_PER_HOUR_V22 = 9_000n;
export const LEV_SLOTS_PER_DAY_V22 = 216_000n;
/** Age thresholds: no opens below 6 h; day below 24 h; week below 7 d; month below 30 d; mature after. */
export const LEV_AGE_NO_OPEN_SLOTS_V22 = 6n * LEV_SLOTS_PER_HOUR_V22;
export const LEV_AGE_DAY_SLOTS_V22 = LEV_SLOTS_PER_DAY_V22;
export const LEV_AGE_WEEK_SLOTS_V22 = 7n * LEV_SLOTS_PER_DAY_V22;
export const LEV_AGE_MONTH_SLOTS_V22 = 30n * LEV_SLOTS_PER_DAY_V22;
/** A risk report is fresh for 3 h and held (last value used) to 24 h. */
export const LEV_REPORT_FRESH_SLOTS_V22 = 3n * LEV_SLOTS_PER_HOUR_V22;
export const LEV_REPORT_HELD_SLOTS_V22 = LEV_SLOTS_PER_DAY_V22;
/** NAV per share fixed point (`NAV_ONE`). */
export const LEV_NAV_ONE_V22 = 1_000_000_000_000n;
/** A W1 round blocks LP-growing fills for this many slots after it opens (`W1_ROUND_SLOTS`, 9 000). */
export const LEV_W1_ROUND_SLOTS_V22 = 9_000n;
/** Max value of every bps field in a report (`report_ok`). */
export const LEV_REPORT_BPS_MAX_V22 = 10_000;

// ============================================================================
// Instruction data
// ============================================================================

const U16 = 0xffff;
function u16In(name: string, v: number, max = U16): void {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${name} must be an integer in 0..=${max}, got ${v}`);
}
function slotIn(name: string, v: bigint, min: bigint): void {
  if (typeof v !== "bigint" || v < min || v > (1n << 64n) - 1n) throw new Error(`${name} must be a u64 bigint >= ${min}, got ${String(v)}`);
}

/**
 * Op 0 INIT data: `[124, 0, t0: u64 LE]` (10 bytes).
 *
 * @param t0  Token start slot. `0n` = the current slot (what a creator passes); only the program's upgrade authority may pass an earlier slot.
 * @returns Instruction data.
 * @throws If `t0` is not a u64.
 * @example
 * ```ts
 * const data = encodeLevGuardInitV22(0n);
 * ```
 */
export function encodeLevGuardInitV22(t0: bigint = 0n): Uint8Array {
  slotIn("t0", t0, 0n);
  return concatBytes(encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.Init), encU64(t0));
}

/**
 * Op 1 SET_RISK_KEY data: `[124, 1, key: [u8; 32]]` (34 bytes). Upgrade authority only.
 *
 * @param key  The holder risk key; `null` or 32 zero bytes = no key (reports refused).
 * @returns Instruction data.
 * @throws If a byte array is not 32 bytes.
 * @example
 * ```ts
 * const data = encodeLevGuardSetRiskKeyV22(riskKeyPubkey);
 * ```
 */
export function encodeLevGuardSetRiskKeyV22(key: PublicKey | Uint8Array | null): Uint8Array {
  const k = key === null ? new Uint8Array(32) : key instanceof PublicKey ? key.toBytes() : key;
  if (k.length !== 32) throw new Error(`risk key must be 32 bytes, got ${k.length}`);
  return concatBytes(encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.SetRiskKey), k);
}

/** Op 2 REPORT fields. Each bps field is at most 10 000. */
export interface LevGuardReportV22 {
  /** Largest plausible holder dump as a price drop (bps). */
  jDumpBps: number;
  /** Insider / holder dump size used by the short-side cap (bps of price). */
  mIndBps: number;
  /** Leverage cap x100 (0 = no cap from the report; any u16). */
  lCapX100: number;
  /** Size multiplier on the size cap (bps, 10 000 = none). */
  nMultBps: number;
}

/**
 * Op 2 REPORT data: `[124, 2, j_dump_bps u16, m_ind_bps u16, l_cap_x100 u16, n_mult_bps u16]` (10 bytes), all LE.
 *
 * @param r  The report.
 * @returns Instruction data.
 * @throws If a bps field exceeds 10 000 or `lCapX100` is not a u16 (the program answers `Custom(134)` otherwise).
 * @example
 * ```ts
 * const data = encodeLevGuardReportV22({ jDumpBps: 2000, mIndBps: 5000, lCapX100: 0, nMultBps: 10000 });
 * ```
 */
export function encodeLevGuardReportV22(r: LevGuardReportV22): Uint8Array {
  u16In("jDumpBps", r.jDumpBps, LEV_REPORT_BPS_MAX_V22);
  u16In("mIndBps", r.mIndBps, LEV_REPORT_BPS_MAX_V22);
  u16In("lCapX100", r.lCapX100);
  u16In("nMultBps", r.nMultBps, LEV_REPORT_BPS_MAX_V22);
  return concatBytes(
    encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.Report),
    encU16(r.jDumpBps), encU16(r.mIndBps), encU16(r.lCapX100), encU16(r.nMultBps),
  );
}

/**
 * Op 3 TIGHTEN data: `[124, 3]`.
 * @returns Instruction data.
 * @example
 * ```ts
 * const data = encodeLevGuardTightenV22();
 * ```
 */
export function encodeLevGuardTightenV22(): Uint8Array {
  return concatBytes(encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.Tighten));
}

/**
 * Op 4 POKE data: `[124, 4]`.
 * @returns Instruction data.
 * @example
 * ```ts
 * const data = encodeLevGuardPokeV22();
 * ```
 */
export function encodeLevGuardPokeV22(): Uint8Array {
  return concatBytes(encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.Poke));
}

/**
 * Op 5 LP_STOP (W1) data: `[124, 5]`.
 * @returns Instruction data.
 * @example
 * ```ts
 * const data = encodeLevGuardLpStopV22();
 * ```
 */
export function encodeLevGuardLpStopV22(): Uint8Array {
  return concatBytes(encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.LpStop));
}

/**
 * Op 6 SET_T0 data: `[124, 6, t0: u64 LE]` (10 bytes). Upgrade authority only; the program requires `0 < t0 <= now`.
 *
 * @param t0  Non-zero token start slot.
 * @returns Instruction data.
 * @throws If `t0` is zero or not a u64.
 * @example
 * ```ts
 * const data = encodeLevGuardSetT0V22(250_000_000n);
 * ```
 */
export function encodeLevGuardSetT0V22(t0: bigint): Uint8Array {
  slotIn("t0", t0, 1n);
  return concatBytes(encU8(TAG_LEV_GUARD_V22), encU8(LEV_GUARD_OP_V22.SetT0), encU64(t0));
}

// ============================================================================
// Account lists (order = the Rust handler's `account(accounts, i)`; names are the buildAccountMetas keys)
// ============================================================================

/** Op 0 INIT (5): `[0]` market authority (creator) or upgrade authority, signer and writable (payer). */
export const ACCOUNTS_LEV_GUARD_INIT_V22: readonly AccountSpec[] = [
  { name: "authority", signer: true, writable: true },
  { name: "programData", signer: false, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "guard", signer: false, writable: true },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/** Op 1 SET_RISK_KEY / op 6 SET_T0 (4): the upgrade authority signs; the program's `expect_writable` is on the guard only. */
export const ACCOUNTS_LEV_GUARD_ADMIN_V22: readonly AccountSpec[] = [
  { name: "upgradeAuthority", signer: true, writable: false },
  { name: "programData", signer: false, writable: false },
  { name: "market", signer: false, writable: false },
  { name: "guard", signer: false, writable: true },
] as const;

/** Op 2 REPORT (3): the risk key signs. */
export const ACCOUNTS_LEV_GUARD_REPORT_V22: readonly AccountSpec[] = [
  { name: "riskKey", signer: true, writable: false },
  { name: "market", signer: false, writable: false },
  { name: "guard", signer: false, writable: true },
] as const;

/**
 * Op 3 TIGHTEN (6 + optional holder token account): `[0]` any (listed as the signer so the fee payer is a signer; the handler never reads it),
 * `[3]` depth-source pin PDA, `[4]` the pinned base mint, `[5]` the pinned pool base vault, `[6]` an optional holder token account.
 */
export const ACCOUNTS_LEV_GUARD_TIGHTEN_V22: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "market", signer: false, writable: false },
  { name: "guard", signer: false, writable: true },
  { name: "depthSource", signer: false, writable: false },
  { name: "baseMint", signer: false, writable: false },
  { name: "poolBaseVault", signer: false, writable: false },
] as const;

/**
 * Op 4 POKE (4 required): market and the bound vault-LP portfolio are writable (mutable views). With NAV sampling the tail is
 * `[4]` vault_lp_state and `[5]` the vault_lp_ext PDA (REQUIRED whenever `[4]` is passed; an empty account is fine if the ext does not exist yet).
 */
export const ACCOUNTS_LEV_GUARD_POKE_V22: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "guard", signer: false, writable: true },
  { name: "vaultLpPortfolio", signer: false, writable: true },
] as const;

/**
 * Op 5 LP_STOP / W1 (6 + opposing user portfolios): market, guard and vault-LP portfolio writable; `[4]` vault_lp_state, `[5]` vault_lp_ext PDA;
 * `[6..]` the opposing user portfolios to cut (all writable), at most as many as fit the transaction.
 */
export const ACCOUNTS_LEV_GUARD_LP_STOP_V22: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "market", signer: false, writable: true },
  { name: "guard", signer: false, writable: true },
  { name: "vaultLpPortfolio", signer: false, writable: true },
  { name: "vaultLpState", signer: false, writable: false },
  { name: "vaultLpExt", signer: false, writable: false },
] as const;



/** The token's age band (`AgeBand`). */
export type LevAgeBandV22 = "NoOpen" | "Day" | "Week" | "Month" | "Mature";

/**
 * Age band from the guard's T0 and the current slot (`lev_guard_v22::age_band`). A T0 in the future reads age 0 and fails closed to `NoOpen`.
 *
 * @param t0Slot   Guard `t0Slot`.
 * @param nowSlot  Current slot.
 * @returns `NoOpen` under 6 h (54 000 slots), `Day` under 24 h, `Week` under 7 d, `Month` under 30 d, else `Mature`.
 * @example
 * ```ts
 * levAgeBandV22(100n, 100n + 54_000n); // "Day"
 * ```
 */
export function levAgeBandV22(t0Slot: bigint, nowSlot: bigint): LevAgeBandV22 {
  if (nowSlot < t0Slot) return "NoOpen";
  const age = nowSlot - t0Slot;
  if (age < LEV_AGE_NO_OPEN_SLOTS_V22) return "NoOpen";
  if (age < LEV_AGE_DAY_SLOTS_V22) return "Day";
  if (age < LEV_AGE_WEEK_SLOTS_V22) return "Week";
  if (age < LEV_AGE_MONTH_SLOTS_V22) return "Month";
  return "Mature";
}

/** Whether the band is under 7 days old (`AgeBand::young`: NoOpen, Day or Week). */
export function levAgeBandIsYoungV22(band: LevAgeBandV22): boolean {
  return band === "NoOpen" || band === "Day" || band === "Week";
}

const enc = new TextEncoder();
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

/**
 * Leverage guard PDA, seeds `["lev_guard", market]`.
 *
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [guard] = deriveLevGuardV22(PROGRAM_ID, market);
 * ```
 */
export function deriveLevGuardV22(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode(LEV_GUARD_SEEDS_V22.guard), market.toBytes()], programId);
}

/**
 * The wrapper's ProgramData account, seeds `[program_id]` under the upgradeable loader (same as `deriveProgramDataAddressP3`).
 *
 * @param programId  Wrapper program id.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [pd] = deriveProgramDataV22(PROGRAM_ID);
 * ```
 */
export function deriveProgramDataV22(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE_V22);
}

/** Common context. */
export interface LevGuardCtxV22 {
  programId: PublicKey;
  market: PublicKey;
}

/**
 * Op 0 INIT. `authority` is the market authority (creator) or the upgrade authority; it signs and pays the guard's rent.
 *
 * @param c          Program and market.
 * @param authority  Signer, writable.
 * @param t0         0n (default) = now; only the upgrade authority may pass an earlier slot.
 * @returns The instruction.
 * @example
 * ```ts
 * const ix = buildLevGuardInitIxV22({ programId, market }, creator);
 * ```
 */
export function buildLevGuardInitIxV22(c: LevGuardCtxV22, authority: PublicKey, t0: bigint = 0n): TransactionInstruction {
  const keys = buildAccountMetas(ACCOUNTS_LEV_GUARD_INIT_V22, {
    authority, programData: deriveProgramDataV22(c.programId)[0], market: c.market, guard: deriveLevGuardV22(c.programId, c.market)[0],
    systemProgram: SystemProgram.programId,
  });
  return new TransactionInstruction({ programId: c.programId, keys, data: Buffer.from(encodeLevGuardInitV22(t0)) });
}

/**
 * Append the leverage guard (writable, non-signer) as the LAST account of a TradeCpi (tag 10) or EvictAndTradeCpi (tag 119) instruction.
 * Without it a risk-increasing fill on a guarded market fails `Custom(132)`; reduce-only fills do not need it. Call it after every other
 * account is in place (after {@link buildEvictAndTradeCpiIxV22}, which prepends the victim, or before it: the guard stays last either way).
 * Idempotent: an instruction whose last key is already the guard is returned as is. The input is not mutated.
 *
 * @param ix      A TradeCpi or EvictAndTradeCpi instruction.
 * @param market  The market the trade is on (`ix.keys[1]` for TradeCpi, `ix.keys[2]` for EvictAndTradeCpi is checked against it).
 * @returns A new instruction with the guard appended.
 * @throws If the data tag is not 10 or 119, or the market key is not where the tag puts it.
 * @example
 * ```ts
 * const ix = withLevGuardTailV22(buildTradeCpiIx(...), market);
 * ```
 */
export function withLevGuardTailV22(ix: TransactionInstruction, market: PublicKey): TransactionInstruction {
  const tag = ix.data[0];
  const marketIdx = tag === IX_TAG_EXTENDED_V22.TradeCpi ? 1 : tag === IX_TAG_V22.EvictAndTradeCpi ? 2 : -1;
  if (marketIdx < 0) throw new Error(`withLevGuardTailV22: expected TradeCpi (10) or EvictAndTradeCpi (119), got tag ${tag}`);
  if (!ix.keys[marketIdx]?.pubkey.equals(market)) throw new Error("withLevGuardTailV22: market is not at the expected account index of this instruction");
  const [guard] = deriveLevGuardV22(ix.programId, market);
  const last = ix.keys[ix.keys.length - 1];
  if (last.pubkey.equals(guard)) return ix;
  return new TransactionInstruction({ programId: ix.programId, keys: [...ix.keys, w(guard)], data: ix.data });
}
