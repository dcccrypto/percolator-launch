/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/stake-wind-down.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * Stake-bound market wind-down (F-9, percolator-stake #301 `d13b5a9`, the relaunch stake), additive to SDK 8.0.0.
 * The relaunch wrapper (P1+P3 `58e379f1`) keeps the v18.2 header/slot layout these offsets read
 * (VERSION 18, config 576, header 758, slot 2325) — the same layout d13b5a9's stake pins.
 *
 * - {@link decodeTerminalInsuranceCapacity}: the wrapper tag-41 terminal capacity for an asset's
 *   insurance authority (on a stake-bound market asset 0's authority is the pool's `vault_auth`),
 *   computed exactly as the deployed v18.2 wrapper (`6377376a`
 *   `terminal_insurance_withdraw_capacity_for_authority_view`) and engine (`35ddd692`
 *   `domain_insurance_withdraw_capacity` / `available_domain_insurance`) do.
 * - {@link buildRecoverTerminalInsuranceIx} / {@link buildAdminCloseSlabIx}: stake tags 29 / 30.
 * - {@link planStakeWindDown}: the ordered keeper/admin flow.
 *
 * Offsets are hand-derived from the engine `#[repr(C)]` structs (every field is a byte-array Pod,
 * so the layout is packed) and calibrated against offsets this SDK already verifies
 * (`insurance` @ header+301, `oi_eff_long_q` @ asset+289, header 758 B, engine slot 1301 B);
 * `test/stake-wind-down.test.ts` also checks them against live devnet v18 markets (header
 * `insurance_domain_budget_remaining_total` == Σ(budget − spent) over every domain).
 *
 * @module stake-wind-down
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ACCOUNTS_WITHDRAW_PROTOCOL_FEE, buildAccountMetas } from "@percolatorct/sdk";
import { encodeWithdrawProtocolFee } from "@percolatorct/sdk";
import {
  adminCloseSlabAccounts,
  encodeStakeAdminCloseSlab,
  encodeStakeRecoverTerminalInsurance,
  recoverTerminalInsuranceAccounts,
} from "@percolatorct/sdk";
import type { AdminCloseSlabAccounts, RecoverTerminalInsuranceAccounts } from "@percolatorct/sdk";
import { deriveVaultAuthority } from "@percolatorct/sdk";
import { resolveMarketGeometry } from "../layout";

// ============================================================================
// Offsets
// ============================================================================

/** MarketGroupV16HeaderAccount field offsets (relative to the header at account offset 592). */
export const MARKET_GROUP_HEADER_OFF_V18 = Object.freeze({
  vault: 285,
  insurance: 301,
  cTot: 317,
  sourceInsuranceCreditReservedTotalAtoms: 445,
  insuranceDomainBudgetRemainingTotal: 461,
  materializedPortfolioCount: 517,
  mode: 626,
} as const);

/** EngineAssetSlotV16Account field offsets (relative to the engine slot = asset slot + 1024). */
export const ENGINE_ASSET_SLOT_OFF_V18 = Object.freeze({
  insuranceDomainBudgetLong: 515,
  insuranceDomainBudgetShort: 531,
  insuranceDomainSpentLong: 547,
  insuranceDomainSpentShort: 563,
  /** InsuranceCreditReservationV16Account; `insurance_credit_reserved_num` is its first u128. */
  insuranceReservationLong: 1157,
  insuranceReservationShort: 1229,
} as const);

/** Wrapper-owned bytes at the start of every asset slot (`ASSET_ORACLE_WRAPPER_LEN`). */
const ASSET_WRAPPER_LEN = 1024;
/** Engine `BOUND_SCALE` (reservation `_num` fields are in 1e-12 atoms). */
export const ENGINE_BOUND_SCALE = 1_000_000_000_000n;

/** Engine `MarketModeV16` byte. */
export const MARKET_MODE_V18 = Object.freeze({ Live: 0, Resolved: 1, Recovery: 2 } as const);

