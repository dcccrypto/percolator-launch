/**
 * The single-transaction market launch: its expected instruction SHAPE and the structural invariants
 * every launch bundle must satisfy. ONE module, used by both sides:
 *  - the client (lib/launch-single-tx/run.ts) refuses to simulate or sign a bundle that violates it;
 *  - the keeper co-sign route (app/api/playground/keeper-cosign) refuses to co-sign one.
 *
 * The bundle itself is never re-encoded here: the hook concatenates the batched launch's own
 * descriptors (M1, the keeper co-sign pair, M3b, M4a, M4p, M4b, see `singleTxInstructionPlan` in
 * hooks/useCreateMarket.ts), so this module only CHECKS what those builders produced.
 *
 * Expected order (P3 launch; [x] = optional):
 *   M1   system.createAccount(slab) ata.create InitMarket SetNftProgramId [memo]
 *   co   ConfigureAuthMark UpdateAssetAuthority(Oracle -> keeper)          (keeper-priced only)
 *   M3b  TopUpInsurance
 *   M4a  CreateLpVault ata.createIdempotent DepositToLpVault DepositToLpVault
 *   M4p  system.createAccount(vault-LP portfolio) system.createAccount(matcher ctx) InitVaultLp DepositJuniorTranche
 *   M4b  system.createAccount(stake LP mint) system.createAccount(stake vault) [UpdateFeeSplit] stake.InitPool stake.BindInsuranceAuthority
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE } from "@solana/spl-token";
import { IX_TAG, IX_TAG_P3, STAKE_IX, deriveInsuranceLpMint, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { portfolioAccountLen } from "@/lib/v22/layout";
import { slabSizeFor } from "@/lib/create-market-args";
import { VAULT_LP_MATCHER_CTX_LEN } from "@/lib/limits/constants";
import { MEMO_PROGRAM_ID } from "@/lib/keeper-register-memo";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, deriveLpShareMetaPayerPdaV22, deriveLpShareMetadataPdaV22, isLpShareTickerV22 } from "@/lib/v22/sdk";
import { decodeV1Message, v1IsSigner, v1IsWritable, type DecodedV1Message } from "./v1-decode";

/** One instruction with MESSAGE-level account flags (what the runtime enforces). */
export interface NeutralIx {
  programId: string;
  accounts: { key: string; signer: boolean; writable: boolean }[];
  data: Uint8Array;
}

/** Programs a launch may invoke besides System / ATA / Memo. */
export interface LaunchPrograms {
  wrapper: string;
  stake: string;
}

/** Wrapper tag 107 (v2.2 InitBondTranche); same number as IX_TAG_V22.InitBondTranche, kept literal so this module stays dependency-light. */
const V22_INIT_BOND_TRANCHE_TAG = 107;

/** Wrapper tag 122 (v2.2 InitLpShareMetadata, the Earn share token's name); same number as IX_TAG_V22.InitLpShareMetadata. */
const V22_INIT_LP_SHARE_METADATA_TAG = 122;

const WRAPPER_TAGS = {
  InitMarket: IX_TAG.InitMarket,
  SetNftProgramId: IX_TAG.SetNftProgramId,
  ConfigureAuthMark: IX_TAG.ConfigureAuthMark,
  PushAuthMark: IX_TAG.PushAuthMark,
  UpdateAssetAuthority: IX_TAG.UpdateAssetAuthority,
  TopUpInsurance: IX_TAG.TopUpInsurance,
  CreateLpVault: IX_TAG.CreateLpVault,
  DepositToLpVault: IX_TAG.DepositToLpVault,
  InitVaultLp: IX_TAG_P3.InitVaultLp,
  DepositJuniorTranche: IX_TAG_P3.DepositJuniorTranche,
  UpdateFeeSplit: IX_TAG.UpdateFeeSplit,
} as const;
type WrapperName = keyof typeof WRAPPER_TAGS;

export type LaunchIxKind =
  | "system.createAccount"
  | "system.other"
  | "ata.create"
  | "ata.createIdempotent"
  | "ata.other"
  | "memo"
  | `wrapper.${WrapperName}`
  | "wrapper.InitBondTranche"
  | "wrapper.InitLpShareMetadata"
  | "wrapper.other"
  | "stake.InitPool"
  | "stake.BindInsuranceAuthority"
  | "stake.other"
  | "foreign";

