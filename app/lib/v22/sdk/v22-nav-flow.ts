/*
 * LOCAL ADAPTER PORT, not original code: from percolator-sdk fix/v22-636-flow-accounts-302-portfolio @ f86dcfd (dcccrypto/percolator-sdk#437,
 * sdk 9.0.0-candidate), src/solana/v22-nav-flow.ts. The imports are retargeted (sibling lev-guard / records ports). ONE local adaptation:
 * the vendored records/p2b-earn `buildVaultLpAllocateIxP2b` (ecb6215) has no `bondTranche` option, so `buildVaultLpAllocateIxV22` appends
 * the tranche at [9] itself (read-only, exactly what the SDK's ACCOUNTS_VAULT_LP_ALLOCATE_BOND_P2B does).
 * Delete when @percolatorct/sdk >= 9.0.0 ships. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * #636 / #636b (percolator-prog PRs #640 + #641, merged together into rc23 as ONE ABI change): the LP-stop NAV is
 * sampled AT every flow that moves vault-LP value, so the flow handlers now take the market's leverage guard
 * (`["lev_guard", market]`) and the vault-LP ext (`["vault_lp_ext", market]`) as trailing accounts.
 *
 * Both are REQUIRED and PDA-checked on a growth market (`asset_growth_view(asset).is_some()`): a missing guard, or
 * another account in its slot, is refused with Custom(134) `LevGuardInvalid`; a missing ext (once the guard is live)
 * with `VaultLpNotBound`. On a non-growth market, or while the guard PDA is not yet initialised, the program skips
 * the sample, so appending them ALWAYS is correct and needs no growth probe (the builders below always do).
 *
 * Exact tails, read from the handlers at percolator-prog 780013c8 (`src/v16_program.rs`; `lev_nav_flow_begin` /
 * `lev_nav_flow_end` / `lev_flow_counters`):
 *
 * | tag | handler | pre-#640 list | new tail (w = writable) |
 * |---|---|---|---|
 * | 96 DepositJuniorTranche | `lev_nav_flow_begin(.., 7, 8, ..)` | 7 | `[7]` guard w, `[8]` ext w |
 * | 97 WithdrawJuniorTranche | `(.., 13, 11, ..)` | 11 (+`[11]` ext, +`[12]` bond tranche) | `[11]` ext w (now always), `[12]` bond tranche or a pad, `[13]` guard w |
 * | 98 VaultLpRecall | `(.., 9, 8, ..)` | 8 (+`[8]` ext) | `[8]` ext w (now always), `[9]` guard w |
 * | 102 VaultLpReleaseSurplus, Live | `(.., 13, 12, ..)` | 7 | `[7..11]` pads, `[12]` ext w, `[13]` guard w (Resolved: unchanged, not read) |
 * | 103 VaultLpAllocate | `(.., 10, 7, ..)` | 9 (+`[9]` bond tranche) | `[9]` bond tranche or a pad, `[10]` guard w |
 * | 108 BondDeposit | `(.., 14, 13, ..)` | 13 | `[13]` ext w, `[14]` guard w |
 * | 110 BondExecuteWithdraw | `(.., 14, 13, ..)` | 13 | `[13]` ext w, `[14]` guard w (Live; Resolved does not read them) |
 * | 111 InsuranceBackstopDraw, modes 0/1/3 | `lev_find_idx(accounts, 7, pda)` | 7 + units + feeds | ext w and guard w anywhere in `[7..]` (found by key); mode 2 unchanged |
 *
 * Writability: the guard is `expect_writable` whenever it is live (the sample is stored into it); the ext is written by
 * 98 / 103 (allocation counter) and by 102 / 108 / 110 / 111 (the #641 `other_flow` counters), and is passed writable
 * everywhere for one rule. A pad is the system program, read-only (what the program's own tests pass).
 *
 * @module v22-nav-flow
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { deriveLevGuardV22 } from "./lev-guard-v22";
import { deriveVaultLpExtP2b, buildVaultLpAllocateIxP2b } from "./records/p2b-earn";
import { deriveBondTrancheV22 } from "./v22-wire";
import { buildDepositJuniorTrancheIxP3, buildVaultLpRecallIxP3, buildVaultLpReleaseSurplusIxP3 } from "./records/p3-vault-lp";

/** The subset of the v2.2 market context the flow tails need (structurally `MarketV22`). */
export interface NavFlowMarketV22 {
  /** v2.2 wrapper program id. */
  programId: PublicKey;
  market: PublicKey;
  /** `LpVaultRegistryV16.domain`: selects the own / sibling backing ledger. */
  registryDomain: number;
  /** The vault-owned LP portfolio. */
  lpPortfolio?: PublicKey;
  /** Ignored by the flow tails: the ext PDA is always derived (it is required at its PDA on a growth market). */
  vaultLpExt?: PublicKey;
}

