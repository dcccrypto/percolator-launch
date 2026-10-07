/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ ecb6215 (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/p2b-earn.ts. Only the imports are retargeted (the vendored v22 layout/slab ports, sibling records ports, and the installed @percolatorct/sdk 8.0.0 root).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ../../records.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * P2b Earn as counterparty — PDA, instruction builders and account decoders (tag 103, tag 99
 * dials form, `VaultLpExtV19`, the non-bound tag-77 redeemer signature).
 *
 * Source: percolator-prog PR #526 at `d9e3e2d7` (see `abi/p2b-earn.ts`). DRAFT, not deployed.
 *
 * COUPLING (wrapper review I-3): the program, SDK and keeper ship together. Once any tag 103 (or the
 * tag-99 dials form) has created the ext and raised the registry flag, a client that omits the ext
 * from 98 / 97 / bound 78 fails closed, and a bound 77 needs a prior harvest, so every redemption on
 * that market would break. On a Live NON-bound vault tag 77 also needs `[12]` = the redeemer as a
 * SIGNER, so a keeper can no longer execute someone else's 77.
 *
 * @module p2b-earn
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { AccountMeta, Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildAccountMetas } from "@percolatorct/sdk";
import { encodeExecuteRedemption } from "@percolatorct/sdk";
import {
  ACCOUNTS_SET_VAULT_LP_RISK_V19_P2B,
  ACCOUNTS_VAULT_LP_ALLOCATE_P2B,
  KIND_VAULT_LP_EXT_P2B,
  LP_VAULT_REGISTRY_EXT_FLAG_OFF_P2B,
  U128_MAX_P2B,
  VAULT_LP_EXT_ACCOUNT_LEN_P2B,
  VAULT_LP_EXT_FIELD_OFF_P2B,
  VAULT_LP_EXT_SEED_P2B,
  VAULT_LP_EXT_VERSION_P2B,
  ALLOC_ALPHA_MAX_BPS_P2B,
  ALLOC_BUFFER_MIN_BPS_P2B,
  BACKING_BUCKET_FIELD_OFF_P2B,
  BACKING_DOMAIN_LEDGER_ACCOUNT_LEN_P2B,
  BACKING_DOMAIN_LEDGER_FIELD_OFF_P2B,
  BOUND_SCALE_P2B,
  KIND_BACKING_DOMAIN_LEDGER_P2B,
  SOURCE_CREDIT_FIELD_OFF_P2B,
  SOURCE_CREDIT_LEN_P2B,
  SOURCE_CREDIT_REL_P2B,
  encodeSetVaultLpRiskV19P2b,
  encodeVaultLpAllocateP2b,
  insuranceCoverNumP2b,
  nonboundVaultPricingP2b,
  potPhysicalNetAtomsP2b,
} from "./p2b-earn-abi";
import type { NonboundPotP2b, NonboundVaultPricingP2b, SetVaultLpRiskV19ArgsP2b } from "./p2b-earn-abi";
import { deriveInsuranceLpMint, deriveLpBackingLedger, deriveLpEscrow, deriveLpRedemption, deriveLpVaultRegistry, deriveVaultAuthority } from "@percolatorct/sdk";
import { deriveProgramDataAddressP3, deriveVaultLpStateP3, withBoundVaultLpTailP3 } from "./p3-vault-lp";
import type { VaultLpMarketP3 } from "./p3-vault-lp";
import { V17_KIND_OFF, V17_MAGIC } from "../slab";
import { resolveLayout, resolveMarketGeometry } from "../layout";
import { V17_ASSET_SLOT_WRAPPER_LEN, V17_ENGINE_BACKING_LONG_REL, V17_ENGINE_BACKING_SHORT_REL } from "./backing-bucket";

/**
 * Derive the per-market `VaultLpExtV19` PDA: `["vault_lp_ext", market]`.
 *
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @returns `[pda, bump]`.
 * @example
 * ```ts
 * const [ext] = deriveVaultLpExtP2b(WRAPPER, market);
 * ```
 */
export function deriveVaultLpExtP2b(programId: PublicKey, market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(VAULT_LP_EXT_SEED_P2B), market.toBytes()], programId);
}

