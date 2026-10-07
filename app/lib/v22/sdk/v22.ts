/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ adf8fd0 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/v22.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * v2.2 instruction builders, account-list helpers, compute-budget presets, the Earn exit helper and
 * the atomic launch-bundle builder.
 *
 * Wire bytes live in `abi/v22-wire.ts` (golden-vector tested against the real wrapper crate); this
 * module only assembles them with the account lists the Rust handlers read. v1 (`ETDLAdi`) and v2.1
 * builders are untouched: callers opt into v2.2 by calling these and by targeting the v2.2 program id.
 *
 * @module v22
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ACCOUNTS_BOND_DEPOSIT_V22,
  ACCOUNTS_BOND_EXECUTE_WITHDRAW_V22,
  ACCOUNTS_BOND_REQUEST_WITHDRAW_V22,
  ACCOUNTS_EXECUTE_REDEMPTION_V22,
  ACCOUNTS_INIT_BOND_TRANCHE_V22,
  ACCOUNTS_INIT_INSURANCE_UNITS_V22,
  ACCOUNTS_INSURANCE_BACKSTOP_DRAW_V22,
  ACCOUNTS_REQUEST_REDEEM_LP_SHARES_V22,
  ACCOUNTS_RESCUE_DEPOSIT_V22,
  ACCOUNTS_SET_G9_FEED_ALLOWLIST_V22,
  ACCOUNTS_SETTLE_HOLDING_RENT_V22,
  ACCOUNTS_SWEEP_BAND_DUST_LEG_V22,
  BOND_TAIL_INDEX_V22,
  EXECUTE_REDEMPTION_COMPUTE_UNITS_V22,
  INSURANCE_UNITS_TAIL_FROM_V22,
  IX_TAG_EXTENDED_V22,
  IX_TAG_V22,
  REDEMPTION_REFRESH_MAX_V22,
  deriveBondPositionV22,
  deriveBondTrancheV22,
  deriveG9FeedAllowlistV22,
  deriveInsuranceUnitsV22,
  encodeBondDepositV22,
  encodeBondExecuteWithdrawV22,
  encodeBondRequestWithdrawV22,
  encodeEvictAndTradeCpiV22,
  encodeExecuteRedemptionV22,
  encodeInitBondTrancheV22,
  encodeInitInsuranceUnitsV22,
  encodeInsuranceBackstopDrawV22,
  encodeRequestRedeemLpSharesV22,
  encodeRescueDepositV22,
  encodeSetG9FeedAllowlistV22,
  encodeSettleHoldingRentV22,
  encodeSweepBandDustLegV22,
} from "./v22-wire";
import type { InitBondTrancheArgs } from "./v22-wire";
import { defaultMinPayoutV22, selectRefreshPortfoliosV22 } from "./v22-math";
import { LAYOUT_V22 } from "./layout";
import type { LayoutTable } from "./layout";
import { ACCOUNTS_LP_VAULT_DEPOSIT, buildAccountMetas, encodeDepositToLpVault, encodeLpVaultCrankFees, parseErrorFromLogs, deriveInsuranceLpMint, deriveLpBackingLedger, deriveLpEscrow, deriveLpRedemption, deriveLpVaultRegistry, deriveVaultAuthority, V17_WRAPPER_HEAP_FRAME_BYTES } from "@percolatorct/sdk";
import { buildWithdrawJuniorTrancheIxP3, deriveProgramDataAddressP3, deriveVaultLpStateP3, withBoundVaultLpTailP3 } from "./records/p3-vault-lp";
import { TX_LEGACY_MAX_BYTES, TX_V1_MAX_BYTES, computeBudgetInstructions, measureTxBytes } from "../../v21/sdk/txv1";
import type { BudgetParams, TxFormat } from "../../v21/sdk/txv1";

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