function u128(d: Uint8Array, o: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true);
}
function u64(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const subSat = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

// ============================================================================
// Terminal insurance capacity decoder
// ============================================================================

/** One insurance domain (domain = 2·asset + side; long = 0, short = 1). */
export interface InsuranceDomainBudget {
  domain: number;
  side: "long" | "short";
  budget: bigint;
  spent: bigint;
  /** ceil(insurance_credit_reserved_num / BOUND_SCALE). */
  reservedAtoms: bigint;
  /** budget − spent − reserved (saturating) — the engine's `budget_remaining`. */
  budgetRemaining: bigint;
  /** Engine `domain_insurance_withdraw_capacity`: min(globalAvailable, budgetRemaining, vault). */
  withdrawCapacity: bigint;
}

/** Decoded terminal-insurance state for one asset's insurance authority. */
export interface TerminalInsuranceCapacity {
  assetIndex: number;
  /** Engine market mode byte (see {@link MARKET_MODE_V18}). */
  mode: number;
  resolved: boolean;
  vault: bigint;
  insurance: bigint;
  cTot: bigint;
  materializedPortfolioCount: bigint;
  sourceInsuranceCreditReservedTotalAtoms: bigint;
  /** insurance − source_insurance_credit_reserved_total (saturating). */
  globalAvailable: bigint;
  /** Header `insurance_domain_budget_remaining_total` (all assets). */
  headerBudgetRemainingTotal: bigint;
  /** Σ (budget − spent) over this asset's two domains. */
  assetBudgetRemaining: bigint;
  domains: [InsuranceDomainBudget, InsuranceDomainBudget];
  /**
   * The wrapper tag-41 terminal capacity for this asset's insurance authority:
   * min(Σ domain withdrawCapacity, globalAvailable, vault). Assumes no OTHER asset shares the
   * same insurance_authority (true for a stake-bound single-asset market). Send this as the
   * tag-29 `amount`; a larger value fails wrapper 21.
   */
  terminalCapacity: bigint;
}

/**
 * Decode the tag-41 terminal insurance capacity for asset `assetIndex`'s insurance authority
 * from a raw v18 market account. On a stake-bound market call it with asset 0: the result's
 * `terminalCapacity` is the tag-29 `amount` for {@link planStakeWindDown} step (b).
 *
 * @param marketData  Raw wrapper market account bytes (kind 1).
 * @param assetIndex  Asset slot (default 0).
 * @returns Budgets per domain, the header aggregates and the terminal capacity.
 * @throws If the account is not a market or is too short for the asset.
 * @example
 * ```ts
 * const cap = decodeTerminalInsuranceCapacity(marketInfo.data, 0);
 * if (cap.resolved && cap.terminalCapacity > 0n) amount = cap.terminalCapacity;
 * ```
 */
export function decodeTerminalInsuranceCapacity(marketData: Uint8Array, assetIndex = 0): TerminalInsuranceCapacity {
  const geom = resolveMarketGeometry(marketData, { parser: "decodeTerminalInsuranceCapacity", strictLength: false });
  const H = geom.groupOff;
  const GL = geom.layout.group;
  const hdr = {
    vault: GL.vault,
    insurance: GL.insurance,
    cTot: GL.cTot,
    sourceInsuranceCreditReservedTotalAtoms: GL.sourceInsuranceCreditReservedTotalAtoms,
    insuranceDomainBudgetRemainingTotal: GL.insuranceDomainBudgetRemainingTotal,
    materializedPortfolioCount: GL.materializedPortfolioCount,
    mode: GL.mode,
  };
  const slotBase = geom.engineOff(assetIndex);
  const E = geom.layout.engineSlot;
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || marketData.length < slotBase + E.insuranceReservationShort + 16) {
    throw new Error(`market account too short for asset ${assetIndex}`);
  }
  const vault = u128(marketData, H + hdr.vault);
  const insurance = u128(marketData, H + hdr.insurance);
  const sourceReserved = u128(marketData, H + hdr.sourceInsuranceCreditReservedTotalAtoms);
  const globalAvailable = subSat(insurance, sourceReserved);
  const mode = marketData[H + hdr.mode];
  const dom = (side: "long" | "short"): InsuranceDomainBudget => {
    const L = side === "long";
    const budget = u128(marketData, slotBase + (L ? E.insuranceDomainBudgetLong : E.insuranceDomainBudgetShort));
    const spent = u128(marketData, slotBase + (L ? E.insuranceDomainSpentLong : E.insuranceDomainSpentShort));
    const reservedAtoms = ceilDiv(u128(marketData, slotBase + (L ? E.insuranceReservationLong : E.insuranceReservationShort)), ENGINE_BOUND_SCALE);
    const budgetRemaining = subSat(subSat(budget, spent), reservedAtoms);
    return {
      domain: assetIndex * 2 + (L ? 0 : 1), side, budget, spent, reservedAtoms, budgetRemaining,
      withdrawCapacity: min(min(globalAvailable, budgetRemaining), vault),
    };
  };
  const domains: [InsuranceDomainBudget, InsuranceDomainBudget] = [dom("long"), dom("short")];
  const sum = domains[0].withdrawCapacity + domains[1].withdrawCapacity;
  return {
    assetIndex, mode, resolved: mode === MARKET_MODE_V18.Resolved, vault, insurance,
    cTot: u128(marketData, H + hdr.cTot),
    materializedPortfolioCount: u64(marketData, H + hdr.materializedPortfolioCount),
    sourceInsuranceCreditReservedTotalAtoms: sourceReserved, globalAvailable,
    headerBudgetRemainingTotal: u128(marketData, H + hdr.insuranceDomainBudgetRemainingTotal),
    assetBudgetRemaining: subSat(domains[0].budget, domains[0].spent) + subSat(domains[1].budget, domains[1].spent),
    domains,
    terminalCapacity: min(min(sum, globalAvailable), vault),
  };
}