/**
 * True if an LP-vault registry has its "VaultLpExtV19 exists" flag set (`_reserved[1] == 1`, account
 * byte 161). While set, tags 98 / 97 / bound 78 REQUIRE the ext account.
 *
 * @param registryData  Raw LpVaultRegistry account bytes.
 * @returns Whether the ext exists.
 * @throws If the flag byte is neither 0 nor 1 (the program rejects it too) or the account is short.
 * @example
 * ```ts
 * const m: VaultLpMarketP3 = { ...base, vaultLpExt: isLpVaultRegistryExtP2b(reg.data) ? deriveVaultLpExtP2b(P, market)[0] : undefined };
 * ```
 */
export function isLpVaultRegistryExtP2b(registryData: Uint8Array): boolean {
  if (registryData.length <= LP_VAULT_REGISTRY_EXT_FLAG_OFF_P2B) throw new Error("registry account too short for the ext flag");
  const b = registryData[LP_VAULT_REGISTRY_EXT_FLAG_OFF_P2B];
  if (b !== 0 && b !== 1) throw new Error(`registry ext flag must be 0|1, got ${b}`);
  return b === 1;
}

/** Decoded `VaultLpExtV19`. */
export interface VaultLpExtV19 {
  marketGroup: PublicKey;
  /** Senior principal sitting in the vault LP's capital because of tag 103 (minus tag-98 recalls). */
  allocatedAtoms: bigint;
  /** Cumulative LP-fee atoms the G6 waterfall routed to the junior cushion (locked against 97 up to the target). */
  cushionAccruedAtoms: bigint;
  allocatedTotalAtoms: bigint;
  deallocatedTotalAtoms: bigint;
  /** Allocation fraction of C_eff (<= 5000 until L3). */
  allocAlphaBps: number;
  /** Redemption buffer kept liquid in the pots (>= 3000). */
  allocBufferBps: number;
  cushionTargetBps: number;
  cushionShareBps: number;
  version: number;
  bump: number;
}

function dv(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}
function u128At(v: DataView, o: number): bigint {
  return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true);
}

/**
 * Decode a `VaultLpExtV19` account (kind 10, 144 bytes), mirroring `read_vault_lp_ext`'s header and
 * `validate_vault_lp_ext` (version 1, non-zero market, alpha <= 5000, buffer in [3000, 10000],
 * cushion target / share <= 10000 and both-or-neither, zero padding and reserved).
 *
 * @param data  Raw account bytes (header included).
 * @returns Decoded ext.
 * @throws If the magic, kind, length or any validated field is wrong.
 * @example
 * ```ts
 * const info = await conn.getAccountInfo(deriveVaultLpExtP2b(P, market)[0]);
 * const ext = decodeVaultLpExtV19(info!.data);
 * ```
 */