/**
 * Account positions of the #636 / #636b flow tails (index = position in the account list). `base` is the account count
 * a caller built before #640; `full` the count after. `bondSlot`: the bond tranche on a bond market, else a pad.
 * Tag 111 has no fixed slots (`byKey`: the program searches `[7..]` by PDA).
 */
export const NAV_FLOW_TAILS_V22 = Object.freeze({
  96: Object.freeze({ base: 7, guard: 7, ext: 8, full: 9 }),
  97: Object.freeze({ base: 11, ext: 11, bondSlot: 12, guard: 13, full: 14 }),
  98: Object.freeze({ base: 8, ext: 8, guard: 9, full: 10 }),
  102: Object.freeze({ base: 7, pads: Object.freeze([7, 8, 9, 10, 11] as const), ext: 12, guard: 13, full: 14, resolvedBase: 11 }),
  103: Object.freeze({ base: 9, ext: 7, bondSlot: 9, guard: 10, full: 11 }),
  108: Object.freeze({ base: 13, ext: 13, guard: 14, full: 15 }),
  110: Object.freeze({ base: 13, ext: 13, guard: 14, full: 15 }),
  111: Object.freeze({ base: 7, byKey: true as const, modes: Object.freeze([0, 1, 3] as const) }),
} as const);

/** A tag that takes the #636 flow tail. */
export type NavFlowTagV22 = 96 | 97 | 98 | 102 | 103 | 108 | 110 | 111;

/** One compute-unit limit for a flow tag, with the measured numbers it is sized from. */
export interface NavFlowComputeV22 {
  /** Compute-unit limit to request (always explicit: never rely on the 200k default). */
  units: number;
  /** Highest consumption measured with the #640 / #641 binaries (LiteSVM, real BPF), in CU. */
  measuredWorst: number;
  /** Where the measurement comes from and why the limit has the headroom it has. */
  note: string;
}

/**
 * Compute-unit limits for the flow tags after #640 / #641. Every number is at least 2x the worst measured case.
 * Measurements: prog PR #640 body (author, LiteSVM, rc23 tip -> PR), the independent attack `att-640`
 * (bond world, CUREC), PR #641 body; tag 103 also has a devnet reading (~230k on the pre-#640 wrapper, SDK
 * `buildVaultLpAllocateIxP2b` doc) to which the measured +45k of the flow sample is added. The LiteSVM worlds hold
 * 1-2 vault-LP legs; the vault-LP certificate refresh grows with legs, hence the 2x floor.
 */
export const NAV_FLOW_COMPUTE_UNITS_V22: Readonly<Record<NavFlowTagV22, NavFlowComputeV22>> = Object.freeze({
  96: { units: 250_000, measuredWorst: 101_000, note: "rc23 53k -> 59-62k, 89-101k on the bond path (att-640). 2.5x of 101k." },
  97: { units: 300_000, measuredWorst: 131_000, note: "rc23 98k -> 131k (att-640). 2.3x." },
  98: { units: 400_000, measuredWorst: 176_000, note: "rc23 131k -> 176k (PR #640), 132-135k (att-640). 2.3x of 176k." },
  102: { units: 300_000, measuredWorst: 131_000, note: "Live: 81k -> 131k (PR #641). 2.3x." },
  103: { units: 600_000, measuredWorst: 207_000, note: "162k -> 207k (PR #640 worst, above the 200k default), 145-148k (att-640); devnet ~230k before #640 + 45k = ~275k. 600k = 2.2x of 275k, the keeper's P2B_ALLOCATE_CU." },
  108: { units: 600_000, measuredWorst: 185_000, note: "86k -> 121-130k, 185k on one deposit path (PR #641). Kept at the 600k bondDeposit preset (3.2x)." },
  110: { units: 600_000, measuredWorst: 129_000, note: "86k -> 129k (PR #641). Kept at the 600k bondExecuteWithdraw preset." },
  111: { units: 600_000, measuredWorst: 150_000, note: "RESTORE 83k -> 144-150k (PR #641); DRAW on a growth market not measured. Kept at the 600k insuranceBackstopDraw preset." },
});