const SYSTEM = SystemProgram.programId.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const MEMO = MEMO_PROGRAM_ID.toBase58();

/** Instructions whose gate is cfg.marketauth: they must run before stake.InitPool rotates it. */
export const MARKETAUTH_GATED: readonly LaunchIxKind[] = [
  "wrapper.SetNftProgramId",
  "wrapper.CreateLpVault",
  "wrapper.InitVaultLp",
  "wrapper.UpdateFeeSplit",
  "wrapper.InitBondTranche",
  // Only the ticker form is marketauth-gated, but the launch never sends either form after the rotation.
  "wrapper.InitLpShareMetadata",
];

export function classifyLaunchIx(ix: NeutralIx, p: LaunchPrograms): LaunchIxKind {
  const tag = ix.data[0];
  if (ix.programId === SYSTEM) {
    // SystemInstruction::CreateAccount = u32 LE 0, then lamports u64, space u64, owner [32].
    return ix.data.length === 52 && ix.data[0] === 0 && ix.data[1] === 0 && ix.data[2] === 0 && ix.data[3] === 0
      ? "system.createAccount"
      : "system.other";
  }
  if (ix.programId === ATA) {
    if (ix.data.length === 0 || (ix.data.length === 1 && tag === 0)) return "ata.create";
    if (ix.data.length === 1 && tag === 1) return "ata.createIdempotent";
    return "ata.other";
  }
  if (ix.programId === MEMO) return "memo";
  if (ix.programId === p.wrapper) {
    for (const [name, t] of Object.entries(WRAPPER_TAGS) as [WrapperName, number][]) {
      if (tag === t) return `wrapper.${name}`;
    }
    // v2.2 (flag-gated, so a v2.1 deployment still treats tag 107 as foreign): the capacity bond.
    if (isDevnetV22Enabled() && tag === V22_INIT_BOND_TRANCHE_TAG) return "wrapper.InitBondTranche";
    // v2.2 (flag-gated): naming the Earn share token, right after CreateLpVault.
    if (isDevnetV22Enabled() && tag === V22_INIT_LP_SHARE_METADATA_TAG) return "wrapper.InitLpShareMetadata";
    return "wrapper.other";
  }
  if (ix.programId === p.stake) {
    if (tag === STAKE_IX.InitPool) return "stake.InitPool";
    if (tag === STAKE_IX.BindInsuranceAuthority) return "stake.BindInsuranceAuthority";
    return "stake.other";
  }
  return "foreign";
}

export interface LaunchShapeOptions {
  /** The keeper-registration memo rides in M1 (keeper-priced market with a pool). */
  memo: boolean;
  /** The keeper co-sign pair (ConfigureAuthMark + UpdateAssetAuthority) follows M1. */
  cosign: boolean;
  /** A non-default fee split (UpdateFeeSplit before InitPool). */
  feeSplit: boolean;
  /**
   * v2.2 capacity bond: InitBondTranche (107) right after InitVaultLp (94), and the Earn seeds (ata + 2 x 75) after it,
   * because 107 is refused once the vault has any Earn deposit. Absent = the v2.1 shape.
   */
  bond?: boolean;
  /**
   * v2.2 share-token naming (tag 122) right after CreateLpVault, while the creator is still marketauth. In the bond launch it travels with the
   * Earn-seed segment (after 107), exactly where the segment is moved to (see lib/v22/launch-wire.ts). Absent = the v2.1 shape.
   */
  shareName?: boolean;
}

/** The exact kind sequence of a single-transaction P3 launch. */
export function expectedLaunchShape(o: LaunchShapeOptions): LaunchIxKind[] {
  if (o.bond) return expectedBondLaunchShape(o);
  return [
    "system.createAccount",
    "ata.create",
    "wrapper.InitMarket",
    "wrapper.SetNftProgramId",
    ...(o.memo ? (["memo"] as const) : []),
    ...(o.cosign ? (["wrapper.ConfigureAuthMark", "wrapper.UpdateAssetAuthority"] as const) : []),
    "wrapper.TopUpInsurance",
    "wrapper.CreateLpVault",
    ...(o.shareName ? (["wrapper.InitLpShareMetadata"] as const) : []),
    "ata.createIdempotent",
    "wrapper.DepositToLpVault",
    "wrapper.DepositToLpVault",
    "system.createAccount",
    "system.createAccount",
    "wrapper.InitVaultLp",
    "wrapper.DepositJuniorTranche",
    "system.createAccount",
    "system.createAccount",
    ...(o.feeSplit ? (["wrapper.UpdateFeeSplit"] as const) : []),
    "stake.InitPool",
    "stake.BindInsuranceAuthority",
  ];
}