export function decodeVaultLpExtV19(data: Uint8Array): VaultLpExtV19 {
  if (data.length < VAULT_LP_EXT_ACCOUNT_LEN_P2B) throw new Error(`VaultLpExtV19: need ${VAULT_LP_EXT_ACCOUNT_LEN_P2B} bytes, got ${data.length}`);
  const v = dv(data);
  if (v.getBigUint64(0, true) !== V17_MAGIC) throw new Error("VaultLpExtV19: invalid v17 magic");
  resolveLayout(data, { parser: "VaultLpExtV19" }); // VERSION guard: 18 (v2.1) or 19 (v2.2), else a typed UnknownLayoutError
  if (data[V17_KIND_OFF] !== KIND_VAULT_LP_EXT_P2B) throw new Error(`VaultLpExtV19: kind ${data[V17_KIND_OFF]} != ${KIND_VAULT_LP_EXT_P2B}`);
  const B = 16;
  const F = VAULT_LP_EXT_FIELD_OFF_P2B;
  const marketGroup = new PublicKey(data.subarray(B + F.marketGroup, B + F.marketGroup + 32));
  const out: VaultLpExtV19 = {
    marketGroup,
    allocatedAtoms: u128At(v, B + F.allocatedAtoms),
    cushionAccruedAtoms: u128At(v, B + F.cushionAccruedAtoms),
    allocatedTotalAtoms: u128At(v, B + F.allocatedTotalAtoms),
    deallocatedTotalAtoms: u128At(v, B + F.deallocatedTotalAtoms),
    allocAlphaBps: v.getUint16(B + F.allocAlphaBps, true),
    allocBufferBps: v.getUint16(B + F.allocBufferBps, true),
    cushionTargetBps: v.getUint16(B + F.cushionTargetBps, true),
    cushionShareBps: v.getUint16(B + F.cushionShareBps, true),
    version: data[B + F.version],
    bump: data[B + F.bump],
  };
  const zero = (o: number, n: number): boolean => data.subarray(B + o, B + o + n).every((b) => b === 0);
  if (
    out.version !== VAULT_LP_EXT_VERSION_P2B || marketGroup.equals(PublicKey.default) ||
    out.allocAlphaBps > ALLOC_ALPHA_MAX_BPS_P2B || out.allocBufferBps < ALLOC_BUFFER_MIN_BPS_P2B || out.allocBufferBps > 10_000 ||
    out.cushionTargetBps > 10_000 || out.cushionShareBps > 10_000 || (out.cushionTargetBps === 0) !== (out.cushionShareBps === 0) ||
    !zero(F.padding, 6) || !zero(F.reserved, 16)
  ) {
    throw new Error("VaultLpExtV19: invalid record — the program would reject it too");
  }
  return out;
}

/**
 * Fetch and decode a market's ext. `null` when the account does not exist (no ext yet: the keeper's
 * first tag 103 or the tag-99 dials form creates it).
 *
 * @param conn       Connection (only `getAccountInfo` is used).
 * @param programId  Wrapper program id.
 * @param market     Market account.
 * @returns The decoded ext or null.
 * @example
 * ```ts
 * const ext = await fetchVaultLpExtP2b(conn, WRAPPER, market);
 * ```
 */
export async function fetchVaultLpExtP2b(conn: Pick<Connection, "getAccountInfo">, programId: PublicKey, market: PublicKey): Promise<VaultLpExtV19 | null> {
  const info = await conn.getAccountInfo(deriveVaultLpExtP2b(programId, market)[0]);
  if (!info) return null;
  return decodeVaultLpExtV19(new Uint8Array(info.data));
}

/**
 * Build tag 103 VaultLpAllocate (permissionless, Live). The ext PDA is derived and always passed
 * (the first call creates it, the cranker paying rent). `amount` defaults to `u128::MAX`: the
 * program clamps to `min(alpha*C_eff - allocated, drawable - buffer*C_eff)`.
 *
 * Compute: tag 103 runs a full certificate refresh of the vault LP; budget it like tag 77
 * ({@link RECOMMENDED_CU_P3}). Send it only on a bound market (`isLpVaultRegistryBoundP3`); Custom 100
 * means "no room right now", not a failure of the client.
 *
 * @param m        Market context (`registryDomain`, `lpPortfolio`).
 * @param cranker  Signer; pays the ext rent on the first call.
 * @param amount   Atoms requested (default `u128::MAX`).
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildVaultLpAllocateIxP2b(m, keeper.publicKey);
 * ```
 */
export function buildVaultLpAllocateIxP2b(m: VaultLpMarketP3, cranker: PublicKey, amount: bigint = U128_MAX_P2B): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.programId,
    keys: buildAccountMetas(ACCOUNTS_VAULT_LP_ALLOCATE_P2B, {
      cranker, market: m.market, registry: deriveLpVaultRegistry(m.programId, m.market)[0],
      vaultLpState: deriveVaultLpStateP3(m.programId, m.market)[0], lpPortfolio: m.lpPortfolio,
      ledger: deriveLpBackingLedger(m.programId, m.market, m.registryDomain)[0],
      siblingLedger: deriveLpBackingLedger(m.programId, m.market, m.registryDomain ^ 1)[0],
      vaultLpExt: deriveVaultLpExtP2b(m.programId, m.market)[0], systemProgram: SystemProgram.programId,
    }),
    data: Buffer.from(encodeVaultLpAllocateP2b(amount)),
  });
}

