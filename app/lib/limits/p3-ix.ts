/**
 * P3 (vault-owned LP) wire for the app: every instruction the Earn, junior-tranche,
 * resolved-exit and wizard flows send. Ported from the program source at
 * `percolator-prog feat/p3-vault-owned-lp@07a1d0eb` (FINAL combined head, on P1 3acb34ae; tag 94
 * marketauth-only with the auto-pin tail [8]/[9]/[10]; 78 also on terminal-flat Resolved; 77's
 * LP tail key-only in Resolved) (handler bodies read directly; the
 * account orders below cite them), NOT from SDK types. The app pins SDK 7 and SDK 8 is an
 * unpublished tarball, so these are local, byte-checked twice:
 *   1. `app/scripts/limits-parity/p3-final/` feeds this module's hex to the REAL
 *      `ix::Instruction::decode` of the P3 crate (fixture `rust-p3-final.json`);
 *   2. the same bytes are compared to SDK 8.0.0's own parity fixture (`sdk-p3-parity.json`,
 *      copied from `@percolatorct/sdk` 9e843e5 `test/fixtures/p3-parity.json`).
 * Every tag / tail index comes from `./constants` (never inline).
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { encodeInitVaultLpV19 } from "@/lib/v21/sdk";
import {
  BOUND_TAIL_INDEX,
  LP_VAULT_REGISTRY_SEED,
  MATCHER_DELEGATE_SEED,
  NFT_REGISTRY_SEED,
  P3_TAG,
  TAG_CLAIM_RESOLVED_PAYOUT_TOPUP,
  TAG_CLOSE_PORTFOLIO,
  TAG_CLOSE_RESOLVED,
  TAG_LP_VAULT_CRANK_FEES,
  VAULT_LP_MAX_JUNIOR_FLOOR_BPS,
  VAULT_LP_MIN_JUNIOR_FLOOR_BPS,
  VAULT_LP_STATE_SEED,
} from "./constants";

const U16_MAX = 0xffff;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const enc = new TextEncoder();

function u16(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > U16_MAX) throw new Error(`${name} must be a u16, got ${v}`);
  return v;
}
function u64(name: string, v: bigint): bigint {
  if (v < 0n || v > U64_MAX) throw new Error(`${name} must be a u64, got ${v}`);
  return v;
}
function u128(name: string, v: bigint): bigint {
  if (v < 0n || v > U128_MAX) throw new Error(`${name} must be a u128, got ${v}`);
  return v;
}
function putU128(dv: DataView, off: number, v: bigint): void {
  dv.setBigUint64(off, v & U64_MAX, true);
  dv.setBigUint64(off + 8, v >> 64n, true);
}
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

// ── PDAs ──────────────────────────────────────────────────────────────────────
export function deriveVaultLpState(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(VAULT_LP_STATE_SEED), market.toBytes()], programId)[0];
}
export function deriveLpVaultRegistryPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(LP_VAULT_REGISTRY_SEED), market.toBytes()], programId)[0];
}
export function deriveNftRegistryPda(programId: PublicKey, marketGroup: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(NFT_REGISTRY_SEED), marketGroup.toBytes()], programId)[0];
}

// ── Data encoders (pure) ──────────────────────────────────────────────────────
/** 94 InitVaultLp: [94, junior_floor_bps u16]; floor must be in 1000..=10000 (else InvalidInstruction). */
export function encodeInitVaultLp(juniorFloorBps: number): Uint8Array {
  u16("junior_floor_bps", juniorFloorBps);
  if (juniorFloorBps < VAULT_LP_MIN_JUNIOR_FLOOR_BPS || juniorFloorBps > VAULT_LP_MAX_JUNIOR_FLOOR_BPS) {
    throw new Error(`junior_floor_bps must be in ${VAULT_LP_MIN_JUNIOR_FLOOR_BPS}..=${VAULT_LP_MAX_JUNIOR_FLOOR_BPS}, got ${juniorFloorBps}`);
  }
  const out = new Uint8Array(3);
  out[0] = P3_TAG.InitVaultLp;
  new DataView(out.buffer).setUint16(1, juniorFloorBps, true);
  return out;
}
function tagU128(tag: number, name: string, amount: bigint): Uint8Array {
  u128(name, amount);
  const out = new Uint8Array(17);
  out[0] = tag;
  putU128(new DataView(out.buffer), 1, amount);
  return out;
}
/** 96 DepositJuniorTranche: [96, amount u128]. */
export const encodeDepositJuniorTranche = (amount: bigint): Uint8Array => tagU128(P3_TAG.DepositJuniorTranche, "amount", amount);
/** 97 WithdrawJuniorTranche: [97, amount u128]. */
export const encodeWithdrawJuniorTranche = (amount: bigint): Uint8Array => tagU128(P3_TAG.WithdrawJuniorTranche, "amount", amount);
/** 98 VaultLpRecall: [98, amount u128, target_domain u16]. */
export function encodeVaultLpRecall(amount: bigint, targetDomain: number): Uint8Array {
  u128("amount", amount);
  u16("target_domain", targetDomain);
  const out = new Uint8Array(19);
  const dv = new DataView(out.buffer);
  out[0] = P3_TAG.VaultLpRecall;
  putU128(dv, 1, amount);
  dv.setUint16(17, targetDomain, true);
  return out;
}
/** 101 VaultLpSettleResolved: [101, topup u8] (0 = the tag-30 close step, 1 = the tag-46 top-up). */
export function encodeVaultLpSettleResolved(topup: 0 | 1): Uint8Array {
  if (topup !== 0 && topup !== 1) throw new Error("topup must be 0 or 1");
  return Uint8Array.of(P3_TAG.VaultLpSettleResolved, topup);
}
/** 8 ClosePortfolio (v18 identity binding): [8, portfolio_id u64, expected_sequence u64, position_epoch u64]. */
export function encodeClosePortfolio(portfolioId: bigint, expectedSequence: bigint, positionEpoch: bigint): Uint8Array {
  const out = new Uint8Array(25);
  const dv = new DataView(out.buffer);
  out[0] = TAG_CLOSE_PORTFOLIO;
  dv.setBigUint64(1, u64("portfolio_id", portfolioId), true);
  dv.setBigUint64(9, u64("expected_sequence", expectedSequence), true);
  dv.setBigUint64(17, u64("position_epoch", positionEpoch), true);
  return out;
}
/** 30 CloseResolved: [30, fee_rate_per_slot u128] (the handler ignores the rate; send 0). */
export const encodeCloseResolved = (feeRatePerSlot = 0n): Uint8Array => tagU128(TAG_CLOSE_RESOLVED, "fee_rate_per_slot", feeRatePerSlot);
/** 46 ClaimResolvedPayoutTopup: [46] (no payload). */
export const encodeClaimResolvedPayoutTopup = (): Uint8Array => Uint8Array.of(TAG_CLAIM_RESOLVED_PAYOUT_TOPUP);
/** 78 LpVaultCrankFees: [78, domain u16]. */
export function encodeLpVaultCrankFees(domain: number): Uint8Array {
  u16("domain", domain);
  const out = new Uint8Array(3);
  out[0] = TAG_LP_VAULT_CRANK_FEES;
  new DataView(out.buffer).setUint16(1, domain, true);
  return out;
}