/** The bond launch: 74, the two creates, 94, 107, then the Earn seeds, then the junior deposit (see lib/v22/launch-wire.ts). */
function expectedBondLaunchShape(o: LaunchShapeOptions): LaunchIxKind[] {
  const v21 = expectedLaunchShape({ ...o, bond: false });
  const i74 = v21.indexOf("wrapper.CreateLpVault");
  const i94 = v21.indexOf("wrapper.InitVaultLp");
  return [
    ...v21.slice(0, i74 + 1),
    ...v21.slice(i94 - 2, i94 + 1),
    "wrapper.InitBondTranche",
    ...v21.slice(i74 + 1, i94 - 2),
    ...v21.slice(i94 + 1),
  ];
}

/** Message-level flags for a list of instructions, exactly as the v1/legacy compilers merge them. */
export function neutralFromInstructions(payer: PublicKey, ixs: readonly TransactionInstruction[]): NeutralIx[] {
  const flags = new Map<string, { signer: boolean; writable: boolean }>();
  const up = (k: string, s: boolean, w: boolean): void => {
    const f = flags.get(k);
    if (f) {
      f.signer ||= s;
      f.writable ||= w;
    } else flags.set(k, { signer: s, writable: w });
  };
  up(payer.toBase58(), true, true);
  for (const ix of ixs) for (const m of ix.keys) up(m.pubkey.toBase58(), m.isSigner, m.isWritable);
  for (const ix of ixs) up(ix.programId.toBase58(), false, false);
  return ixs.map((ix) => ({
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((m) => {
      const k = m.pubkey.toBase58();
      return { key: k, ...flags.get(k)! };
    }),
    data: Uint8Array.from(ix.data),
  }));
}

export function neutralFromV1(d: DecodedV1Message): NeutralIx[] {
  return d.instructions.map((ix) => ({
    programId: d.accountKeys[ix.programIdIndex]!.toBase58(),
    accounts: ix.accountIndexes.map((i) => ({ key: d.accountKeys[i]!.toBase58(), signer: v1IsSigner(d, i), writable: v1IsWritable(d, i) })),
    data: ix.data,
  }));
}

/** Decode a v1 message and return its instructions in neutral form (strict; throws on bad bytes). */
export function neutralFromV1Message(message: Uint8Array): { decoded: DecodedV1Message; ixs: NeutralIx[] } {
  const decoded = decodeV1Message(message);
  return { decoded, ixs: neutralFromV1(decoded) };
}