function ix(programId: PublicKey, keys: AccountMeta[], data: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/** Market context shared by the vault builders. */
export interface MarketV22 {
  /** v2.2 wrapper program id. */
  programId: PublicKey;
  market: PublicKey;
  /** `LpVaultRegistryV16.domain`: selects the own / sibling backing ledger. */
  registryDomain: number;
  /** The vault-owned LP portfolio (bound vaults). */
  lpPortfolio?: PublicKey;
  /** `["vault_lp_ext", market]` once the registry's ext flag is set. */
  vaultLpExt?: PublicKey;
}

function ledgers(m: Pick<MarketV22, "programId" | "market" | "registryDomain">): { ledger: PublicKey; siblingLedger: PublicKey } {
  return {
    ledger: deriveLpBackingLedger(m.programId, m.market, m.registryDomain)[0],
    siblingLedger: deriveLpBackingLedger(m.programId, m.market, m.registryDomain ^ 1)[0],
  };
}

// ============================================================================
// Compute-budget presets
// ============================================================================

/** One preset: a compute-unit limit, where the number comes from, and the heap. */
export interface ComputePresetV22 {
  /** Compute-unit limit to request. */
  units: number;
  /** `measured`: a worst case from the wave docs; `estimated`: a conservative bound, SIMULATE then size from `unitsConsumed`. */
  basis: "measured" | "estimated";
  /** Where the number comes from. */
  note: string;
}

/**
 * Compute-unit presets for the heavy v2.2 instructions. The runtime default (200k) always fails these. Every
 * wrapper transaction also needs the 128 KiB heap ({@link V17_WRAPPER_HEAP_FRAME_BYTES}), which
 * {@link computeBudgetPrelude} requests.
 *
 * Only the tag-77 and batch numbers are MEASURED (Wave A doc / ledger). The bond, rescue, G9 and rent
 * numbers are ESTIMATES scaled from the measured Earn instructions (`RECOMMENDED_CU_P3`: 77 non-refreshing ~
 * 285k..400k): simulate first and size from `unitsConsumed` x 1.2.
 */
export const COMPUTE_PRESETS_V22: Readonly<Record<string, ComputePresetV22>> = Object.freeze({
  executeRedemptionRefresh: { units: EXECUTE_REDEMPTION_COMPUTE_UNITS_V22, basis: "measured", note: "Wave A wire doc: 8 single-leg 1,016,434; 2 x 14-leg 1,199,659; 2 x 14-leg liquidating 1,199,215; Hybrid tail 1,018,782. Explicit 1.3M required." },
  executeRedemption: { units: 400_000, basis: "estimated", note: "No inline refresh; same family as vaultLpSettleResolved (400k, worst 285k)." },
  requestRedeem: { units: 120_000, basis: "estimated", note: "Escrow transfer + request PDA create." },
  settleHoldingRent: { units: 600_000, basis: "estimated", note: "A crank-equivalent accrual plus a portfolio refresh plus rent routing." },
  sweepBandDustLeg: { units: 600_000, basis: "estimated", note: "Bilateral close against the vault LP at P_last." },
  evictAndTradeCpi: { units: 1_000_000, basis: "estimated", note: "A forced close plus a full TradeCpi (600k each is the P3 worst case for the trade alone)." },
  initBondTranche: { units: 200_000, basis: "estimated", note: "Creates the ext (if absent) and the tranche PDA." },
  bondDeposit: { units: 600_000, basis: "estimated", note: "Prices the vault LP equity, then an engine deposit; like tradeCpi's valuation path." },
  bondRequestWithdraw: { units: 60_000, basis: "estimated", note: "Writes one position." },
  bondExecuteWithdraw: { units: 600_000, basis: "estimated", note: "Vault valuation + OI lock + engine withdraw." },
  lpVaultCrankFeesBond: { units: 400_000, basis: "estimated", note: "On a bond market 78 re-certifies the vault LP before valuing the bonds (N-1)." },
  insuranceBackstopDraw: { units: 600_000, basis: "estimated", note: "Draw-and-book plus an insurance move." },
  rescueDeposit: { units: 400_000, basis: "estimated", note: "Priced like tag 75 plus the certified value." },
  initInsuranceUnits: { units: 200_000, basis: "estimated", note: "Creates / refreshes a 208-byte PDA." },
  launchBundle: { units: 800_000, basis: "estimated", note: "74 + 94 + 107 in one transaction; 94 initialises the matcher context and a portfolio." },
});

/**
 * ComputeBudget prelude (heap + unit limit + optional price) for a preset, in the legacy / v0 instruction form.
 * For v1 transactions put the same numbers in the config (`v1ConfigFromBudget`).
 *
 * @param presetOrUnits  A preset name, or an explicit unit limit.
 * @param opts           `priorityMicroLamportsPerCu` and `heapBytes` (default the wrapper's 128 KiB).
 * @returns Instructions to prepend.
 * @example
 * ```ts
 * const tx = new Transaction().add(...computeBudgetPrelude("executeRedemptionRefresh"), executeIx);
 * ```
 */
export function computeBudgetPrelude(presetOrUnits: keyof typeof COMPUTE_PRESETS_V22 | number, opts: { priorityMicroLamportsPerCu?: number; heapBytes?: number } = {}): TransactionInstruction[] {
  const units = typeof presetOrUnits === "number" ? presetOrUnits : COMPUTE_PRESETS_V22[presetOrUnits]?.units;
  if (units === undefined) throw new Error(`unknown compute preset ${String(presetOrUnits)}`);
  const budget: BudgetParams = { computeUnitLimit: units, heapBytes: opts.heapBytes ?? V17_WRAPPER_HEAP_FRAME_BYTES, priorityMicroLamportsPerCu: opts.priorityMicroLamportsPerCu };
  return computeBudgetInstructions(budget);
}

// ============================================================================
// Wave A: Earn exit (tags 76 / 77 v2.2)
// ============================================================================

/** Inputs shared by the tag 76 / 77 builders. */
export interface RedemptionAccountsV22 {
  market: MarketV22;
  redeemer: PublicKey;
}

/**
 * RequestRedeemLpShares v2.2 (tag 76): the floor and `keeper_ok` ride in the wire; the request PDA is created
 * 128 bytes long.
 *
 * @param m               Market context.
 * @param redeemer        Redeemer (signer, pays the PDA rent).
 * @param redeemerLpAta   Redeemer's LP-share token account.
 * @param shares          LP shares.
 * @param minPayoutAtoms  Payout floor (non-zero); use {@link defaultMinPayoutV22} on a simulated quote.
 * @param keeperOk        Allow an unsigned (keeper) execution, loss-gated and at the floor.
 * @returns Instruction (8 accounts).
 * @example
 * ```ts
 * const ix = buildRequestRedeemLpSharesIxV22(m, user, userLpAta, shares, defaultMinPayoutV22(quote), false);
 * ```
 */
export function buildRequestRedeemLpSharesIxV22(m: Pick<MarketV22, "programId" | "market">, redeemer: PublicKey, redeemerLpAta: PublicKey, shares: bigint, minPayoutAtoms: bigint, keeperOk = false): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const metas = buildAccountMetas(ACCOUNTS_REQUEST_REDEEM_LP_SHARES_V22, {
    redeemer, registry, lpMint: deriveInsuranceLpMint(m.programId, m.market)[0], redeemerLpAta, escrow: deriveLpEscrow(m.programId, m.market)[0],
    redemption: deriveLpRedemption(m.programId, registry, redeemer)[0], tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  });
  return ix(m.programId, metas, encodeRequestRedeemLpSharesV22({ shares, minPayoutAtoms, keeperOk }));
}

/** Options for {@link buildExecuteRedemptionIxV22}. */
export interface ExecuteRedemptionOptsV22 {
  /** Payout floor on the wire; the program uses `max(wire, stored)`. */
  minPayoutAtoms: bigint;
  /**
   * Stale positioned portfolios of the vault's asset to refresh inline, in priority order (writable at
   * `[13..13+n]`). NON-bound Live vaults only. Use {@link selectRefreshPortfoliosV22} to respect the leg budget.
   */
  refresh?: readonly PublicKey[];
  /** The vault asset's oracle accounts (none for AuthMark), passed after the refresh accounts. */
  oracleAccounts?: readonly PublicKey[];
  /** `[12]` redeemer signs: required on a Live non-bound exit unless the request stored `keeper_ok` (default true). */
  redeemerSigns?: boolean;
  /** Bound vaults: `[13] vault_lp_state`, `[14]` the vault LP portfolio (never combined with `refresh`). */
  boundLpPortfolio?: PublicKey;
}

/**
 * ExecuteRedemption v2.2 (tag 77), fully assembled. Account list: the 13 base accounts, then EITHER the bound
 * vault tail (`[13] vault_lp_state`, `[14]` vault LP; `refresh` must be empty) OR the inline refresh portfolios
 * and the oracle tail. Both pot ledgers are writable (the program tops the chosen pot up from its sibling).
 *
 * Always SIMULATE first, read the payout from the token balance change (or the 117 / 118 error) and only then send
 * with an explicit {@link COMPUTE_PRESETS_V22} `executeRedemptionRefresh` limit: a compute overrun aborts the whole
 * transaction and is NOT a program error (see {@link classifyRedemptionSimulationV22}).
 *
 * @param m             Market context.
 * @param cranker       Fee payer / signer (may equal the redeemer).
 * @param redeemer      The request's owner.
 * @param redeemerDest  Redeemer's collateral token account.
 * @param vaultToken    Market collateral vault token account.
 * @param sourceDomain  Pot to redeem from.
 * @param o             See {@link ExecuteRedemptionOptsV22}.
 * @returns Instruction.
 * @throws If the refresh list exceeds 8, is combined with a bound vault, or the leg budget cannot be checked here
 *   (the program re-checks `sum(3 + legs) <= 34`).
 * @example
 * ```ts
 * const ix = buildExecuteRedemptionIxV22(m, user, user, userAta, vaultAta, m.registryDomain, { minPayoutAtoms: floor, refresh: stale });
 * ```
 */
