/**
 * Server-side validation the keeper co-sign route runs BEFORE the keeper key signs a single-transaction
 * launch (a Solana v1 message, SIMD-0385). Pure: the route supplies the decoded inputs and the two
 * co-sign instructions it derived itself, exactly as the legacy path builds them.
 *
 * What the keeper's signature authorizes, and why each check exists:
 *  1. The message is a strict, canonical v1 message within the v1 limits (no parser differential).
 *  2. The fee payer is the deployer, never the keeper (the keeper never pays fees).
 *  3. The keeper appears in exactly ONE account slot of the whole message: new_authority of the one
 *     UpdateAssetAuthority, read-only signer. Never a program id, never a createAccount/transfer
 *     source, never writable, never in any other instruction (so its signature cannot be borrowed
 *     by any other instruction or CPI: signer privilege only extends to instructions that list it).
 *  4. The co-sign pair (ConfigureAuthMark + UpdateAssetAuthority) is byte-identical (program,
 *     accounts in order, data) to what this route derives for this deployer / slab / price / keeper,
 *     with the fresh-asset lanes (market 1, observation 1, epoch 0) and a now_slot inside the window.
 *  5. The whole message is the launch shape (lib/launch-single-tx/shape.ts): only System, ATA, Memo,
 *     the wrapper and the stake program; the exact instruction order; marketauth-gated before
 *     InitPool, Bind after it, TopUpInsurance before Bind; every create funded by the payer and
 *     before first use; the expected signer set; the replay lanes in order.
 *  6. No ComputeBudget instruction (ignored in v1; the budget is the config mask) and no instruction
 *     the shape does not name.
 *  7. (L-1) Every createAccount makes exactly the account the batched path makes: owner, space and
 *     rent-exempt lamports pinned (shape.ts createAccountParamViolations). The budget is bounded: priority
 *     fee <= COSIGN_MAX_PRIORITY_FEE_LAMPORTS, heap 0 or the wrapper's 128 KiB, loaded-accounts limit in
 *     [COSIGN_MIN_LOADED_ACCOUNTS_BYTES, 64 MiB], CU in [1, 1.4M].
 *  8. (L-2) The lifetime is a recent, still-valid blockhash (the route asks the cluster) before signing.
 *  9. (L-4) Only `authorizeKeeperCosignV1` can produce a {@link ValidatedLaunchMessage}, the one thing the
 *     keeper signer will sign raw bytes for (lib/playground-keeper-signer.ts).
 */
import bs58 from "bs58";
import { decodeV1Message, V1DecodeError } from "./v1-decode";
import { ValidatedLaunchMessage, assertValidatedLaunchMessage, claimValidatedLaunchMessageMinter } from "./validated-launch-message";
import {
  classifyLaunchIx,
  configureAuthMarkNowSlot,
  createAccountParamViolations,
  launchBundleViolations,
  neutralFromV1,
  v1LimitViolations,
  type LaunchCreatePins,
  type LaunchPrograms,
  type NeutralIx,
} from "./shape";

/** now_slot of the co-signed ConfigureAuthMark must be within this many slots behind the current slot. */
export const COSIGN_NOW_SLOT_MAX_AGE = 300n;
/** ...and at most this many ahead (RPC slot skew between the client's cosign fetch and this one). */
export const COSIGN_NOW_SLOT_MAX_LEAD = 5n;
/** Largest request message accepted before decoding (a v1 tx is <= 4096 B including signatures). */
export const COSIGN_V1_MAX_MESSAGE_BYTES = 4096;
/**
 * Largest v1 priority fee (TOTAL lamports) the keeper will co-sign: the client's ceiling
 * (lib/tx.ts PRIORITY_FEE_MAX_MICRO_LAMPORTS = 1,000,000 uL/CU) at the 1.4M CU maximum. Below the SDK
 * encoder's MAX_PRIORITY_FEE_LAMPORTS (10,000,000).
 */