const readU64 = (b: Uint8Array, off: number): bigint | null => {
  if (b.length < off + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
};

/** Byte offsets of the replay-lane fields (lib: @percolatorct/sdk encoders). */
const OFF = {
  /** ConfigureAuthMark / PushAuthMark: tag u8, asset u16, market u64, now_slot u64, mark u64, seq u64. */
  observationSeq: 27,
  authMarkNowSlot: 11,
  /** UpdateAssetAuthority: tag u8, asset u16, market u64, kind u8, new [32], epoch u64. */
  uaaEpoch: 1 + 2 + 8 + 1 + 32,
  /** TopUpInsurance: tag u8, market u64, intent u64, epoch u64, amount u128. */
  topupEpoch: 17,
  /** UpdateFeeSplit: tag u8, 3x u16, epoch u64. */
  feeSplitEpoch: 7,
} as const;

/** now_slot of a ConfigureAuthMark (the co-sign route checks it against the current slot). */
export function configureAuthMarkNowSlot(ix: NeutralIx): bigint | null {
  return readU64(ix.data, OFF.authMarkNowSlot);
}

export interface LaunchBundleContext {
  programs: LaunchPrograms;
  /** Fee payer = the creator's wallet. */
  payer: string;
  slab: string;
  /** The keeper key when the bundle carries the co-sign pair, else null. */
  keeper: string | null;
}

/**
 * Every structural rule of a single-transaction launch. Returns the violations (empty = valid).
 * Pure; never throws for a malformed bundle (it reports it).
 */
export function launchBundleViolations(ixs: readonly NeutralIx[], ctx: LaunchBundleContext): string[] {
  const v: string[] = [];
  const kinds = ixs.map((ix) => classifyLaunchIx(ix, ctx.programs));
  const opts: LaunchShapeOptions = {
    memo: kinds.includes("memo"),
    cosign: ctx.keeper !== null,
    feeSplit: kinds.includes("wrapper.UpdateFeeSplit"),
    bond: kinds.includes("wrapper.InitBondTranche"),
    shareName: kinds.includes("wrapper.InitLpShareMetadata"),
  };
  const expected = expectedLaunchShape(opts);
  if (kinds.length !== expected.length || kinds.some((k, i) => k !== expected[i])) {
    v.push(`instruction order is not the launch shape: got [${kinds.join(", ")}]`);
  }
  for (const [i, k] of kinds.entries()) {
    if (k === "foreign" || k.endsWith(".other")) v.push(`ix ${i}: program/instruction not allowed (${ixs[i]!.programId})`);
  }

  const first = (k: LaunchIxKind): number => kinds.indexOf(k);
  const initPool = first("stake.InitPool");
  const bind = first("stake.BindInsuranceAuthority");
  const topup = first("wrapper.TopUpInsurance");
  for (const gated of MARKETAUTH_GATED) {
    kinds.forEach((k, i) => {
      if (k === gated && initPool >= 0 && i > initPool) v.push(`ix ${i}: ${k} after stake.InitPool (marketauth already rotated)`);
    });
  }
  if (initPool < 0 || bind < 0 || bind < initPool) v.push("stake.BindInsuranceAuthority must follow stake.InitPool");
  if (topup < 0 || bind < 0 || topup > bind) v.push("TopUpInsurance must precede BindInsuranceAuthority (insurance_authority is the creator until 19)");
  const createLp = first("wrapper.CreateLpVault");
  const bindLp = first("wrapper.InitVaultLp");
  if (createLp < 0 || bindLp < 0 || bindLp < createLp) v.push("InitVaultLp must follow CreateLpVault");

  // v2.2: the share-token naming is bound to THIS market, funded and signed only by the creator, and carries a ticker the program accepts.
  kinds.forEach((k, i) => {
    if (k === "wrapper.InitLpShareMetadata") v.push(...shareNameViolations(ixs[i]!, i, ctx));
  });

  // F2 (security review of #3235): an Earn seed (tag 75) sent BEFORE InitVaultLp runs on an unbound vault and takes the
  // plain 11 accounts; one sent AFTER it (the bond launch) runs on a BOUND vault and REQUIRES the tail [11] vault_lp_state
  // and [12] the vault LP portfolio, exactly the two accounts InitVaultLp (accounts [3] and [4]) bound. Nothing else.
  if (bindLp >= 0) {
    const bindIx = ixs[bindLp]!;
    const lpState = bindIx.accounts[3]?.key;
    const lpPortfolio = bindIx.accounts[4]?.key;
    kinds.forEach((k, i) => {
      if (k !== "wrapper.DepositToLpVault") return;
      const a = ixs[i]!.accounts;
      if (i > bindLp) {
        if (a.length !== 13 || a[11]?.key !== lpState || a[12]?.key !== lpPortfolio || !a[11]?.writable) {
          v.push(`ix ${i}: DepositToLpVault after InitVaultLp (a bound vault) must carry the vault_lp_state and LP portfolio tail`);
        }
      } else if (a.length !== 11) {
        v.push(`ix ${i}: DepositToLpVault before InitVaultLp must have exactly 11 accounts, got ${a.length}`);
      }
    });
  }

  // Accounts are created before anything references them; every create is funded by the payer and
  // its new account is a signer (a fresh keypair) that is neither the payer nor the keeper.
  const created = new Set<string>();
  ixs.forEach((ix, i) => {
    if (kinds[i] !== "system.createAccount") return;
    const from = ix.accounts[0];
    const to = ix.accounts[1];
    if (!from || !to) {
      v.push(`ix ${i}: createAccount without from/to`);
      return;
    }
    if (from.key !== ctx.payer) v.push(`ix ${i}: createAccount funded by ${from.key}, not the payer`);
    if (!to.signer || to.key === ctx.payer || to.key === ctx.keeper) v.push(`ix ${i}: createAccount target ${to.key} is not a fresh signer`);
    for (let j = 0; j < i; j++) {
      const prev = ixs[j]!;
      if (prev.programId === to.key || prev.accounts.some((a) => a.key === to.key)) {
        v.push(`ix ${j} uses ${to.key} before ix ${i} creates it`);
      }
    }
    created.add(to.key);
  });
  const slabCreate = ixs[kinds.indexOf("system.createAccount")];
  if (slabCreate?.accounts[1]?.key !== ctx.slab) v.push("the first createAccount must create the slab");
  const init = ixs[first("wrapper.InitMarket")];
  if (init && (init.accounts[0]?.key !== ctx.payer || init.accounts[1]?.key !== ctx.slab)) v.push("InitMarket admin/slab mismatch");
  ixs.forEach((ix, i) => {
    if ((kinds[i] === "ata.create" || kinds[i] === "ata.createIdempotent") && ix.accounts[0]?.key !== ctx.payer) {
      v.push(`ix ${i}: ATA rent payer is not the payer`);
    }
  });

  // Replay lanes on a FRESH market, inside one tx: the oracle-observation lane runs 1, 2, ... across
  // ConfigureAuthMark / PushAuthMark (a push in the same tx as ConfigureAuthMark is seq 2, not 1:
  // the 2026-10-05 sim of the seed bundle failed Custom 19 with 1); the authority-epoch lane is
  // advanced only by UpdateAssetAuthority, and every epoch-bound ix after it carries the new value.
  let obs = 0n;
  let epoch = 0n;
  ixs.forEach((ix, i) => {
    const k = kinds[i];
    if (k === "wrapper.ConfigureAuthMark" || k === "wrapper.PushAuthMark") {
      obs += 1n;
      const seq = readU64(ix.data, OFF.observationSeq);
      if (seq !== obs) v.push(`ix ${i}: ${k} observation sequence ${seq} (expected ${obs})`);
    } else if (k === "wrapper.UpdateAssetAuthority") {
      const e = readU64(ix.data, OFF.uaaEpoch);
      if (e !== epoch) v.push(`ix ${i}: UpdateAssetAuthority epoch ${e} (expected ${epoch})`);
      epoch += 1n;
    } else if (k === "wrapper.TopUpInsurance" || k === "wrapper.UpdateFeeSplit") {
      const e = readU64(ix.data, k === "wrapper.TopUpInsurance" ? OFF.topupEpoch : OFF.feeSplitEpoch);
      if (e !== epoch) v.push(`ix ${i}: ${k} authority epoch ${e} (expected ${epoch})`);
    }
  });

  // Signers: exactly the payer, the fresh keypairs the bundle creates, and (co-sign) the keeper.
  const signers = new Set<string>();
  for (const ix of ixs) for (const a of ix.accounts) if (a.signer) signers.add(a.key);
  for (const s of signers) {
    if (s !== ctx.payer && !created.has(s) && s !== ctx.keeper) v.push(`unexpected signer ${s}`);
  }

  // The keeper key: the signer of exactly ONE instruction (UpdateAssetAuthority, slot 1 =
  // new_authority), read-only, never the payer, a program, a create source or anything else.
  if (ctx.keeper !== null) {
    if (ctx.keeper === ctx.payer) v.push("the keeper is the fee payer");
    const uses: { i: number; pos: number }[] = [];
    ixs.forEach((ix, i) => {
      if (ix.programId === ctx.keeper) v.push(`ix ${i}: the keeper is a program id`);
      ix.accounts.forEach((a, pos) => {
        if (a.key === ctx.keeper) uses.push({ i, pos });
      });
    });
    if (uses.length !== 1) v.push(`the keeper appears in ${uses.length} account slots (expected exactly 1)`);
    const u = uses[0];
    if (u) {
      const ix = ixs[u.i]!;
      if (kinds[u.i] !== "wrapper.UpdateAssetAuthority" || u.pos !== 1) v.push(`ix ${u.i}: the keeper is used outside UpdateAssetAuthority.new_authority`);
      const a = ix.accounts[u.pos]!;
      if (!a.signer) v.push("the keeper is not a signer of its UpdateAssetAuthority");
      if (a.writable) v.push("the keeper is writable");
    }
  }
  return v;
}

/**
 * Tag 122 inside a launch. Everything the instruction names is derived from THIS launch's slab and wrapper (registry, share mint, the
 * Metaplex metadata PDA, the wrapper's fee-payer PDA), the payer and marketauth are the creator (fee payer) and nobody else, and the data is
 * `[122][n][ticker]` with a program-valid ticker (`A-Z0-9`, n <= 8; n = 0 is the generic form, which carries no market / marketauth accounts).
 */
export function shareNameViolations(ix: NeutralIx, i: number, ctx: LaunchBundleContext): string[] {
  const v: string[] = [];
  const wrapper = new PublicKey(ctx.programs.wrapper);
  const market = new PublicKey(ctx.slab);
  const registry = deriveLpVaultRegistry(wrapper, market)[0];
  const mint = deriveInsuranceLpMint(wrapper, market)[0];
  const want = [
    ctx.payer, registry.toBase58(), mint.toBase58(), deriveLpShareMetadataPdaV22(mint)[0].toBase58(),
    METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBase58(), SYSTEM, deriveLpShareMetaPayerPdaV22(wrapper, mint)[0].toBase58(),
  ];
  const n = ix.data[1];
  if (ix.data.length < 2 || n === undefined || n > 8 || ix.data.length !== 2 + n) {
    v.push(`ix ${i}: InitLpShareMetadata data is not [122][n <= 8][n ticker bytes]`);
    return v;
  }
  const ticker = new TextDecoder().decode(ix.data.subarray(2));
  if (n > 0 && !isLpShareTickerV22(ticker)) v.push(`ix ${i}: InitLpShareMetadata ticker is not A-Z0-9`);
  const expectedAccounts = n > 0 ? 9 : 7;
  if (ix.accounts.length !== expectedAccounts) {
    v.push(`ix ${i}: InitLpShareMetadata has ${ix.accounts.length} accounts (expected ${expectedAccounts})`);
    return v;
  }
  want.forEach((key, pos) => {
    if (ix.accounts[pos]!.key !== key) v.push(`ix ${i}: InitLpShareMetadata account [${pos}] is not the one derived from this market`);
  });
  if (!ix.accounts[0]!.signer || !ix.accounts[0]!.writable) v.push(`ix ${i}: InitLpShareMetadata payer must be a writable signer`);
  if (n > 0) {
    // Flags here are MESSAGE-level (the slab is writable elsewhere in the bundle), so only the identity is checked.
    if (ix.accounts[7]!.key !== ctx.slab) v.push(`ix ${i}: InitLpShareMetadata [7] must be this market`);
    if (ix.accounts[8]!.key !== ctx.payer || !ix.accounts[8]!.signer) v.push(`ix ${i}: InitLpShareMetadata marketauth [8] must be the creator and sign`);
  }
  return v;
}

/** Wire-level limits of a v1 transaction (SIMD-0385 / SIMD-0296). */
export const V1_LIMITS = { bytes: 4096, accounts: 64, instructions: 64, signers: 12 } as const;

export interface BundleStats {
  bytes: number;
  accounts: number;
  instructions: number;
  signers: number;
}

export function v1LimitViolations(s: BundleStats): string[] {
  const v: string[] = [];
  if (s.bytes > V1_LIMITS.bytes) v.push(`${s.bytes} bytes > ${V1_LIMITS.bytes}`);
  if (s.accounts > V1_LIMITS.accounts) v.push(`${s.accounts} accounts > ${V1_LIMITS.accounts}`);
  if (s.instructions > V1_LIMITS.instructions) v.push(`${s.instructions} instructions > ${V1_LIMITS.instructions}`);
  if (s.signers > V1_LIMITS.signers) v.push(`${s.signers} signers > ${V1_LIMITS.signers}`);
  return v;
}

// ---------------------------------------------------------------------------
// createAccount PARAMETERS (L-1, security review 2026-10-05)
//
// launchBundleViolations pins WHO creates WHAT and in which order; this pins the account each create
// makes: owner program, space and rent. The values are the constants the builders use (hooks/
// useCreateMarket.ts M1/M4p/M4b, lib/limits/p3-wizard.ts buildP3BindIxs), so the keeper only ever
// authorises a launch whose accounts have exactly the layout the batched path would create.
// ---------------------------------------------------------------------------

/** One expected createAccount: owner program and data length. */
export interface CreatePin {
  space: number;
  owner: string;
}

/** The five creates of a single-tx P3 launch, in message order. */
export const LAUNCH_CREATE_ORDER = ["slab", "vaultLpPortfolio", "matcherCtx", "stakeLpMint", "stakeVault"] as const;
export type LaunchCreateName = (typeof LAUNCH_CREATE_ORDER)[number];
export type LaunchCreatePins = Record<LaunchCreateName, CreatePin>;

/**
 * The pins, from the builders' own constants.
 *
 * @param p - wrapper program, the canonical vault-LP matcher (`canonicalVaultLpMatcher`) and the SPL token program.
 */
export function launchCreatePins(p: { wrapper: string; matcher: string; tokenProgram: string }): LaunchCreatePins {
  return {
    slab: { space: slabSizeFor({ p3: true }), owner: p.wrapper },
    vaultLpPortfolio: { space: portfolioAccountLen(), owner: p.wrapper },
    matcherCtx: { space: VAULT_LP_MATCHER_CTX_LEN, owner: p.matcher },
    stakeLpMint: { space: MINT_SIZE, owner: p.tokenProgram },
    stakeVault: { space: ACCOUNT_SIZE, owner: p.tokenProgram },
  };
}

/** SystemInstruction::CreateAccount fields (u32 tag 0, lamports u64, space u64, owner [32]); null if not one. */
export function decodeCreateAccount(ix: NeutralIx): { lamports: bigint; space: bigint; owner: string } | null {
  if (ix.programId !== SYSTEM || ix.data.length !== 52 || ix.data[0] !== 0 || ix.data[1] !== 0 || ix.data[2] !== 0 || ix.data[3] !== 0) return null;
  return {
    lamports: readU64(ix.data, 4)!,
    space: readU64(ix.data, 12)!,
    owner: new PublicKey(ix.data.subarray(20, 52)).toBase58(),
  };
}

/**
 * Every createAccount must match its pin: owner, space, and lamports == the rent-exempt minimum for that
 * space (exactly what the batched path funds: getMinimumBalanceForRentExemption(space), no top-up).
 *
 * @param rentExemptLamports - rent-exempt minimum per pinned space (the route reads it from the cluster).
 */
export function createAccountParamViolations(
  ixs: readonly NeutralIx[],
  pins: LaunchCreatePins,
  rentExemptLamports: ReadonlyMap<number, bigint>,
): string[] {
  const v: string[] = [];
  const creates = ixs.map((ix, i) => ({ i, c: decodeCreateAccount(ix) })).filter((x) => x.c !== null);
  if (creates.length !== LAUNCH_CREATE_ORDER.length) {
    v.push(`expected ${LAUNCH_CREATE_ORDER.length} createAccount instructions, got ${creates.length}`);
  }
  LAUNCH_CREATE_ORDER.forEach((name, n) => {
    const x = creates[n];
    if (!x) return;
    const c = x.c!;
    const pin = pins[name];
    if (c.owner !== pin.owner) v.push(`ix ${x.i}: ${name} createAccount owner ${c.owner} (expected ${pin.owner})`);
    if (c.space !== BigInt(pin.space)) v.push(`ix ${x.i}: ${name} createAccount space ${c.space} (expected ${pin.space})`);
    const rent = rentExemptLamports.get(pin.space);
    if (rent === undefined) v.push(`ix ${x.i}: no rent-exempt minimum known for ${pin.space} bytes`);
    else if (c.lamports !== rent) v.push(`ix ${x.i}: ${name} createAccount lamports ${c.lamports} (expected the rent-exempt ${rent})`);
  });
  return v;
}