/**
 * Build tag 99 in its dials form (81 bytes, 6 accounts): the legacy risk fields plus the allocation
 * and cushion dials; creates the ext on first use. Upgrade-authority only; the authority pays rent.
 *
 * @param programId         Wrapper program id.
 * @param market            Market account.
 * @param upgradeAuthority  Signer (writable).
 * @param args              Fields and dials.
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildSetVaultLpRiskV19IxP2b(WRAPPER, market, ua, { ...risk, allocAlphaBps: 5000, allocBufferBps: 3000, cushionTargetBps: 0, cushionShareBps: 0 });
 * ```
 */
export function buildSetVaultLpRiskV19IxP2b(programId: PublicKey, market: PublicKey, upgradeAuthority: PublicKey, args: SetVaultLpRiskV19ArgsP2b): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: buildAccountMetas(ACCOUNTS_SET_VAULT_LP_RISK_V19_P2B, {
      upgradeAuthority, programData: deriveProgramDataAddressP3(programId)[0], market,
      registry: deriveLpVaultRegistry(programId, market)[0], vaultLpExt: deriveVaultLpExtP2b(programId, market)[0],
      systemProgram: SystemProgram.programId,
    }),
    data: Buffer.from(encodeSetVaultLpRiskV19P2b(args)),
  });
}

/**
 * Tag 78 LpVaultCrankFees on a BOUND vault, ext-aware: `base` (the 6-account unbound form) plus
 * `[6] vault_lp_state (w)`, and, once the ext exists, `[7] ext (w)` and `[8] vault LP (w)`.
 * Equivalent to `withBoundVaultLpTailP3(base, state, lp, { vaultLpExt })`.
 *
 * @param base  Unbound-form tag-78 instruction (6 accounts).
 * @param m     Market context; set `m.vaultLpExt` once the registry ext flag is set.
 * @returns The instruction with the tail.
 * @example
 * ```ts
 * const ix = withCrankFeesBoundTailP2b(crankFeesIx, { ...m, vaultLpExt });
 * ```
 */
export function withCrankFeesBoundTailP2b(base: TransactionInstruction, m: VaultLpMarketP3): TransactionInstruction {
  return withBoundVaultLpTailP3(base, deriveVaultLpStateP3(m.programId, m.market)[0], m.lpPortfolio, { vaultLpExt: m.vaultLpExt });
}

/**
 * Tag 77 ExecuteRedemption on a NON-bound vault: 13 accounts, with `[12]` = the redeemer, a SIGNER by
 * default. A Live non-bound exit is priced on E3, whose claim term can sit in a touch-order dip, so
 * the program refuses (`ExpectedSigner`) unless the redeemer signs (review H-1(b)): a keeper can no
 * longer execute someone else's 77. In Resolved mode the signature is not required
 * (`redeemerSigns: false`).
 *
 * Accounts: 0 cranker [s,w] · 1 market [w] · 2 registry [w] · 3 redemption [w] · 4 LP mint [w] ·
 * 5 escrow [w] · 6 vault token [w] · 7 vault authority · 8 own ledger [w] · 9 redeemer ATA [w] ·
 * 10 token program · 11 sibling ledger [w] · 12 redeemer (rent destination) [w, signer].
 *
 * @param m             Market context (`registryDomain` picks the own ledger; `lpPortfolio` unused).
 * @param cranker       Fee payer / signer; may equal the redeemer.
 * @param redeemer      The redemption's owner.
 * @param redeemerDest  Redeemer's collateral token account.
 * @param vaultToken    Market collateral vault token account.
 * @param sourceDomain  Pot to redeem from.
 * @param opts          `redeemerSigns` (default true).
 * @returns Instruction.
 * @example
 * ```ts
 * const ix = buildExecuteRedemptionIxNonBoundP2b(m, user, user, userAta, vaultAta, m.registryDomain);
 * // the transaction must be signed by `user`
 * ```
 */