/**
 * The two PDAs every flow tail carries.
 *
 * @param programId  v2.2 wrapper program id.
 * @param market     Market account.
 * @returns `{ guard: ["lev_guard", market], ext: ["vault_lp_ext", market] }`.
 * @example
 * ```ts
 * const { guard, ext } = navFlowAccountsV22(PROGRAM_ID, market);
 * ```
 */
export function navFlowAccountsV22(programId: PublicKey, market: PublicKey): { guard: PublicKey; ext: PublicKey } {
  return { guard: deriveLevGuardV22(programId, market)[0], ext: deriveVaultLpExtP2b(programId, market)[0] };
}

const wm = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const pad = (): AccountMeta => ({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });

function expectKey(keys: readonly AccountMeta[], i: number, want: PublicKey, tag: number, what: string): void {
  const k = keys[i];
  if (!k || !k.pubkey.equals(want)) throw new Error(`withNavFlowTailV22: tag ${tag} needs the ${what} at [${i}], found ${k ? k.pubkey.toBase58() : "nothing"}`);
}

/**
 * Bring a flow-tag instruction to its #640 / #641 account list. Accepts the pre-#640 forms the existing builders
 * produce (see {@link NAV_FLOW_TAILS_V22} `base`, plus the optional ext / bond slots) and returns the full list:
 * fills the ext (derived, writable) where it was optional, pads an absent bond-tranche slot, appends the guard
 * (writable). Idempotent: an instruction that already carries the full tail is returned unchanged. Tag 102 in its
 * Resolved form (11 / 12 accounts) and tag 111 mode 2 (PROPOSE) are returned unchanged (the program does not read
 * the tail there).
 *
 * @param base       The instruction (tag byte first; program id must be the v2.2 wrapper).
 * @param market     Market account (the PDAs are derived from `base.programId` and it).
 * @returns A new instruction with the tail.
 * @throws If the tag takes no flow tail, the account count is not one of the known forms, or a slot that must hold
 *   the ext / guard holds another key.
 * @example
 * ```ts
 * const ix = withNavFlowTailV22(buildVaultLpAllocateIxP2b(m, keeper, U128_MAX_P2B, { bondTranche: bond }), m.market);
 * ```
 */