export function buildExecuteRedemptionIxV22(
  m: MarketV22, cranker: PublicKey, redeemer: PublicKey, redeemerDest: PublicKey, vaultToken: PublicKey, sourceDomain: number, o: ExecuteRedemptionOptsV22,
): TransactionInstruction {
  const refresh = o.refresh ?? [];
  if (refresh.length > REDEMPTION_REFRESH_MAX_V22) throw new Error(`at most ${REDEMPTION_REFRESH_MAX_V22} refresh portfolios, got ${refresh.length}`);
  if (o.boundLpPortfolio && (refresh.length !== 0 || (o.oracleAccounts?.length ?? 0) !== 0)) throw new Error("a bound vault refuses n_refresh != 0: do not pass refresh accounts with boundLpPortfolio");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const { ledger, siblingLedger } = ledgers(m);
  const base = buildAccountMetas(ACCOUNTS_EXECUTE_REDEMPTION_V22, {
    cranker, market: m.market, registry, redemption: deriveLpRedemption(m.programId, registry, redeemer)[0], lpMint: deriveInsuranceLpMint(m.programId, m.market)[0],
    escrow: deriveLpEscrow(m.programId, m.market)[0], vaultToken, vaultAuthority: deriveVaultAuthority(m.programId, m.market)[0], ledger, redeemerDest,
    tokenProgram: TOKEN_PROGRAM_ID, siblingLedger, redeemer,
  });
  base[12] = { ...base[12], isSigner: o.redeemerSigns !== false };
  const keys: AccountMeta[] = [...base];
  if (o.boundLpPortfolio) {
    keys.push(w(deriveVaultLpStateP3(m.programId, m.market)[0]), w(o.boundLpPortfolio));
  } else {
    for (const p of refresh) keys.push(w(p));
    for (const a of o.oracleAccounts ?? []) keys.push(r(a));
  }
  return ix(m.programId, keys, encodeExecuteRedemptionV22({ domain: sourceDomain, minPayoutAtoms: o.minPayoutAtoms, nRefresh: refresh.length }));
}

/** A positioned portfolio that may need an inline refresh. */
export interface RefreshCandidateV22 {
  key: PublicKey;
  /** Active legs (popcount of `active_bitmap`). */
  legs: number;
}

/** Inputs of {@link planEarnExitV22}. */
export interface EarnExitPlanInputV22 {
  market: MarketV22;
  /** Fee payer; may equal the redeemer. */
  cranker: PublicKey;
  redeemer: PublicKey;
  redeemerLpAta: PublicKey;
  redeemerDest: PublicKey;
  vaultToken: PublicKey;
  sourceDomain: number;
  shares: bigint;
  /** Positioned portfolios on the vault's asset that are stale, in priority order (liquidating first). Non-bound Live only. */
  staleCandidates?: readonly RefreshCandidateV22[];
  oracleAccounts?: readonly PublicKey[];
  /** Bound vault: the vault LP portfolio (no inline refresh on a bound vault). */
  boundLpPortfolio?: PublicKey;
  /** Request with `keeper_ok = 1`. */
  keeperOk?: boolean;
}

/** The product of {@link planEarnExitV22}. */
export interface EarnExitPlanV22 {
  /** Portfolios chosen for the inline refresh (<= 8, `sum(3 + legs) <= 34`). */
  refreshSelected: PublicKey[];
  /** Stale portfolios that did not fit: crank them with tag 5 earlier, wait for the keeper sweep, or use `keeper_ok`. */
  refreshDeferred: PublicKey[];
  /** Leg weight of the selection. */
  refreshWeight: number;
  /** A tag 77 with a floor of 1 atom for `simulateTransaction` (the payout is read from the balance change). */
  simulationIx: TransactionInstruction;
  /** Compute-unit limit to use for BOTH the simulation and the send. */
  computeUnits: number;
  /**
   * Build the final pair from the simulated payout: the floor defaults to `quote - 5 bps`
   * ({@link defaultMinPayoutV22}) and goes on BOTH the tag-76 trailer and the tag-77 wire.
   */
  finalize(quotedPayout: bigint, slippageBps?: number): { requestIx: TransactionInstruction; executeIx: TransactionInstruction; minPayoutAtoms: bigint };
}

/**
 * Plan a two-step Earn exit: choose the refresh accounts by leg weight, build the simulation instruction, and
 * return a `finalize` that turns the simulated payout into the tag-76 / tag-77 pair with the default floor.
 *
 * @param i  See {@link EarnExitPlanInputV22}.
 * @returns The plan.
 * @example
 * ```ts
 * const plan = planEarnExitV22({ market, cranker: user, redeemer: user, redeemerLpAta, redeemerDest, vaultToken, sourceDomain: market.registryDomain, shares, staleCandidates });
 * // 1. simulate plan.simulationIx with computeBudgetPrelude(plan.computeUnits); quote = balance delta
 * const { requestIx, executeIx } = plan.finalize(quote);
 * ```
 */
export function planEarnExitV22(i: EarnExitPlanInputV22): EarnExitPlanV22 {
  const bound = i.boundLpPortfolio !== undefined;
  const sel = bound ? { selected: [] as PublicKey[], deferred: [] as PublicKey[], weight: 0 } : selectRefreshPortfoliosV22((i.staleCandidates ?? []).map((c) => ({ key: c.key, legs: c.legs })));
  const exec = (minPayoutAtoms: bigint): TransactionInstruction =>
    buildExecuteRedemptionIxV22(i.market, i.cranker, i.redeemer, i.redeemerDest, i.vaultToken, i.sourceDomain, {
      minPayoutAtoms,
      refresh: sel.selected,
      oracleAccounts: sel.selected.length ? i.oracleAccounts : undefined,
      boundLpPortfolio: i.boundLpPortfolio,
    });
  return {
    refreshSelected: sel.selected,
    refreshDeferred: sel.deferred,
    refreshWeight: sel.weight,
    simulationIx: exec(1n),
    computeUnits: sel.selected.length > 0 ? COMPUTE_PRESETS_V22.executeRedemptionRefresh.units : COMPUTE_PRESETS_V22.executeRedemption.units,
    finalize(quotedPayout: bigint, slippageBps = 5) {
      const minPayoutAtoms = defaultMinPayoutV22(quotedPayout, slippageBps);
      return {
        minPayoutAtoms,
        requestIx: buildRequestRedeemLpSharesIxV22(i.market, i.redeemer, i.redeemerLpAta, i.shares, minPayoutAtoms, i.keeperOk === true),
        executeIx: exec(minPayoutAtoms),
      };
    },
  };
}

/**
 * The payout of a simulated redemption, from the redeemer's token balance before and after.
 *
 * @param before  Redeemer collateral balance before (atoms).
 * @param after   Balance in the simulated post-state.
 * @returns The payout.
 * @throws If the balance did not increase.
 * @example
 * ```ts
 * const quote = payoutFromBalancesV22(0n, 1_000_000n);
 * ```
 */
export function payoutFromBalancesV22(before: bigint, after: bigint): bigint {
  if (after <= before) throw new Error("the simulated redemption paid nothing");
  return after - before;
}

/** Classification of a simulated / failed tag 77. */
export type RedemptionSimulationKindV22 = "ok" | "belowMinPayout" | "notLossCurrent" | "computeBudgetExceeded" | "other";

/**
 * Classify a simulation result of a tag 77: 117 (floor not met: retry or lower it), 118 (book not loss-current:
 * wait for a refresh), a compute overrun (NEVER 118: it is not a program error, raise the unit limit), or other.
 *
 * @param r  `{ err, logs }` from `simulateTransaction` (`err` is the raw value or null).
 * @returns The kind and the program error code when there is one.
 * @example
 * ```ts
 * const k = classifyRedemptionSimulationV22({ err: sim.value.err, logs: sim.value.logs ?? [] });
 * ```
 */
