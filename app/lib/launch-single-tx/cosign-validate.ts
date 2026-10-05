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
 */
import { decodeV1Message, V1DecodeError } from "./v1-decode";
import {
  classifyLaunchIx,
  configureAuthMarkNowSlot,
  launchBundleViolations,
  neutralFromV1,
  v1LimitViolations,
  type LaunchPrograms,
  type NeutralIx,
} from "./shape";

/** now_slot of the co-signed ConfigureAuthMark must be within this many slots behind the current slot. */
export const COSIGN_NOW_SLOT_MAX_AGE = 300n;
/** ...and at most this many ahead (RPC slot skew between the client's cosign fetch and this one). */
export const COSIGN_NOW_SLOT_MAX_LEAD = 5n;
/** Largest request message accepted before decoding (a v1 tx is <= 4096 B including signatures). */
export const COSIGN_V1_MAX_MESSAGE_BYTES = 4096;

export interface CosignV1Input {
  message: Uint8Array;
  keeper: string;
  deployer: string;
  slab: string;
  programs: LaunchPrograms;
  currentSlot: bigint;
  /** Builds the route's own ConfigureAuthMark + UpdateAssetAuthority for a given now_slot. */
  expectedCosign: (nowSlot: bigint) => { configure: NeutralIx; delegate: NeutralIx };
}

export type CosignV1Verdict = { ok: true; nowSlot: bigint } | { ok: false; reason: string };

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
  if (decoded.loadedAccountsDataSizeLimit === null || decoded.loadedAccountsDataSizeLimit < 1 || decoded.loadedAccountsDataSizeLimit > 64 * 1024 * 1024) {
    return { ok: false, reason: "loaded-accounts-data-size limit missing or out of range" };
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
  return { ok: true, nowSlot };
}