export function withNavFlowTailV22(base: TransactionInstruction, market: PublicKey): TransactionInstruction {
  const tag = base.data[0];
  const { guard, ext } = navFlowAccountsV22(base.programId, market);
  const keys = [...base.keys];
  const n = keys.length;
  const done = (): TransactionInstruction => new TransactionInstruction({ programId: base.programId, keys, data: base.data });
  switch (tag) {
    case 96: {
      const t = NAV_FLOW_TAILS_V22[96];
      if (n === t.full) { expectKey(keys, t.guard, guard, tag, "lev guard"); expectKey(keys, t.ext, ext, tag, "vault ext"); return done(); }
      if (n !== t.base) throw new Error(`withNavFlowTailV22: tag 96 must have ${t.base} (or ${t.full}) accounts, got ${n}`);
      keys.push(wm(guard), wm(ext));
      return done();
    }
    case 97: {
      const t = NAV_FLOW_TAILS_V22[97];
      if (n === t.full) { expectKey(keys, t.ext, ext, tag, "vault ext"); expectKey(keys, t.guard, guard, tag, "lev guard"); return done(); }
      if (n < t.base || n > t.base + 2) throw new Error(`withNavFlowTailV22: tag 97 must have ${t.base}..${t.base + 2} (or ${t.full}) accounts, got ${n}`);
      if (n === t.base) keys.push(wm(ext)); else { expectKey(keys, t.ext, ext, tag, "vault ext"); keys[t.ext] = wm(ext); }
      if (keys.length === t.bondSlot) keys.push(pad());
      keys.push(wm(guard));
      return done();
    }
    case 98: {
      const t = NAV_FLOW_TAILS_V22[98];
      if (n === t.full) { expectKey(keys, t.ext, ext, tag, "vault ext"); expectKey(keys, t.guard, guard, tag, "lev guard"); return done(); }
      if (n !== t.base && n !== t.base + 1) throw new Error(`withNavFlowTailV22: tag 98 must have ${t.base} or ${t.base + 1} (or ${t.full}) accounts, got ${n}`);
      if (n === t.base) keys.push(wm(ext)); else { expectKey(keys, t.ext, ext, tag, "vault ext"); keys[t.ext] = wm(ext); }
      keys.push(wm(guard));
      return done();
    }
    case 102: {
      const t = NAV_FLOW_TAILS_V22[102];
      if (n === t.resolvedBase || n === t.resolvedBase + 1) return done(); // Resolved: SPL tail (+ bond tranche), no sample
      if (n === t.full) { expectKey(keys, t.ext, ext, tag, "vault ext"); expectKey(keys, t.guard, guard, tag, "lev guard"); return done(); }
      if (n !== t.base) throw new Error(`withNavFlowTailV22: tag 102 Live must have ${t.base} (or ${t.full}) accounts, Resolved ${t.resolvedBase} or ${t.resolvedBase + 1}; got ${n}`);
      for (let i = 0; i < t.pads.length; i++) keys.push(pad());
      keys.push(wm(ext), wm(guard));
      return done();
    }
    case 103: {
      const t = NAV_FLOW_TAILS_V22[103];
      if (n === t.full) { expectKey(keys, t.ext, ext, tag, "vault ext"); expectKey(keys, t.guard, guard, tag, "lev guard"); return done(); }
      if (n !== t.base && n !== t.base + 1) throw new Error(`withNavFlowTailV22: tag 103 must have ${t.base} or ${t.base + 1} (or ${t.full}) accounts, got ${n}`);
      expectKey(keys, t.ext, ext, tag, "vault ext");
      if (n === t.base) keys.push(pad());
      keys.push(wm(guard));
      return done();
    }
    case 108:
    case 110: {
      const t = NAV_FLOW_TAILS_V22[tag];
      if (n === t.full) { expectKey(keys, t.ext, ext, tag, "vault ext"); expectKey(keys, t.guard, guard, tag, "lev guard"); return done(); }
      if (n !== t.base) throw new Error(`withNavFlowTailV22: tag ${tag} must have ${t.base} (or ${t.full}) accounts, got ${n}`);
      keys.push(wm(ext), wm(guard));
      return done();
    }
    case 111: {
      const t = NAV_FLOW_TAILS_V22[111];
      const mode = base.data[1];
      if (n < t.base) throw new Error(`withNavFlowTailV22: tag 111 needs at least ${t.base} accounts, got ${n}`);
      if (!(t.modes as readonly number[]).includes(mode)) return done(); // PROPOSE moves nothing: no sample
      for (const want of [ext, guard]) {
        const at = keys.findIndex((k, i) => i >= t.base && k.pubkey.equals(want));
        if (at < 0) keys.push(wm(want)); else keys[at] = wm(want);
      }
      return done();
    }
    default:
      throw new Error(`withNavFlowTailV22: tag ${tag} takes no NAV flow tail (only 96 / 97 / 98 / 102 / 103 / 108 / 110 / 111)`);
  }
}

function requireLp(m: NavFlowMarketV22, tag: number): NavFlowMarketV22 & { lpPortfolio: PublicKey } {
  if (!m.lpPortfolio) throw new Error(`tag ${tag} needs the vault LP portfolio (m.lpPortfolio)`);
  return m as NavFlowMarketV22 & { lpPortfolio: PublicKey };
}

/**
 * DepositJuniorTranche (tag 96), v2.2 #640 form: 7 base accounts, `[7]` lev guard (w), `[8]` vault ext (w).
 * Budget {@link NAV_FLOW_COMPUTE_UNITS_V22}`[96]`.
 *
 * @param m            Market context (`lpPortfolio` required).
 * @param juniorOwner  Signer (the vault-LP state's `junior_owner`).
 * @param sourceToken  Junior's collateral token account.
 * @param vaultToken   Market collateral vault token account.
 * @param amount       Atoms.
 * @returns Instruction (9 accounts).
 * @example
 * ```ts
 * const ix = buildDepositJuniorTrancheIxV22(m, creator, creatorAta, vaultAta, 1_000_000n);
 * ```
 */
export function buildDepositJuniorTrancheIxV22(m: NavFlowMarketV22, juniorOwner: PublicKey, sourceToken: PublicKey, vaultToken: PublicKey, amount: bigint): TransactionInstruction {
  const c = requireLp(m, 96);
  return withNavFlowTailV22(buildDepositJuniorTrancheIxP3(c, juniorOwner, sourceToken, vaultToken, amount), m.market);
}

/**
 * VaultLpRecall (tag 98, permissionless), v2.2 #640 form: 8 base accounts, `[8]` vault ext (w, always), `[9]` lev guard (w).
 * Budget {@link NAV_FLOW_COMPUTE_UNITS_V22}`[98]`.
 *
 * @param m             Market context (`lpPortfolio` required).
 * @param cranker       Signer (pays rent if the target ledger is created).
 * @param amount        Atoms.
 * @param targetDomain  Receiving backing domain.
 * @returns Instruction (10 accounts).
 * @example
 * ```ts
 * const ix = buildVaultLpRecallIxV22(m, keeper, shortfall, m.registryDomain);
 * ```
 */