// ── Account builders ──────────────────────────────────────────────────────────
export interface VaultLpMarket {
  programId: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  vaultLpState: PublicKey;
  lpPortfolio: PublicKey;
  /** The registry's own domain ledger `["lp_backing_ledger", market, domain]` and its sibling (domain ^ 1). */
  ledger: PublicKey;
  siblingLedger: PublicKey;
  /**
   * Devnet v2.1 (P2b, #526): the per-market `VaultLpExtV19` PDA, set ONLY when it exists on chain
   * (lib/v21/vault-ext.ts reads that, flag-gated). Once it exists 97 takes it at [11] and 98 at [8]
   * (fail closed without it). Undefined on today's programs: every list below is then unchanged.
   */
  ext?: PublicKey;
}

/**
 * Append the bound-vault tail to a 75 / 77 / 78 instruction. The tail must sit EXACTLY at the
 * handler's index (75 [11]+[12], 77 [13]+[14], 78 [6]); a base list of another length would
 * shift it, so that is refused here rather than on-chain.
 */
export function withBoundVaultLpTail(
  tag: keyof typeof BOUND_TAIL_INDEX,
  keys: readonly AccountMeta[],
  vaultLpState: PublicKey,
  lpPortfolio?: PublicKey,
): AccountMeta[] {
  const at = BOUND_TAIL_INDEX[tag];
  if (keys.length !== at) throw new Error(`tag ${tag}: bound-vault tail goes at [${at}], base list has ${keys.length} accounts`);
  const out = [...keys, meta(vaultLpState, false, true)];
  if (tag !== TAG_LP_VAULT_CRANK_FEES) {
    // 75 / 77 value the vault LP: `load_bound_vault_lp_tail(.., need_lp = true)`. WRITABLE
    // (d119eebd senior draw): the instruction draws an insolvent LP's deficit itself; a
    // read-only LP with an undrawn deficit is refused 87 VaultLpSeniorDrawRequired.
    if (!lpPortfolio) throw new Error(`tag ${tag}: the bound-vault tail needs the vault LP portfolio at [${at + 1}]`);
    out.push(meta(lpPortfolio, false, true));
  }
  return out;
}