export function buildExecuteRedemptionIxNonBoundP2b(
  m: Pick<VaultLpMarketP3, "programId" | "market" | "registryDomain">, cranker: PublicKey, redeemer: PublicKey, redeemerDest: PublicKey,
  vaultToken: PublicKey, sourceDomain: number, opts: { redeemerSigns?: boolean } = {},
): TransactionInstruction {
  const [registry] = deriveLpVaultRegistry(m.programId, m.market);
  const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: m.programId,
    data: Buffer.from(encodeExecuteRedemption({ domain: sourceDomain })),
    keys: [
      w(cranker, true), w(m.market), w(registry), w(deriveLpRedemption(m.programId, registry, redeemer)[0]),
      w(deriveInsuranceLpMint(m.programId, m.market)[0]), w(deriveLpEscrow(m.programId, m.market)[0]), w(vaultToken),
      r(deriveVaultAuthority(m.programId, m.market)[0]), w(deriveLpBackingLedger(m.programId, m.market, m.registryDomain)[0]),
      w(redeemerDest), r(TOKEN_PROGRAM_ID), w(deriveLpBackingLedger(m.programId, m.market, m.registryDomain ^ 1)[0]),
      w(redeemer, opts.redeemerSigns !== false),
    ],
  });
}

// ============================================================================
// Non-bound Earn: ledger + per-pot engine records -> entry / exit pricing (R3-M1 monitor)
// ============================================================================

/** Decoded `BackingDomainLedgerAccountV16` (`["lp_backing_ledger", market, domain]`). */
export interface BackingDomainLedgerP2b {
  marketGroup: PublicKey;
  authority: PublicKey;
  totalPrincipalAtoms: bigint;
  totalDepositedAtoms: bigint;
  totalPrincipalWithdrawnAtoms: bigint;
  totalEarningsAtoms: bigint;
  totalEarningsWithdrawnAtoms: bigint;
  lastObservedBucketEarningsAtoms: bigint;
  cumulativeLossAtoms: bigint;
  cumulativeRecoveryAtoms: bigint;
  lastObservedUnavailablePrincipalAtoms: bigint;
  domain: number;
  /** The asset generation the counters belong to (0 = an unstamped legacy record). */
  marketId: bigint;
}

/**
 * Decode a `BackingDomainLedgerAccountV16` account: EXACTLY 240 bytes, kind 3, non-zero market group
 * and authority, zero padding (`read_backing_domain_ledger` / `validate_backing_domain_ledger`).
 *
 * @param data  Raw account bytes.
 * @returns Decoded ledger.
 * @throws If the program's own reader would reject the account.
 * @example
 * ```ts
 * const own = decodeBackingDomainLedgerP2b(info.data);
 * ```
 */
export function decodeBackingDomainLedgerP2b(data: Uint8Array): BackingDomainLedgerP2b {
  if (data.length !== BACKING_DOMAIN_LEDGER_ACCOUNT_LEN_P2B) throw new Error(`BackingDomainLedger: need exactly ${BACKING_DOMAIN_LEDGER_ACCOUNT_LEN_P2B} bytes, got ${data.length}`);
  const v = dv(data);
  if (v.getBigUint64(0, true) !== V17_MAGIC) throw new Error("BackingDomainLedger: invalid v17 magic");
  resolveLayout(data, { parser: "BackingDomainLedger" }); // VERSION guard: 18 (v2.1) or 19 (v2.2), else a typed UnknownLayoutError
  if (data[V17_KIND_OFF] !== KIND_BACKING_DOMAIN_LEDGER_P2B) throw new Error(`BackingDomainLedger: kind ${data[V17_KIND_OFF]} != ${KIND_BACKING_DOMAIN_LEDGER_P2B}`);
  const B = 16;
  const F = BACKING_DOMAIN_LEDGER_FIELD_OFF_P2B;
  const marketGroup = new PublicKey(data.subarray(B + F.marketGroup, B + F.marketGroup + 32));
  const authority = new PublicKey(data.subarray(B + F.authority, B + F.authority + 32));
  if (marketGroup.equals(PublicKey.default) || authority.equals(PublicKey.default) || !data.subarray(B + F.padding, B + F.padding + 6).every((b) => b === 0)) {
    throw new Error("BackingDomainLedger: invalid record — the program would reject it too");
  }
  return {
    marketGroup, authority,
    totalPrincipalAtoms: u128At(v, B + F.totalPrincipalAtoms), totalDepositedAtoms: u128At(v, B + F.totalDepositedAtoms),
    totalPrincipalWithdrawnAtoms: u128At(v, B + F.totalPrincipalWithdrawnAtoms), totalEarningsAtoms: u128At(v, B + F.totalEarningsAtoms),
    totalEarningsWithdrawnAtoms: u128At(v, B + F.totalEarningsWithdrawnAtoms), lastObservedBucketEarningsAtoms: u128At(v, B + F.lastObservedBucketEarningsAtoms),
    cumulativeLossAtoms: u128At(v, B + F.cumulativeLossAtoms), cumulativeRecoveryAtoms: u128At(v, B + F.cumulativeRecoveryAtoms),
    lastObservedUnavailablePrincipalAtoms: u128At(v, B + F.lastObservedUnavailablePrincipalAtoms),
    domain: v.getUint16(B + F.domain, true), marketId: v.getBigUint64(B + F.marketId, true),
  };
}