export function buildVaultLpRecallIxV22(m: NavFlowMarketV22, cranker: PublicKey, amount: bigint, targetDomain: number): TransactionInstruction {
  const c = requireLp(m, 98);
  return withNavFlowTailV22(buildVaultLpRecallIxP3({ ...c, vaultLpExt: undefined }, cranker, amount, targetDomain), m.market);
}

/**
 * VaultLpReleaseSurplus (tag 102, junior owner) in LIVE mode, v2.2 #641 form: 7 base accounts, `[7..11]` pads (the
 * Resolved SPL slots, not read when Live), `[12]` vault ext (w), `[13]` lev guard (w). For a Resolved market use
 * `buildVaultLpReleaseSurplusIxP3(.., resolved)` (+ `withBondTailV22` on a bond market): unchanged by #641.
 * Budget {@link NAV_FLOW_COMPUTE_UNITS_V22}`[102]`.
 *
 * @param m             Market context (`lpPortfolio` required).
 * @param juniorOwner   Signer.
 * @param amount        Atoms.
 * @param sourceDomain  Backing domain the surplus is released from.
 * @returns Instruction (14 accounts).
 * @example
 * ```ts
 * const ix = buildVaultLpReleaseSurplusLiveIxV22(m, creator, surplus, m.registryDomain);
 * ```
 */
export function buildVaultLpReleaseSurplusLiveIxV22(m: NavFlowMarketV22, juniorOwner: PublicKey, amount: bigint, sourceDomain: number): TransactionInstruction {
  const c = requireLp(m, 102);
  return withNavFlowTailV22(buildVaultLpReleaseSurplusIxP3(c, juniorOwner, amount, sourceDomain), m.market);
}

/**
 * VaultLpAllocate (tag 103, permissionless keeper crank), v2.2 #640 form: 9 base accounts (`[7]` ext), `[9]` the bond
 * tranche on a bond market (else a pad), `[10]` lev guard (w). Tag 103 measured up to 207k CU after #640 (above the
 * 200k default): ALWAYS request {@link NAV_FLOW_COMPUTE_UNITS_V22}`[103]` (600k).
 *
 * @param m        Market context (`lpPortfolio` required).
 * @param cranker  Signer; pays the ext rent on the first call.
 * @param amount   Atoms requested (`u128::MAX` = as much as the program allows).
 * @param opts     `bondTranche: true` on a bond market (registry bond flag set).
 * @returns Instruction (11 accounts).
 * @example
 * ```ts
 * const ix = buildVaultLpAllocateIxV22(m, keeper.publicKey, U128_MAX_P2B, { bondTranche: bond });
 * ```
 */
export function buildVaultLpAllocateIxV22(m: NavFlowMarketV22, cranker: PublicKey, amount: bigint, opts: { bondTranche?: boolean } = {}): TransactionInstruction {
  const c = requireLp(m, 103);
  const base = buildVaultLpAllocateIxP2b(c, cranker, amount);
  const withBond = opts.bondTranche === true
    ? new TransactionInstruction({ programId: base.programId, keys: [...base.keys, { pubkey: deriveBondTrancheV22(m.programId, m.market)[0], isSigner: false, isWritable: false }], data: base.data })
    : base;
  return withNavFlowTailV22(withBond, m.market);
}

/**
 * Whether `ix` already carries the #636 flow tail (the lev guard of `market` at its slot, or anywhere in `[7..]` for 111).
 *
 * @param ix      Instruction of a flow tag.
 * @param market  Market account.
 * @returns `true` when the guard is present where the program reads it.
 * @example
 * ```ts
 * if (!hasNavFlowTailV22(ix, market)) ix = withNavFlowTailV22(ix, market);
 * ```
 */
export function hasNavFlowTailV22(ix: TransactionInstruction, market: PublicKey): boolean {
  const { guard } = navFlowAccountsV22(ix.programId, market);
  const tag = ix.data[0];
  if (tag === 111) return ix.keys.some((k, i) => i >= 7 && k.pubkey.equals(guard));
  const t = (NAV_FLOW_TAILS_V22 as Record<number, { guard?: number }>)[tag];
  if (!t || t.guard === undefined) return false;
  return ix.keys[t.guard]?.pubkey.equals(guard) === true;
}