export const COSIGN_MAX_PRIORITY_FEE_LAMPORTS = 1_400_000n;
/** The only non-default heap a launch requests: the wrapper's 128 KiB BumpAllocator frame (#176). */
export const COSIGN_HEAP_BYTES = 131_072;
/**
 * Lower bound for the loaded-accounts-data-size limit: the launch measured ~2.70-2.77 MB (run.ts
 * SINGLE_TX_LOADED_ACCOUNTS_BYTES); a smaller limit cannot land, so it is refused rather than signed.
 */
export const COSIGN_MIN_LOADED_ACCOUNTS_BYTES = 3 * 1024 * 1024;
/** v1 / runtime ceiling for the loaded-accounts-data-size limit (64 MiB). */
export const COSIGN_MAX_LOADED_ACCOUNTS_BYTES = 64 * 1024 * 1024;

export interface CosignV1Input {
  message: Uint8Array;
  keeper: string;
  deployer: string;
  slab: string;
  programs: LaunchPrograms;
  currentSlot: bigint;
  /** Builds the route's own ConfigureAuthMark + UpdateAssetAuthority for a given now_slot. */
  expectedCosign: (nowSlot: bigint) => { configure: NeutralIx; delegate: NeutralIx };
  /** Owner/space of each createAccount (shape.ts launchCreatePins). */
  createPins: LaunchCreatePins;
  /** Rent-exempt minimum for each pinned space, from the cluster. */
  rentExemptLamports: ReadonlyMap<number, bigint>;
}

export type CosignV1Verdict = { ok: true; nowSlot: bigint; blockhash: string } | { ok: false; reason: string };

function sameIx(a: NeutralIx, b: NeutralIx): boolean {
  if (a.programId !== b.programId || a.accounts.length !== b.accounts.length || a.data.length !== b.data.length) return false;
  if (a.accounts.some((x, i) => x.key !== b.accounts[i]!.key)) return false;
  return a.data.every((x, i) => x === b.data[i]);
}