export function classifyRedemptionSimulationV22(r: { err: unknown; logs: readonly string[] }): { kind: RedemptionSimulationKindV22; code?: number } {
  if (r.err === null || r.err === undefined) return { kind: "ok" };
  const text = r.logs.join("\n");
  if (/exceeded CUs meter|ComputationalBudgetExceeded|exceeded maximum number of instructions/i.test(text) || /ComputationalBudgetExceeded/.test(JSON.stringify(r.err))) return { kind: "computeBudgetExceeded" };
  const parsed = parseErrorFromLogs([...r.logs]);
  if (parsed?.code === 117) return { kind: "belowMinPayout", code: 117 };
  if (parsed?.code === 118) return { kind: "notLossCurrent", code: 118 };
  return parsed ? { kind: "other", code: parsed.code } : { kind: "other" };
}

// ============================================================================
// Wave B: tags 106 / 118 / 119
// ============================================================================

/**
 * SettleHoldingRent (tag 106), permissionless.
 *
 * @param m                 Market context (`lpPortfolio` required).
 * @param caller            Signer.
 * @param portfolio         Portfolio to settle (may equal the vault LP portfolio).
 * @param assetIndex        Asset slot.
 * @param nowSlot           Caller slot.
 * @param oracleAccounts    The asset's oracle accounts per its profile.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildSettleHoldingRentIxV22(m, keeper, portfolio, 0, slot, [pythFeed]);
 * ```
 */
export function buildSettleHoldingRentIxV22(m: MarketV22, caller: PublicKey, portfolio: PublicKey, assetIndex: number, nowSlot: bigint, oracleAccounts: readonly PublicKey[] = []): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 106 needs the bound vault LP portfolio (m.lpPortfolio)");
  const metas = buildAccountMetas(ACCOUNTS_SETTLE_HOLDING_RENT_V22, { caller, market: m.market, portfolio, vaultLpPortfolio: m.lpPortfolio });
  return ix(m.programId, [...metas, ...oracleAccounts.map((a) => r(a))], encodeSettleHoldingRentV22(assetIndex, nowSlot));
}

/**
 * SweepBandDustLeg (tag 118), permissionless; accounts `[caller][market w][portfolio w][bound vault LP w]`. KEEPER: leave
 * it OFF on a live market whose wrapper predates the bilateral fix.
 *
 * @param m           Market context (`lpPortfolio` required).
 * @param caller      Signer.
 * @param portfolio   The portfolio holding the dust leg.
 * @param assetIndex  Asset slot.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildSweepBandDustLegIxV22(m, keeper, portfolio, 0);
 * ```
 */
export function buildSweepBandDustLegIxV22(m: MarketV22, caller: PublicKey, portfolio: PublicKey, assetIndex: number): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 118 needs the bound vault LP portfolio (m.lpPortfolio)");
  const metas = buildAccountMetas(ACCOUNTS_SWEEP_BAND_DUST_LEG_V22, { caller, market: m.market, portfolio, vaultLpPortfolio: m.lpPortfolio });
  return ix(m.programId, metas, encodeSweepBandDustLegV22(assetIndex));
}

/**
 * EvictAndTradeCpi (tag 119): turn a built TradeCpi instruction into the evicting form by prepending the victim
 * portfolio (writable) and swapping the tag. Use it when an open on a FULL side (256 legs) fails with 111: name a
 * victim leg that is (a) at most 4x the market's minimum position size and (b) at most half the taker's size.
 *
 * @param tradeCpiIx  The complete TradeCpi instruction (tag 10).
 * @param victim      The victim's portfolio account.
 * @returns The tag-119 instruction.
 * @throws If `tradeCpiIx` is not a TradeCpi.
 * @example
 * ```ts
 * const ix = buildEvictAndTradeCpiIxV22(tradeIx, victimPortfolio);
 * ```
 */
export function buildEvictAndTradeCpiIxV22(tradeCpiIx: TransactionInstruction, victim: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: tradeCpiIx.programId,
    keys: [w(victim), ...tradeCpiIx.keys],
    data: Buffer.from(encodeEvictAndTradeCpiV22(tradeCpiIx.data)),
  });
}

// ============================================================================
// Wave C: bonds
// ============================================================================

/**
 * InitBondTranche (tag 107). `payer` pays the tranche (and the ext, when absent). The `authority` is the
 * marketauth or the wrapper upgrade authority; pass `upgradeAuthorityProgramData: true` when it is NOT the marketauth
 * (the program data account is then appended as `[8]`). Must run BEFORE the first Earn deposit, in the same
 * transaction as the vault launch ({@link buildLaunchBundleV22}).
 *
 * @param m          Market context (`vaultLpExt` required: `["vault_lp_ext", market]`).
 * @param authority  Signer.
 * @param payer      Rent payer (signer).
 * @param a          Dials.
 * @param opts       `upgradeAuthority` flag.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildInitBondTrancheIxV22(m, marketauth, marketauth, { couponBps: 800, utilBonusBps: 0, cooldownSlots: 9_000, capBps: 5_000 });
 * ```
 */
export function buildInitBondTrancheIxV22(m: MarketV22, authority: PublicKey, payer: PublicKey, a: InitBondTrancheArgs, opts: { upgradeAuthority?: boolean } = {}): TransactionInstruction {
  if (!m.vaultLpExt) throw new Error("tag 107 needs the vault LP ext PDA (m.vaultLpExt)");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const metas = buildAccountMetas(ACCOUNTS_INIT_BOND_TRANCHE_V22, {
    authority, market: m.market, registry, vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], vaultLpExt: m.vaultLpExt,
    bondTranche: deriveBondTrancheV22(m.programId, m.market)[0], payer, systemProgram: SystemProgram.programId,
  });
  if (opts.upgradeAuthority) metas.push(r(deriveProgramDataAddressP3(m.programId)[0]));
  return ix(m.programId, metas, encodeInitBondTrancheV22(a));
}

/**
 * BondDeposit (tag 108): the SPL `amount` becomes vault-LP engine capital; shares mint at par. Refused while the fee leg
 * is unharvested (bundle 78 first), the tranche is impaired (107), above the cap (123) or below `minShares` (124).
 *
 * @param m           Market context (`lpPortfolio` required).
 * @param depositor   Signer (pays the position rent on first deposit).
 * @param sourceToken Depositor's collateral token account.
 * @param vaultToken  Market collateral vault token account.
 * @param amount      Atoms.
 * @param minShares   Slippage floor.
 * @returns Instruction (13 accounts).
 * @example
 * ```ts
 * const ix = buildBondDepositIxV22(m, user, userAta, vaultAta, 1_000_000n, quote.minShares!);
 * ```
 */
export function buildBondDepositIxV22(m: MarketV22, depositor: PublicKey, sourceToken: PublicKey, vaultToken: PublicKey, amount: bigint, minShares: bigint): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 108 needs the bound vault LP portfolio (m.lpPortfolio)");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const metas = buildAccountMetas(ACCOUNTS_BOND_DEPOSIT_V22, {
    depositor, market: m.market, registry, vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio, ...ledgers(m),
    bondTranche: deriveBondTrancheV22(m.programId, m.market)[0], bondPosition: deriveBondPositionV22(m.programId, m.market, depositor)[0],
    sourceToken, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  });
  return ix(m.programId, metas, encodeBondDepositV22(amount, minShares));
}