/**
 * 78 LpVaultCrankFees (`handle_lp_vault_crank_fees`): [cranker (s,w), market (w), registry (w),
 * own ledger (w), sibling ledger (w), system] (+ bound tail [6]). The TARGET ledger is picked by
 * `domain` and must be writable, so both are. Harvests the LP fee leg into backing; on a bound
 * vault the harvest is credited to the SENIOR claim (P3-K1: 77 refuses 84 until it has run).
 */
export function buildLpVaultCrankFeesIx(p: {
  programId: PublicKey;
  cranker: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  ledger: PublicKey;
  siblingLedger: PublicKey;
  domain: number;
  /**
   * `ext` + `lpPortfolio` (Devnet v2.1): with the P2b ext present, a bound 78 takes [7] vault_lp_ext (w)
   * and [8] the vault LP portfolio (the G6 fee waterfall). Absent => today's list.
   */
  bound: { vaultLpState: PublicKey; ext?: PublicKey; lpPortfolio?: PublicKey } | null;
}): TransactionInstruction {
  const base = [
    meta(p.cranker, true, true),
    meta(p.market, false, true),
    meta(p.registry, false, true),
    meta(p.ledger, false, true),
    meta(p.siblingLedger, false, true),
    meta(SystemProgram.programId, false, false),
  ];
  let keys = p.bound ? withBoundVaultLpTail(TAG_LP_VAULT_CRANK_FEES, base, p.bound.vaultLpState) : base;
  if (p.bound?.ext) {
    if (!p.bound.lpPortfolio) throw new Error("tag 78 with a vault_lp_ext needs the vault LP portfolio at [8]");
    keys = [...keys, meta(p.bound.ext, false, true), meta(p.bound.lpPortfolio, false, false)];
  }
  return new TransactionInstruction({ programId: p.programId, keys, data: Buffer.from(encodeLpVaultCrankFees(p.domain)) });
}

/** Delegate PDA `["matcher", market, lp_portfolio, registry (the LP's owner), matcher_program, ctx]`. */
export function deriveVaultLpMatcherDelegate(programId: PublicKey, market: PublicKey, lpPortfolio: PublicKey, registry: PublicKey, matcherProgram: PublicKey, matcherCtx: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode(MATCHER_DELEGATE_SEED), market.toBytes(), lpPortfolio.toBytes(), registry.toBytes(), matcherProgram.toBytes(), matcherCtx.toBytes()],
    programId,
  )[0];
}

/**
 * 94 InitVaultLp (FINAL 07a1d0eb, AUTO-PIN; marketauth only): [marketauth (s,w), market (w),
 * registry (w), vault_lp_state (w, fresh PDA), lp_portfolio (w, pre-created program-owned,
 * portfolio length), system, own ledger, sibling ledger, matcher_program (== the canonical one),
 * matcher_ctx (w, pre-created, owner = matcher, zeroed), matcher_delegate]. Data is still only
 * junior_floor_bps: the program approves the canonical matcher and pins the protocol's vAMM
 * params + price-derived finite caps itself. No creator input; trading opens right after
 * (+ tag 96). Must run while the creator is still marketauth (before StakeInitPool).
 */
export function buildInitVaultLpIx(m: VaultLpMarket, marketauth: PublicKey, juniorFloorBps: number, pin: { matcherProgram: PublicKey; matcherCtx: PublicKey }, growth?: { lLaunchX100: number }): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.programId,
    keys: [
      meta(marketauth, true, true),
      meta(m.market, false, true),
      meta(m.registry, false, true),
      meta(m.vaultLpState, false, true),
      meta(m.lpPortfolio, false, true),
      meta(SystemProgram.programId, false, false),
      meta(m.ledger, false, true),
      meta(m.siblingLedger, false, true),
      meta(pin.matcherProgram, false, false),
      meta(pin.matcherCtx, false, true),
      meta(deriveVaultLpMatcherDelegate(m.programId, m.market, m.lpPortfolio, m.registry, pin.matcherProgram, pin.matcherCtx), false, false),
    ],
    // Devnet v2.1: a growth market's bind also carries the creator's starting leverage (5-byte form).
    data: Buffer.from(growth ? encodeInitVaultLpV19(juniorFloorBps, growth.lLaunchX100) : encodeInitVaultLp(juniorFloorBps)),
  });
}