export function validateKeeperCosignV1(i: CosignV1Input): CosignV1Verdict {
  if (i.message.length > COSIGN_V1_MAX_MESSAGE_BYTES) return { ok: false, reason: "message too large" };
  if (i.keeper === i.deployer) return { ok: false, reason: "deployer must be distinct from keeper" };
  let decoded;
  try {
    decoded = decodeV1Message(i.message);
  } catch (e) {
    return { ok: false, reason: e instanceof V1DecodeError ? `malformed v1 message: ${e.message}` : "malformed v1 message" };
  }
  const limits = v1LimitViolations({
    bytes: i.message.length + decoded.numRequiredSignatures * 64,
    accounts: decoded.accountKeys.length,
    instructions: decoded.instructions.length,
    signers: decoded.numRequiredSignatures,
  });
  if (limits.length) return { ok: false, reason: `over v1 limits: ${limits.join("; ")}` };
  if (decoded.computeUnitLimit === null || decoded.computeUnitLimit < 1 || decoded.computeUnitLimit > 1_400_000) {
    return { ok: false, reason: "compute-unit limit missing or out of range" };
  }
  if (
    decoded.loadedAccountsDataSizeLimit === null ||
    decoded.loadedAccountsDataSizeLimit < COSIGN_MIN_LOADED_ACCOUNTS_BYTES ||
    decoded.loadedAccountsDataSizeLimit > COSIGN_MAX_LOADED_ACCOUNTS_BYTES
  ) {
    return { ok: false, reason: "loaded-accounts-data-size limit missing or out of range" };
  }
  if (decoded.priorityFeeLamports !== null && decoded.priorityFeeLamports > COSIGN_MAX_PRIORITY_FEE_LAMPORTS) {
    return { ok: false, reason: `priority fee ${decoded.priorityFeeLamports} lamports is above the ${COSIGN_MAX_PRIORITY_FEE_LAMPORTS} ceiling` };
  }
  if (decoded.heapSizeBytes !== null && decoded.heapSizeBytes !== COSIGN_HEAP_BYTES) {
    return { ok: false, reason: `heap ${decoded.heapSizeBytes} bytes (only the default or ${COSIGN_HEAP_BYTES})` };
  }
  if (decoded.accountKeys[0]!.toBase58() !== i.deployer) return { ok: false, reason: "the fee payer is not the deployer" };

  const ixs = neutralFromV1(decoded);
  const kinds = ixs.map((ix) => classifyLaunchIx(ix, i.programs));
  const confIdx = kinds.indexOf("wrapper.ConfigureAuthMark");
  const delIdx = kinds.indexOf("wrapper.UpdateAssetAuthority");
  if (confIdx < 0 || delIdx < 0 || kinds.lastIndexOf("wrapper.ConfigureAuthMark") !== confIdx || kinds.lastIndexOf("wrapper.UpdateAssetAuthority") !== delIdx || delIdx !== confIdx + 1) {
    return { ok: false, reason: "the message does not carry exactly one co-sign pair (ConfigureAuthMark then UpdateAssetAuthority)" };
  }
  const nowSlot = configureAuthMarkNowSlot(ixs[confIdx]!);
  if (nowSlot === null) return { ok: false, reason: "ConfigureAuthMark is truncated" };
  if (nowSlot + COSIGN_NOW_SLOT_MAX_AGE < i.currentSlot || nowSlot > i.currentSlot + COSIGN_NOW_SLOT_MAX_LEAD) {
    return { ok: false, reason: `ConfigureAuthMark now_slot ${nowSlot} is outside the window around slot ${i.currentSlot}` };
  }
  const exp = i.expectedCosign(nowSlot);
  if (!sameIx(ixs[confIdx]!, exp.configure)) return { ok: false, reason: "ConfigureAuthMark differs from the co-sign this route builds" };
  if (!sameIx(ixs[delIdx]!, exp.delegate)) return { ok: false, reason: "UpdateAssetAuthority differs from the co-sign this route builds" };

  const violations = launchBundleViolations(ixs, { programs: i.programs, payer: i.deployer, slab: i.slab, keeper: i.keeper });
  if (violations.length) return { ok: false, reason: `not the launch shape: ${violations[0]}${violations.length > 1 ? ` (+${violations.length - 1} more)` : ""}` };
  const params = createAccountParamViolations(ixs, i.createPins, i.rentExemptLamports);
  if (params.length) return { ok: false, reason: `createAccount parameters: ${params[0]}${params.length > 1 ? ` (+${params.length - 1} more)` : ""}` };
  return { ok: true, nowSlot, blockhash: bs58.encode(decoded.recentBlockhash) };
}

// ---------------------------------------------------------------------------
// L-4: the ONLY bytes the keeper signer will sign raw
// ---------------------------------------------------------------------------

/** Claimed at load: this module is the only minter (validated-launch-message.ts, claim-once). */
const mintValidatedLaunchMessage = claimValidatedLaunchMessageMinter();

export { ValidatedLaunchMessage, assertValidatedLaunchMessage };

export type CosignV1Authorization = { ok: true; message: ValidatedLaunchMessage } | { ok: false; reason: string };

/**
 * Full authorization for a keeper v1 co-sign: the structural validation, then the lifetime check
 * (`isBlockhashValid` against the cluster, `confirmed`). Only on success is a {@link ValidatedLaunchMessage}
 * minted.
 *
 * @param isBlockhashValid - true when the blockhash is still valid for landing (route: connection.isBlockhashValid).
 */
export async function authorizeKeeperCosignV1(
  i: CosignV1Input & { isBlockhashValid: (blockhash: string) => Promise<boolean> },
): Promise<CosignV1Authorization> {
  const verdict = validateKeeperCosignV1(i);
  if (!verdict.ok) return verdict;
  if (!(await i.isBlockhashValid(verdict.blockhash))) {
    return { ok: false, reason: `the message lifetime ${verdict.blockhash} is not a recent valid blockhash` };
  }
  return { ok: true, message: mintValidatedLaunchMessage(i.message, verdict.nowSlot, verdict.blockhash) };
}