/**
 * BondRequestWithdraw (tag 109); 0 shares cancels.
 *
 * @param m       Market context.
 * @param holder  Signer.
 * @param shares  Shares to request.
 * @returns Instruction (4 accounts).
 * @example
 * ```ts
 * const ix = buildBondRequestWithdrawIxV22(m, holder, 500n);
 * ```
 */
export function buildBondRequestWithdrawIxV22(m: Pick<MarketV22, "programId" | "market">, holder: PublicKey, shares: bigint): TransactionInstruction {
  const metas = buildAccountMetas(ACCOUNTS_BOND_REQUEST_WITHDRAW_V22, {
    holder, market: m.market, bondTranche: deriveBondTrancheV22(m.programId, m.market)[0], bondPosition: deriveBondPositionV22(m.programId, m.market, holder)[0],
  });
  return ix(m.programId, metas, encodeBondRequestWithdrawV22(shares));
}

/**
 * BondExecuteWithdraw (tag 110). Live: paid from the vault LP's capital (needs a FLAT vault LP and the OI lock);
 * Resolved: paid from `sourceDomain`'s pot.
 *
 * @param m             Market context (`lpPortfolio` required).
 * @param holder        Signer.
 * @param destToken     Holder's collateral token account.
 * @param vaultToken    Market collateral vault token account.
 * @param minOut        Slippage floor.
 * @param sourceDomain  Pot for a Resolved exit (ignored when Live).
 * @returns Instruction (13 accounts).
 * @example
 * ```ts
 * const ix = buildBondExecuteWithdrawIxV22(m, holder, holderAta, vaultAta, quote.minOut!, 0);
 * ```
 */
export function buildBondExecuteWithdrawIxV22(m: MarketV22, holder: PublicKey, destToken: PublicKey, vaultToken: PublicKey, minOut: bigint, sourceDomain: number): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 110 needs the bound vault LP portfolio (m.lpPortfolio)");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const metas = buildAccountMetas(ACCOUNTS_BOND_EXECUTE_WITHDRAW_V22, {
    holder, market: m.market, registry, vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio, ...ledgers(m),
    bondTranche: deriveBondTrancheV22(m.programId, m.market)[0], bondPosition: deriveBondPositionV22(m.programId, m.market, holder)[0],
    destToken, vaultToken, vaultAuthority: deriveVaultAuthority(m.programId, m.market)[0], tokenProgram: TOKEN_PROGRAM_ID,
  });
  return ix(m.programId, metas, encodeBondExecuteWithdrawV22(minOut, sourceDomain));
}

/**
 * Append the bond tranche to an existing-tag instruction on a BOND market (REQUIRED once the registry's bond
 * flag is set; fail closed otherwise): 78 `[9]` (writable; build 78 with the ext + a WRITABLE vault LP `[8]` first,
 * see `withCrankFeesBoundTailP2b`), 97 `[12]`, 102 (Resolved) `[11]`, 103 `[9]`.
 *
 * @param base     The instruction built WITHOUT the tranche (exact key count checked).
 * @param tranche  `["bond_tranche", market]`.
 * @returns A new instruction with the tranche appended.
 * @throws If the tag takes no bond tail or the key count is not the one the tail index expects.
 * @example
 * ```ts
 * const ix = withBondTailV22(crankFeesIxWithExt, deriveBondTrancheV22(programId, market)[0]);
 * ```
 */
export function withBondTailV22(base: TransactionInstruction, tranche: PublicKey): TransactionInstruction {
  const tag = base.data[0] as keyof typeof BOND_TAIL_INDEX_V22;
  const want = BOND_TAIL_INDEX_V22[tag];
  if (want === undefined) throw new Error(`withBondTailV22: tag ${base.data[0]} takes no bond tranche tail (only 78 / 97 / 102 Resolved / 103)`);
  if (base.keys.length !== want) throw new Error(`withBondTailV22: tag ${tag} must have exactly ${want} accounts before the tranche, got ${base.keys.length}`);
  const writable = tag === IX_TAG_EXTENDED_V22.LpVaultCrankFees;
  if (tag === IX_TAG_EXTENDED_V22.LpVaultCrankFees && base.keys[8]?.isWritable !== true) throw new Error("withBondTailV22: tag 78 on a bond market needs the vault LP at [8] WRITABLE (it is re-certified before the bonds are valued)");
  return new TransactionInstruction({ programId: base.programId, keys: [...base.keys, { pubkey: tranche, isSigner: false, isWritable: writable }], data: base.data });
}

// ============================================================================
// Wave D: G9, rescue, units, allowlist
// ============================================================================

/**
 * Append the `InsuranceUnitsV20` account to an asset-0 insurance instruction on a UNITS market (fail closed without
 * it): tags 9, 56, 57, 41, 101. The program finds it by its PDA anywhere after the base accounts, so it is appended
 * LAST (after the optional insurance ledger).
 *
 * @param base   The instruction (tag 9 / 56 / 57 / 41 / 101).
 * @param units  `["ins_units", market]`.
 * @returns A new instruction with the writable units account appended.
 * @throws If the tag does not take it, the account is already present, or the base is shorter than the tag's minimum.
 * @example
 * ```ts
 * const ix = withInsuranceUnitsTailV22(topUpIx, deriveInsuranceUnitsV22(programId, market)[0]);
 * ```
 */
export function withInsuranceUnitsTailV22(base: TransactionInstruction, units: PublicKey): TransactionInstruction {
  const tag = base.data[0] as keyof typeof INSURANCE_UNITS_TAIL_FROM_V22;
  const from = INSURANCE_UNITS_TAIL_FROM_V22[tag];
  if (from === undefined) throw new Error(`withInsuranceUnitsTailV22: tag ${base.data[0]} takes no insurance-units account (only 9 / 56 / 57 / 41 / 101)`);
  if (base.keys.length < from) throw new Error(`withInsuranceUnitsTailV22: tag ${tag} needs at least ${from} accounts before the units account, got ${base.keys.length}`);
  if (base.keys.some((k) => k.pubkey.equals(units))) throw new Error("withInsuranceUnitsTailV22: the units account is already present");
  return new TransactionInstruction({ programId: base.programId, keys: [...base.keys, w(units)], data: base.data });
}

/**
 * InsuranceBackstopDraw (tag 111, G9), permissionless. `tail` carries what the program searches for in `[7..]`: the units
 * account is appended automatically; pass any Hybrid-leg feed accounts and the allowlist for modes 0 and 2 on a mainnet
 * build via `extraTail`.
 *
 * @param m           Market context (`lpPortfolio` required).
 * @param cranker     Signer.
 * @param mode        0 DRAW, 1 RESTORE, 2 PROPOSE.
 * @param maxAmount   Cap in atoms.
 * @param extraTail   Leg feed accounts and `["g9_feeds"]` (read-only).
 * @returns Instruction.
 * @example
 * ```ts
 * const propose = buildInsuranceBackstopDrawIxV22(m, keeper, 2, 0n, legFeeds);
 * ```
 */