/** The slice of one pot's engine records the non-bound pricing reads (all `_num` fields in 1e-12 atoms). */
export interface PotEngineRecordsP2b {
  freshUnlienedBackingNum: bigint;
  validLienedBackingNum: bigint;
  /** Winners' registered claims on this pot (`source.positive_claim_bound_num`). */
  positiveClaimBoundNum: bigint;
  insuranceCreditReservedNum: bigint;
  validLienedInsuranceNum: bigint;
  impairedLienedInsuranceNum: bigint;
  /** `bucket.utilization_fee_earnings` (atoms): what the ledger's earnings sync watches. */
  utilizationFeeEarnings: bigint;
}

/**
 * Read one pot's source-credit state and backing bucket out of a raw market account.
 *
 * @param marketData  Raw market account bytes (kind 1).
 * @param domain      Backing domain (`asset * 2 + side`; even = long).
 * @returns The fields `nonbound_pot_physical_parts` reads.
 * @throws If the account is not a market or too short.
 * @example
 * ```ts
 * const rec = readPotEngineRecordsP2b(market.data, registry.domain);
 * ```
 */
export function readPotEngineRecordsP2b(marketData: Uint8Array, domain: number): PotEngineRecordsP2b {
  const g = resolveMarketGeometry(marketData, { parser: "readPotEngineRecordsP2b", strictLength: false });
  if (!Number.isInteger(domain) || domain < 0) throw new Error(`bad domain ${domain}`);
  const asset = domain >> 1;
  const short = (domain & 1) === 1;
  const engineBase = g.engineOff(asset);
  const scOff = engineBase + (short ? g.layout.engineSlot.sourceCreditShort : g.layout.engineSlot.sourceCreditLong);
  const bkOff = engineBase + (short ? g.layout.engineSlot.backingShort : g.layout.engineSlot.backingLong);
  if (marketData.length < bkOff + 97 || marketData.length < scOff + SOURCE_CREDIT_LEN_P2B) throw new Error(`market account too short for domain ${domain}`);
  const v = dv(marketData);
  const S = SOURCE_CREDIT_FIELD_OFF_P2B;
  const K = BACKING_BUCKET_FIELD_OFF_P2B;
  return {
    freshUnlienedBackingNum: u128At(v, bkOff + K.freshUnlienedBackingNum),
    validLienedBackingNum: u128At(v, bkOff + K.validLienedBackingNum),
    utilizationFeeEarnings: u128At(v, bkOff + K.utilizationFeeEarnings),
    positiveClaimBoundNum: u128At(v, scOff + S.positiveClaimBoundNum),
    insuranceCreditReservedNum: u128At(v, scOff + S.insuranceCreditReservedNum),
    validLienedInsuranceNum: u128At(v, scOff + S.validLienedInsuranceNum),
    impairedLienedInsuranceNum: u128At(v, scOff + S.impairedLienedInsuranceNum),
  };
}