/** 96 DepositJuniorTranche: [junior_owner (s), market (w), vault_lp_state (w), lp (w), source token (w), vault token (w), token program]. */
export function buildDepositJuniorTrancheIx(
  m: VaultLpMarket,
  juniorOwner: PublicKey,
  sourceToken: PublicKey,
  vaultToken: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.programId,
    keys: [
      meta(juniorOwner, true, false),
      meta(m.market, false, true),
      meta(m.vaultLpState, false, true),
      meta(m.lpPortfolio, false, true),
      meta(sourceToken, false, true),
      meta(vaultToken, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(encodeDepositJuniorTranche(amount)),
  });
}

/**
 * 97 WithdrawJuniorTranche: [junior_owner (s), market (w), registry, vault_lp_state (w), lp (w),
 * own ledger, sibling ledger, dest token (w, owner = junior), vault token (w), vault authority,
 * token program]. Allowed only while the vault LP is FLAT and above the junior floor.
 */
export function buildWithdrawJuniorTrancheIx(
  m: VaultLpMarket,
  juniorOwner: PublicKey,
  destToken: PublicKey,
  vaultToken: PublicKey,
  vaultAuthority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.programId,
    keys: [
      meta(juniorOwner, true, false),
      meta(m.market, false, true),
      meta(m.registry, false, false),
      meta(m.vaultLpState, false, true),
      meta(m.lpPortfolio, false, true),
      meta(m.ledger, false, true),
      meta(m.siblingLedger, false, true),
      meta(destToken, false, true),
      meta(vaultToken, false, true),
      meta(vaultAuthority, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      ...(m.ext ? [meta(m.ext, false, true)] : []),
    ],
    data: Buffer.from(encodeWithdrawJuniorTranche(amount)),
  });
}

/**
 * 98 VaultLpRecall (permissionless): [cranker (s,w), market (w), registry, vault_lp_state (w),
 * lp (w), own ledger (w), sibling ledger (w), system]. Moves flat vault-LP capital into the
 * backing pot so a liquidity-blocked Earn redemption can pay.
 */
export function buildVaultLpRecallIx(m: VaultLpMarket, cranker: PublicKey, amount: bigint, targetDomain: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.programId,
    keys: [
      meta(cranker, true, true),
      meta(m.market, false, true),
      meta(m.registry, false, false),
      meta(m.vaultLpState, false, true),
      meta(m.lpPortfolio, false, true),
      meta(m.ledger, false, true),
      meta(m.siblingLedger, false, true),
      meta(SystemProgram.programId, false, false),
      ...(m.ext ? [meta(m.ext, false, true)] : []),
    ],
    data: Buffer.from(encodeVaultLpRecall(amount, targetDomain)),
  });
}

/**
 * 101 VaultLpSettleResolved (permissionless, Resolved only): [caller (s,w), market (w), registry,
 * vault_lp_state (w), lp (w), own ledger (w), sibling ledger, junior dest (w, the JUNIOR
 * OWNER's collateral ATA), vault token (w), vault authority, token program, system].
 * The senior shortfall goes back to the vault's own backing pot; the rest is paid to the junior.
 */
export function buildVaultLpSettleResolvedIx(
  m: VaultLpMarket,
  caller: PublicKey,
  juniorDestToken: PublicKey,
  vaultToken: PublicKey,
  vaultAuthority: PublicKey,
  topup: 0 | 1,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.programId,
    keys: [
      meta(caller, true, true),
      meta(m.market, false, true),
      meta(m.registry, false, false),
      meta(m.vaultLpState, false, true),
      meta(m.lpPortfolio, false, true),
      meta(m.ledger, false, true),
      meta(m.siblingLedger, false, false),
      meta(juniorDestToken, false, true),
      meta(vaultToken, false, true),
      meta(vaultAuthority, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.from(encodeVaultLpSettleResolved(topup)),
  });
}