export function buildInsuranceBackstopDrawIxV22(m: MarketV22, cranker: PublicKey, mode: 0 | 1 | 2, maxAmount: bigint, extraTail: readonly PublicKey[] = []): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 111 needs the bound vault LP portfolio (m.lpPortfolio)");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const metas = buildAccountMetas(ACCOUNTS_INSURANCE_BACKSTOP_DRAW_V22, {
    cranker, market: m.market, registry, vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio, ...ledgers(m),
  });
  metas.push(w(deriveInsuranceUnitsV22(m.programId, m.market)[0]));
  for (const a of extraTail) metas.push(r(a));
  return ix(m.programId, metas, encodeInsuranceBackstopDrawV22(mode, maxAmount));
}

/**
 * RescueDeposit (tag 112): buy senior shares at the certified IMPAIRED value. Accounts as tag 75; bound vaults append
 * `[11] vault_lp_state` and `[12]` the vault LP portfolio. Only tranche 0 is accepted on chain today.
 *
 * @param m             Market context (`lpPortfolio` for a bound vault).
 * @param rescuer       Signer.
 * @param rescuerLpAta  Rescuer's LP-share token account.
 * @param sourceToken   Rescuer's collateral token account.
 * @param vaultToken    Market collateral vault token account.
 * @param amount        Atoms.
 * @param minShares     Slippage floor.
 * @param tranche       0 = senior.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildRescueDepositIxV22(m, user, userLpAta, userAta, vaultAta, 100_000_000n, quote.minShares!);
 * ```
 */
export function buildRescueDepositIxV22(m: MarketV22, rescuer: PublicKey, rescuerLpAta: PublicKey, sourceToken: PublicKey, vaultToken: PublicKey, amount: bigint, minShares: bigint, tranche = 0): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const { ledger, siblingLedger } = ledgers(m);
  const metas = buildAccountMetas(ACCOUNTS_RESCUE_DEPOSIT_V22, {
    rescuer, market: m.market, registry, lpMint: deriveInsuranceLpMint(m.programId, m.market)[0], rescuerLpAta, sourceToken, vaultToken, ledger,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, siblingLedger,
  });
  if (m.lpPortfolio) metas.push(w(deriveVaultLpStateP3(m.programId, m.market)[0]), w(m.lpPortfolio));
  return ix(m.programId, metas, encodeRescueDepositV22(tranche, amount, minShares));
}

/**
 * InitInsuranceUnits (tag 116), permissionless: creates the units ledger on first use, refreshes its snapshot afterwards
 * (the stake program CPIs this before pricing).
 *
 * @param m      Market context.
 * @param payer  Signer.
 * @returns Instruction (4 accounts).
 * @example
 * ```ts
 * const ix = buildInitInsuranceUnitsIxV22(m, payer);
 * ```
 */
export function buildInitInsuranceUnitsIxV22(m: Pick<MarketV22, "programId" | "market">, payer: PublicKey): TransactionInstruction {
  const metas = buildAccountMetas(ACCOUNTS_INIT_INSURANCE_UNITS_V22, { payer, market: m.market, insuranceUnits: deriveInsuranceUnitsV22(m.programId, m.market)[0], systemProgram: SystemProgram.programId });
  return ix(m.programId, metas, encodeInitInsuranceUnitsV22());
}

/**
 * SetG9FeedAllowlist (tag 117), upgrade authority only.
 *
 * @param programId         Wrapper program id.
 * @param upgradeAuthority  Signer (pays the rent on first use).
 * @param keys              Switchboard feed keys (<= 16).
 * @returns Instruction (4 accounts).
 * @example
 * ```ts
 * const ix = buildSetG9FeedAllowlistIxV22(programId, authority, [feedA]);
 * ```
 */
export function buildSetG9FeedAllowlistIxV22(programId: PublicKey, upgradeAuthority: PublicKey, keys: readonly PublicKey[]): TransactionInstruction {
  const metas = buildAccountMetas(ACCOUNTS_SET_G9_FEED_ALLOWLIST_V22, {
    upgradeAuthority, programData: deriveProgramDataAddressP3(programId)[0], g9FeedAllowlist: deriveG9FeedAllowlistV22(programId)[0], systemProgram: SystemProgram.programId,
  });
  return ix(programId, metas, encodeSetG9FeedAllowlistV22(keys));
}

// ============================================================================
// Atomic launch bundle: 74 CreateLpVault + 94 InitVaultLp + 107 InitBondTranche
// ============================================================================

/** Thrown when the launch bundle cannot be sent as ONE transaction. Splitting it reopens the N-2 front-run. */
export class LaunchBundleTooLargeError extends Error {
  readonly bytes: number | null;
  readonly limit: number;
  constructor(bytes: number | null, limit: number) {
    super(`launch bundle is ${bytes === null ? "too large to serialize" : `${bytes} bytes`}, over the ${limit}-byte limit of the selected format. It must NOT be split: a minimum-size Earn deposit between the steps disables bonds for good (N-2). Use a v1 transaction or reduce accounts.`);
    this.name = "LaunchBundleTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** One Earn seed deposit (tag 75) placed after the tranche exists. */
export interface EarnSeedV22 {
  /** Depositor (signer). */
  depositor: PublicKey;
  /** Depositor's collateral token account. */
  sourceToken: PublicKey;
  /** Market collateral vault token account. */
  vaultToken: PublicKey;
  /** Collateral atoms (u128 on the wire). */
  amount: bigint;
  /** Pot the deposit is routed to (default 0). */
  domain?: number;
  /** Depositor's LP-share ATA (default: the associated token account of the LP mint). */
  depositorLpAta?: PublicKey;
}

/** Inputs of {@link buildLaunchBundleV22}. */
export interface LaunchBundleInputV22 {
  /** Fee payer. */
  payer: PublicKey;
  /** Market context (`lpPortfolio` required: tag 75 on a BOUND vault takes `[11] vault_lp_state`, `[12]` the vault LP). */
  market: MarketV22;
  /**
   * `SystemProgram.createAccount` instructions (the matcher context, 320 B; the vault-LP portfolio at EXACTLY
   * `portfolio.accountLen`), placed between 74 and 94 (the order the real wrapper accepts). They sign with their new keypairs.
   */
  createAccounts: readonly TransactionInstruction[];
  /** Tag 74 CreateLpVault. */
  createVaultLp: TransactionInstruction;
  /** Tag 94 InitVaultLp. */
  initVaultLp: TransactionInstruction;
  /** Tag 107 InitBondTranche. */
  initBondTranche: TransactionInstruction;
  /** Earn seed deposits (tag 75), AFTER 107, each with its LP ATA created idempotently first. */
  earnSeeds?: readonly EarnSeedV22[];
  /** Cluster supports v1 transactions (`detectTxV1Support`). */
  supportsV1: boolean;
  /** Compute-unit limit (default {@link COMPUTE_PRESETS_V22} `launchBundle`). */
  computeUnits?: number;
  priorityMicroLamportsPerCu?: number;
}

/** A planned launch transaction. */
export interface LaunchBundlePlanV22 {
  /** `v1` when supported and it fits, else `legacy`. */
  format: TxFormat;
  /** Payload instructions in order (no ComputeBudget; add {@link computeBudgetPrelude} for legacy). */
  instructions: TransactionInstruction[];
  /** Exact serialized size in the chosen format, with the budget and every required signature. */
  bytes: number;
  /** The limit it was checked against (4096 for v1, 1232 for legacy). */
  limit: number;
  /** Budget to use. */
  budget: BudgetParams;
}

/**
 * Tag 75 DepositToLpVault on a BOUND vault, fully assembled: the 11 base accounts plus the REQUIRED tail `[11] vault_lp_state (w)`
 * and `[12]` the vault LP portfolio (w); both pot ledgers writable.
 *
 * @param m          Market context (`lpPortfolio` required).
 * @param depositor  Signer.
 * @param lpAta      Depositor's LP-share token account.
 * @param sourceToken  Depositor's collateral token account.
 * @param vaultToken   Market collateral vault token account.
 * @param amount     Atoms.
 * @param domain     Pot (default 0).
 * @returns Instruction (13 accounts).
 * @example
 * ```ts
 * const ix = buildDepositToLpVaultIxBoundV22(m, user, lpAta, userAta, vaultAta, 1_000_000n);
 * ```
 */
export function buildDepositToLpVaultIxBoundV22(m: MarketV22, depositor: PublicKey, lpAta: PublicKey, sourceToken: PublicKey, vaultToken: PublicKey, amount: bigint, domain = 0): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 75 on a bound vault needs the vault LP portfolio (m.lpPortfolio)");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const metas = buildAccountMetas(ACCOUNTS_LP_VAULT_DEPOSIT, {
    depositor, market: m.market, registry, lpMint: deriveInsuranceLpMint(m.programId, m.market)[0], depositorLpAta: lpAta, sourceToken, vaultToken,
    ledger: ledgers(m).ledger, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, siblingLedger: ledgers(m).siblingLedger,
  });
  const base = new TransactionInstruction({ programId: m.programId, keys: metas, data: Buffer.from(encodeDepositToLpVault({ amount, domain })) });
  return withBoundVaultLpTailP3(base, deriveVaultLpStateP3(m.programId, m.market)[0], m.lpPortfolio);
}