/**
 * One non-bound pot's pricing inputs, exactly as `lp_vault_domain_nav_atoms` sees them: the ledger is
 * SYNCED to the bucket first (`sync_backing_domain_ledger`: earnings grow by the bucket's delta), a pot
 * whose ledger account does not exist yet contributes zero principal and zero earnings.
 *
 * @param rec     {@link readPotEngineRecordsP2b} of the pot.
 * @param ledger  The pot's decoded ledger, or null when the ledger account does not exist.
 * @returns {@link NonboundPotP2b}.
 * @example
 * ```ts
 * const pot = nonboundPotFromRecordsP2b(readPotEngineRecordsP2b(m, domain), ledgerInfo ? decodeBackingDomainLedgerP2b(ledgerInfo.data) : null);
 * ```
 */
export function nonboundPotFromRecordsP2b(rec: PotEngineRecordsP2b, ledger: BackingDomainLedgerP2b | null): NonboundPotP2b {
  const principal = ledger?.totalPrincipalAtoms ?? 0n;
  let earnings = ledger?.totalEarningsAtoms ?? 0n;
  const watermark = ledger?.lastObservedBucketEarningsAtoms ?? rec.utilizationFeeEarnings;
  if (rec.utilizationFeeEarnings >= watermark) earnings += rec.utilizationFeeEarnings - watermark;
  return {
    totalPrincipalAtoms: principal,
    totalEarningsAtoms: earnings,
    totalEarningsWithdrawnAtoms: ledger?.totalEarningsWithdrawnAtoms ?? 0n,
    physicalNetAtoms: potPhysicalNetAtomsP2b(
      rec.freshUnlienedBackingNum, rec.validLienedBackingNum, rec.positiveClaimBoundNum,
      insuranceCoverNumP2b(rec.insuranceCreditReservedNum, rec.validLienedInsuranceNum, rec.impairedLienedInsuranceNum), BOUND_SCALE_P2B,
    ),
  };
}

/** Inputs for {@link nonboundVaultPricingFromAccountsP2b}: raw account bytes straight from `getAccountInfo`. */
export interface NonboundVaultAccountsP2b {
  /** Raw market account. */
  marketData: Uint8Array;
  /** `registry.domain` (the vault's own pot; the sibling is `domain ^ 1`). */
  registryDomain: number;
  /** `registry.fee_share_bps`. */
  feeShareBps: number;
  /** Own-domain ledger account bytes, or null if it does not exist. */
  ownLedgerData: Uint8Array | null;
  /** Sibling-domain ledger account bytes, or null if it does not exist. */
  siblingLedgerData: Uint8Array | null;
}

/**
 * Entry NAV, exit NAV and the par - E3 gap of a NON-bound Earn vault from raw accounts. This is the
 * quantity the R3-M1 mitigation monitors (the exit-side touch-order skim is at most
 * `redeemer share * parMinusE3Atoms`): alert when it is large and keep touching every open portfolio.
 *
 * @param a  Raw accounts.
 * @returns {@link NonboundVaultPricingP2b}.
 * @example
 * ```ts
 * const p = nonboundVaultPricingFromAccountsP2b({ marketData, registryDomain: reg.domain, feeShareBps: reg.feeShareBps, ownLedgerData, siblingLedgerData });
 * health.parMinusE3Bps = p.parMinusE3Bps;
 * ```
 */
export function nonboundVaultPricingFromAccountsP2b(a: NonboundVaultAccountsP2b): NonboundVaultPricingP2b {
  const pot = (domain: number, ledgerData: Uint8Array | null): NonboundPotP2b =>
    nonboundPotFromRecordsP2b(readPotEngineRecordsP2b(a.marketData, domain), ledgerData && ledgerData.length > 0 ? decodeBackingDomainLedgerP2b(ledgerData) : null);
  return nonboundVaultPricingP2b(pot(a.registryDomain, a.ownLedgerData), pot(a.registryDomain ^ 1, a.siblingLedgerData), a.feeShareBps);
}