// ============================================================================
// Tag 29 / 30 instruction builders
// ============================================================================

/**
 * Build stake tag 29 RecoverTerminalInsurance.
 *
 * @param a       Stake program id + named accounts (`stray` optional).
 * @param amount  Atoms (use {@link decodeTerminalInsuranceCapacity}`.terminalCapacity`), or 0 to book/sweep only.
 * @returns TransactionInstruction (no signer required).
 * @example
 * ```ts
 * const ix = buildRecoverTerminalInsuranceIx({ stakeProgram, caller, pool, poolVault, vaultAuth, market,
 *   wrapperVault, wrapperVaultAuthority, wrapperProgram }, cap.terminalCapacity);
 * ```
 */
export function buildRecoverTerminalInsuranceIx(
  a: RecoverTerminalInsuranceAccounts & { stakeProgram: PublicKey },
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.stakeProgram,
    keys: recoverTerminalInsuranceAccounts(a),
    data: Buffer.from(encodeStakeRecoverTerminalInsurance(amount)),
  });
}

/**
 * Build stake tag 30 AdminCloseSlab (signed by `pool.admin`). `poolDestToken` must already exist
 * (a pool-mint token account owned by the pool PDA).
 *
 * @param a  Stake program id + named accounts.
 * @returns TransactionInstruction.
 * @example
 * ```ts
 * const ix = buildAdminCloseSlabIx({ stakeProgram, admin, pool, market, wrapperVault, wrapperVaultAuthority,
 *   poolDestToken, collateralMint, poolVault, wrapperProgram });
 * ```
 */
export function buildAdminCloseSlabIx(a: AdminCloseSlabAccounts & { stakeProgram: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: a.stakeProgram,
    keys: adminCloseSlabAccounts(a),
    data: Buffer.from(encodeStakeAdminCloseSlab()),
  });
}

// ============================================================================
// Wind-down planner
// ============================================================================

/** One planned step. `onCustomError` maps a Custom(code) result to what the caller should do. */
export type StakeWindDownStep =
  | { step: "closePortfolios"; ixs: TransactionInstruction[] }
  | { step: "recoverTerminal"; ix: TransactionInstruction; amount: bigint; onCustomError: Readonly<Record<number, "retryLater" | "done">> }
  | { step: "recoverTerminalBookOnly"; ix: TransactionInstruction; onCustomError: Readonly<Record<number, "retryLater" | "done">> }
  | {
    step: "adminCloseSlab";
    ix: TransactionInstruction;
    /** Re-send `ix` while the market account is not a tombstone (`isClosedMarketTombstone`). */
    repeatUntil: "tombstone";
    /** Send before each repeat when a protocol fee is owed again (P1 re-books fee legs). */
    claimBetween: TransactionInstruction | null;
  };