/**
 * Plan the FULL bond launch as ONE transaction, in the order proven against the real variant-B wrapper:
 * `74 CreateLpVault, createAccounts..., 94 InitVaultLp, 107 InitBondTranche, then for each seed [create LP ATA (idempotent), 75 with the bound tail]`.
 * Prefers a v1 transaction (4,096 B) when supported, else legacy (1,232 B). NEVER splits: a minimum-size Earn deposit between
 * steps makes 107 refuse forever (N-2). A Squads launch must wrap the whole bundle in ONE vault transaction.
 *
 * @param i  See {@link LaunchBundleInputV22}.
 * @returns The plan.
 * @throws {@link LaunchBundleTooLargeError} when it does not fit; a plain `Error` on a wrong tag or order.
 * @example
 * ```ts
 * const plan = buildLaunchBundleV22({ payer, market, createAccounts: [ctxIx, lpPortfolioIx], createVaultLp, initVaultLp, initBondTranche, earnSeeds: [seed], supportsV1: false });
 * ```
 */
export function buildLaunchBundleV22(i: LaunchBundleInputV22): LaunchBundlePlanV22 {
  const expect: [string, TransactionInstruction, number][] = [["createVaultLp", i.createVaultLp, 74], ["initVaultLp", i.initVaultLp, 94], ["initBondTranche", i.initBondTranche, IX_TAG_V22.InitBondTranche]];
  for (const [name, x, tag] of expect) {
    if (x.data[0] !== tag) throw new Error(`buildLaunchBundleV22: ${name} must be tag ${tag}, got ${x.data[0]}`);
  }
  const lpMint = deriveInsuranceLpMint(i.market.programId, i.market.market)[0];
  const seedIxs: TransactionInstruction[] = [];
  for (const sd of i.earnSeeds ?? []) {
    const ata = sd.depositorLpAta ?? getAssociatedTokenAddressSync(lpMint, sd.depositor, true);
    seedIxs.push(createAssociatedTokenAccountIdempotentInstruction(i.payer, ata, sd.depositor, lpMint));
    seedIxs.push(buildDepositToLpVaultIxBoundV22(i.market, sd.depositor, ata, sd.sourceToken, sd.vaultToken, sd.amount, sd.domain ?? 0));
  }
  const instructions = [i.createVaultLp, ...i.createAccounts, i.initVaultLp, i.initBondTranche, ...seedIxs];
  const budget: BudgetParams = { computeUnitLimit: i.computeUnits ?? COMPUTE_PRESETS_V22.launchBundle.units, heapBytes: V17_WRAPPER_HEAP_FRAME_BYTES, priorityMicroLamportsPerCu: i.priorityMicroLamportsPerCu };
  if (i.supportsV1) {
    try {
      const bytes = measureTxBytes("v1", i.payer, instructions, budget);
      if (bytes <= TX_V1_MAX_BYTES) return { format: "v1", instructions, bytes, limit: TX_V1_MAX_BYTES, budget };
    } catch {
      // fall through to legacy
    }
  }
  let bytes: number;
  try {
    bytes = measureTxBytes("legacy", i.payer, instructions, budget);
  } catch {
    throw new LaunchBundleTooLargeError(null, TX_LEGACY_MAX_BYTES);
  }
  if (bytes > TX_LEGACY_MAX_BYTES) throw new LaunchBundleTooLargeError(bytes, TX_LEGACY_MAX_BYTES);
  return { format: "legacy", instructions, bytes, limit: TX_LEGACY_MAX_BYTES, budget };
}

/**
 * `SystemProgram.createAccount` for the vault-LP portfolio that tag 94 expects pre-created: program-owned,
 * `portfolio.accountLen` bytes of the chosen layout (10,091 on the provisional v2.2 table).
 *
 * @param payer       Funds the rent.
 * @param portfolio   New account (fresh keypair; it must sign).
 * @param lamports    `getMinimumBalanceForRentExemption(layout.portfolio.accountLen)`.
 * @param programId   The wrapper program id.
 * @param layout      Layout table (default {@link LAYOUT_V22}).
 * @returns The createAccount instruction.
 * @example
 * ```ts
 * const ix = buildCreateLpPortfolioIxV22(payer, lpKp.publicKey, lamports, programId);
 * ```
 */
export function buildCreateLpPortfolioIxV22(payer: PublicKey, portfolio: PublicKey, lamports: number, programId: PublicKey, layout: LayoutTable = LAYOUT_V22): TransactionInstruction {
  return SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: portfolio, lamports, space: layout.portfolio.accountLen, programId });
}

/**
 * `SystemProgram.createAccount` for ANY v2.2 portfolio (trader or vault LP): a TOP-LEVEL system instruction of EXACTLY
 * `layout.portfolio.accountLen` bytes, owned by the wrapper. The program cannot realloc past 10,240 B, so every client
 * must create portfolios at the exact length (10,603 on variant B, 10,091 on stage A); a wrong length fails.
 *
 * @param payer      Funds the rent.
 * @param portfolio  New account (fresh keypair; it must sign).
 * @param lamports   `getMinimumBalanceForRentExemption(layout.portfolio.accountLen)`.
 * @param programId  The wrapper program id.
 * @param layout     Layout row (default {@link LAYOUT_V22}).
 * @returns The createAccount instruction.
 * @example
 * ```ts
 * const ix = buildCreatePortfolioAccountIxV22(payer, kp.publicKey, await conn.getMinimumBalanceForRentExemption(portfolioAccountLenV22()), programId);
 * ```
 */