/**
 * 30 CloseResolved / 46 ClaimResolvedPayoutTopup, PERMISSIONLESS form (after
 * `force_close_delay_slots`): [owner (NOT a signer — the portfolio's recorded owner key),
 * market (w), portfolio (w), owner's collateral ATA (w), vault token (w), vault authority,
 * token program, _, _, NftRegistry PDA]. Index 7 is the NFT-holder trio base; an unsigned
 * caller must put the market group's canonical `["nft_registry", market]` PDA there to prove the
 * portfolio is not NFT-escrowed (GH#496). Indices 8/9 are unused on this path, so the registry
 * sits at [7] and nothing follows it.
 */
export function buildPermissionlessResolvedIx(p: {
  tag: typeof TAG_CLOSE_RESOLVED | typeof TAG_CLAIM_RESOLVED_PAYOUT_TOPUP;
  programId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  ownerAta: PublicKey;
  vaultToken: PublicKey;
  vaultAuthority: PublicKey;
}): TransactionInstruction {
  const data = p.tag === TAG_CLOSE_RESOLVED ? encodeCloseResolved(0n) : encodeClaimResolvedPayoutTopup();
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      meta(p.owner, false, false),
      meta(p.market, false, true),
      meta(p.portfolio, false, true),
      meta(p.ownerAta, false, true),
      meta(p.vaultToken, false, true),
      meta(p.vaultAuthority, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(deriveNftRegistryPda(p.programId, p.market), false, false),
    ],
    data: Buffer.from(data),
  });
}

/**
 * 8 ClosePortfolio, F-4 permissionless form (Resolved mode, EMPTY portfolio): [closer (s,w),
 * market (w), portfolio (w), owner (w) — must equal the portfolio's recorded owner; the rent
 * goes there]. The owner of the vault LP is the registry PDA.
 */
export function buildResolvedClosePortfolioIx(p: {
  programId: PublicKey;
  closer: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  owner: PublicKey;
  portfolioId: bigint;
  matcherSequence: bigint;
  positionEpoch: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      meta(p.closer, true, true),
      meta(p.market, false, true),
      meta(p.portfolio, false, true),
      meta(p.owner, false, true),
    ],
    data: Buffer.from(encodeClosePortfolio(p.portfolioId, p.matcherSequence, p.positionEpoch)),
  });
}

/**
 * 102 VaultLpReleaseSurplus (junior owner). Live: [owner (s), market (w), registry,
 * vault_lp_state (w), lp (w), own ledger (w), sibling ledger (w)], data [102, amount u128,
 * source_domain u16] — backing surplus back into vault-LP capital. RESOLVED (next P3 FINAL, F-14:
 * the junior's ONLY terminal exit, after terminal-flat): pays up to `physical - C` in SPL, with
 * the tail [7] junior dest token (w, owner = junior), [8] vault token (w), [9] vault authority,
 * [10] token program. The LP is key-only there (it may be closed and GC'd).
 */
export function encodeVaultLpReleaseSurplus(amount: bigint, sourceDomain: number): Uint8Array {
  u128("amount", amount);
  u16("source_domain", sourceDomain);
  const out = new Uint8Array(19);
  const dv = new DataView(out.buffer);
  out[0] = P3_TAG.VaultLpReleaseSurplus;
  putU128(dv, 1, amount);
  dv.setUint16(17, sourceDomain, true);
  return out;
}
export function buildVaultLpReleaseSurplusIx(
  m: VaultLpMarket,
  juniorOwner: PublicKey,
  amount: bigint,
  sourceDomain: number,
  resolved: { destToken: PublicKey; vaultToken: PublicKey; vaultAuthority: PublicKey } | null,
): TransactionInstruction {
  const keys = [
    meta(juniorOwner, true, false),
    meta(m.market, false, true),
    meta(m.registry, false, false),
    meta(m.vaultLpState, false, true),
    meta(m.lpPortfolio, false, true),
    meta(m.ledger, false, true),
    meta(m.siblingLedger, false, true),
  ];
  if (resolved) {
    keys.push(meta(resolved.destToken, false, true), meta(resolved.vaultToken, false, true), meta(resolved.vaultAuthority, false, false), meta(TOKEN_PROGRAM_ID, false, false));
  }
  return new TransactionInstruction({ programId: m.programId, keys, data: Buffer.from(encodeVaultLpReleaseSurplus(amount, sourceDomain)) });
}