/** Inputs for {@link planStakeWindDown}. */
export interface StakeWindDownArgs {
  stakeProgram: PublicKey;
  wrapperProgram: PublicKey;
  /** Keeper (tag 29 caller; no signature needed). */
  caller: PublicKey;
  /** `pool.admin` (tag 30 signer). */
  admin: PublicKey;
  pool: PublicKey;
  poolVault: PublicKey;
  vaultAuth: PublicKey;
  market: PublicKey;
  /** Raw market account bytes, read just before planning. */
  marketData: Uint8Array;
  wrapperVault: PublicKey;
  poolDestToken: PublicKey;
  collateralMint: PublicKey;
  /** Step (a): caller-built portfolio close-out instructions (may be empty). */
  closePortfolioIxs: TransactionInstruction[];
  /** Optional stray vault_auth-owned token account to sweep in the book-only step. */
  stray?: PublicKey;
  /** If set, a tag-84 WithdrawProtocolFee(amount 0 = all) claim is planned between tag-30 repeats. */
  protocolFee?: { authority: PublicKey; destToken: PublicKey; authorityEpoch: bigint };
  tokenProgram?: PublicKey;
}

/**
 * Plan the F-9 wind-down of a stake-bound market once it is Resolved:
 *   (a) close portfolios (caller-supplied);
 *   (b) tag 29 with amount = asset-0 terminal capacity (skipped when 0) — wrapper 21 → retry later;
 *   (c) tag 29 with amount 0 (+ optional stray) — stake 31 NothingToRecover → done;
 *   (d) tag 30, repeated while the market is not a tombstone, with a tag-84 claim in between
 *       when protocol legs were re-booked.
 *
 * @param a  Accounts, market bytes and optional protocol-fee claim inputs.
 * @returns Ordered steps.
 * @throws If the market is not Resolved (tag 29 amount>0 and tag 30 would fail 30 MarketNotTerminal).
 * @example
 * ```ts
 * for (const s of planStakeWindDown(args)) { ... }
 * ```
 */
export function planStakeWindDown(a: StakeWindDownArgs): StakeWindDownStep[] {
  const cap = decodeTerminalInsuranceCapacity(a.marketData, 0);
  if (!cap.resolved) throw new Error(`planStakeWindDown: market mode ${cap.mode} is not Resolved (1)`);
  const tokenProgram = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  const [wrapperVaultAuthority] = deriveVaultAuthority(a.wrapperProgram, a.market);
  const base = {
    stakeProgram: a.stakeProgram, caller: a.caller, pool: a.pool, poolVault: a.poolVault, vaultAuth: a.vaultAuth,
    market: a.market, wrapperVault: a.wrapperVault, wrapperVaultAuthority, wrapperProgram: a.wrapperProgram, tokenProgram,
  };
  const steps: StakeWindDownStep[] = [{ step: "closePortfolios", ixs: a.closePortfolioIxs }];
  if (cap.terminalCapacity > 0n) {
    steps.push({
      step: "recoverTerminal", amount: cap.terminalCapacity,
      ix: buildRecoverTerminalInsuranceIx(base, cap.terminalCapacity),
      onCustomError: Object.freeze({ 21: "retryLater" as const, 31: "done" as const }),
    });
  }
  steps.push({
    step: "recoverTerminalBookOnly",
    ix: buildRecoverTerminalInsuranceIx({ ...base, stray: a.stray }, 0n),
    onCustomError: Object.freeze({ 31: "done" as const }),
  });
  const claim = a.protocolFee
    ? new TransactionInstruction({
      programId: a.wrapperProgram,
      keys: buildAccountMetas(ACCOUNTS_WITHDRAW_PROTOCOL_FEE, {
        authority: a.protocolFee.authority, market: a.market, destToken: a.protocolFee.destToken,
        vaultToken: a.wrapperVault, vaultAuthority: wrapperVaultAuthority, tokenProgram,
      }),
      data: Buffer.from(encodeWithdrawProtocolFee({ amount: 0n, authorityEpoch: a.protocolFee.authorityEpoch })),
    })
    : null;
  steps.push({
    step: "adminCloseSlab", repeatUntil: "tombstone", claimBetween: claim,
    ix: buildAdminCloseSlabIx({
      stakeProgram: a.stakeProgram, admin: a.admin, pool: a.pool, market: a.market, wrapperVault: a.wrapperVault,
      wrapperVaultAuthority, poolDestToken: a.poolDestToken, collateralMint: a.collateralMint, poolVault: a.poolVault,
      wrapperProgram: a.wrapperProgram, tokenProgram,
    }),
  });
  return steps;
}