export function buildCreatePortfolioAccountIxV22(payer: PublicKey, portfolio: PublicKey, lamports: number, programId: PublicKey, layout: LayoutTable = LAYOUT_V22): TransactionInstruction {
  return SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: portfolio, lamports, space: layout.portfolio.accountLen, programId });
}

/**
 * The exact portfolio account length of a layout row.
 *
 * @param layout  Layout row (default {@link LAYOUT_V22}).
 * @returns `PORTFOLIO_ACCOUNT_LEN`.
 * @example
 * ```ts
 * portfolioAccountLenV22(); // 10603 on variant B
 * ```
 */
export function portfolioAccountLenV22(layout: LayoutTable = LAYOUT_V22): number {
  return layout.portfolio.accountLen;
}

// ============================================================================
// Tails on EXISTING tags: one table + builders for 78 (bound) and 97
// ============================================================================

/**
 * EVERY account tail the v2.2 programs read on an existing tag, in one table (index = position in the account list).
 * `bond` columns apply once the registry's bond flag is set (REQUIRED then, fail closed); `ext` once the vault-LP ext exists.
 *
 * | tag | base | bound-vault tail | ext | bond tranche | units |
 * |---|---|---|---|---|---|
 * | 75 DepositToLpVault | 11 | `[11]` vault_lp_state w, `[12]` vault LP w | - | - | - |
 * | 77 ExecuteRedemption | 13 | bound: `[13]` state w, `[14]` LP w; NON-bound: `[13..13+n]` refresh w, then oracles | - | - | - |
 * | 78 LpVaultCrankFees | 6 | `[6]` vault_lp_state w | `[7]` ext w, `[8]` vault LP **w** | `[9]` tranche w | - |
 * | 97 WithdrawJuniorTranche | 11 | - | `[11]` ext w | `[12]` tranche | - |
 * | 98 VaultLpRecall | 8 | - | `[8]` ext w | - | - |
 * | 102 VaultLpReleaseSurplus (Resolved) | 7 + 4 | - | - | `[11]` tranche | - |
 * | 103 VaultLpAllocate | 9 | - | `[7]` ext (base) | `[9]` tranche | - |
 * | 9, 56 top-ups | 5 (+ optional ledger `[5]`) | - | - | - | units LAST |
 * | 57, 41 withdraws | 6 | - | - | - | units LAST |
 * | 101 VaultLpSettleResolved | 12 | - | - | - | units LAST |
 * | 111 InsuranceBackstopDraw | 7 | - | - | - | units in `[7..]` (+ G9 legs / allowlist) |
 * | 112 RescueDeposit | 11 | `[11]` state w, `[12]` LP w | - | - | - |
 *
 * The same numbers are enforced by {@link withBondTailV22}, {@link withInsuranceUnitsTailV22} and
 * `withBoundVaultLpTailP3`; `test/v22-builders.test.ts` pins the table.
 */
export const ACCOUNT_TAILS_V22 = Object.freeze({
  75: { base: 11, boundState: 11, boundLp: 12 },
  77: { base: 13, boundState: 13, boundLp: 14, refreshStart: 13 },
  78: { base: 6, boundState: 6, ext: 7, boundLp: 8, bondTranche: 9 },
  97: { base: 11, ext: 11, bondTranche: 12 },
  98: { base: 8, ext: 8 },
  102: { base: 7, resolvedBase: 11, bondTranche: 11 },
  103: { base: 9, ext: 7, bondTranche: 9 },
  112: { base: 11, boundState: 11, boundLp: 12 },
  units: { 9: 5, 56: 5, 57: 6, 41: 6, 101: 12 },
} as const);

/**
 * LpVaultCrankFees (tag 78) on a BOUND vault, fully assembled: 6 base accounts, `[6]` vault_lp_state, and, when the ext
 * exists (`m.vaultLpExt`), `[7]` ext, `[8]` the vault LP portfolio (WRITABLE) and, on a bond market (`bond: true`), `[9]` the
 * bond tranche. Bundle a vault-LP refresh crank before it on a bond market (78 re-certifies the LP before valuing the bonds).
 *
 * @param m        Market context (`lpPortfolio` required; `vaultLpExt` once the ext exists).
 * @param cranker  Signer.
 * @param domain   Pot receiving the fees.
 * @param opts     `bond`: the registry's bond flag is set.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildLpVaultCrankFeesIxBoundV22(m, keeper, 0, { bond: true });
 * ```
 */
export function buildLpVaultCrankFeesIxBoundV22(m: MarketV22, cranker: PublicKey, domain: number, opts: { bond?: boolean } = {}): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 78 on a bound vault needs the vault LP portfolio (m.lpPortfolio)");
  if (opts.bond && !m.vaultLpExt) throw new Error("a bond market always has the vault LP ext: set m.vaultLpExt");
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const { ledger, siblingLedger } = ledgers(m);
  const base = new TransactionInstruction({
    programId: m.programId,
    data: Buffer.from(encodeLpVaultCrankFees({ domain })),
    keys: [w(cranker, true), w(m.market), w(registry), w(ledger), w(siblingLedger), r(SystemProgram.programId)],
  });
  const withState = withBoundVaultLpTailP3(base, deriveVaultLpStateP3(m.programId, m.market)[0], m.lpPortfolio, { vaultLpExt: m.vaultLpExt });
  return opts.bond ? withBondTailV22(withState, deriveBondTrancheV22(m.programId, m.market)[0]) : withState;
}

/**
 * WithdrawJuniorTranche (tag 97), fully assembled: 11 base accounts, `[11]` ext when it exists, and on a bond market `[12]` the
 * bond tranche (the junior can never withdraw bond value).
 *
 * @param m            Market context (`lpPortfolio` required; `vaultLpExt` once the ext exists, required with `bond`).
 * @param juniorOwner  Signer.
 * @param destToken    Junior's collateral token account.
 * @param vaultToken   Market collateral vault token account.
 * @param amount       Atoms.
 * @param opts         `bond`: the registry's bond flag is set.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildWithdrawJuniorTrancheIxV22(m, junior, juniorAta, vaultAta, 1_000n, { bond: true });
 * ```
 */
export function buildWithdrawJuniorTrancheIxV22(m: MarketV22, juniorOwner: PublicKey, destToken: PublicKey, vaultToken: PublicKey, amount: bigint, opts: { bond?: boolean } = {}): TransactionInstruction {
  if (!m.lpPortfolio) throw new Error("tag 97 needs the vault LP portfolio (m.lpPortfolio)");
  if (opts.bond && !m.vaultLpExt) throw new Error("a bond market always has the vault LP ext: set m.vaultLpExt");
  const base = buildWithdrawJuniorTrancheIxP3({ programId: m.programId, market: m.market, registryDomain: m.registryDomain, lpPortfolio: m.lpPortfolio, vaultLpExt: m.vaultLpExt }, juniorOwner, destToken, vaultToken, amount);
  return opts.bond ? withBondTailV22(base, deriveBondTrancheV22(m.programId, m.market)[0]) : base;
}
