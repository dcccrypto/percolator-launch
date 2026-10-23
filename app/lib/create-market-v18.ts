/**
 * v18 write-wire facts the create-market wizard depends on, kept pure so they
 * can be tested without a wallet or an RPC.
 *
 * Every value here was measured against the deployed wrapper
 * (DEVNET_PROGRAM_IDS.wrapper, lib/program-ids.ts; v18.2 = percolator-prog
 * 6377376a) on 2026-09-29, by simulating against market
 * 5T1yvECyKB66QskfTSmz4fBkgDsknrNjE5LizL6P4Xr9 — a launch that stopped after
 * M1 + the keeper co-sign + M2.
 */
import { PublicKey } from "@solana/web3.js";
import { MAX_BACKING_BUCKET_EXPIRY_SLOT } from "@percolatorct/sdk";

/**
 * Expiry for a DIRECT TopUpBackingBucket seed: effectively never lapses, but is
 * NOT the reserved LP-vault sentinel.
 *
 * The SDK's `MAX_BACKING_BUCKET_EXPIRY_SLOT` is `u64::MAX / 2`, which the
 * wrapper also uses as `LP_VAULT_BACKING_EXPIRY_SLOT`. `handle_top_up_backing_bucket`
 * refuses that exact value with InvalidInstruction (Custom 9), because a direct
 * top-up stamped with it would permanently block CloseSlab. The wizard passed
 * it anyway, so every backing seed since v18 was refused: on the batched path
 * that failed the whole launch, and on the sequential path the failure was
 * swallowed (`backingSeedFailed`). MAX - 1 is what the proven reseed script
 * (newmarkets.ts `BORN_IMMORTAL_BACKING_EXPIRY`) uses.
 *
 * SetMatcherConfig's `expirySlot` is a different field with no such guard and
 * keeps using the SDK constant.
 */
export const DIRECT_BACKING_TOPUP_EXPIRY_SLOT: bigint = MAX_BACKING_BUCKET_EXPIRY_SLOT - 1n;

/**
 * Asset 0's `authority_epoch` on a brand-new market at the point the batched
 * launch's funding transactions run (M3a backing seeds, M3b insurance, M4b
 * UpdateFeeSplit), all of which are CAS-bound to it.
 *
 * InitMarket leaves it at 0. The ONLY wrapper handler that advances it is
 * UpdateAssetAuthority (`advance_authority_epoch_view`, +1 per call). A keeper
 * launch sends exactly one of those — the co-signed oracle hand-off — before
 * M3a, so the lane is 1 by then. The batch hardcoded 0, and the wrapper
 * refused every keeper launch's M3a with EngineStale (Custom 19), which the
 * app then described as a stale engine needing a crank.
 */
export function freshLaunchAuthorityEpoch(oracleDelegatedInBatch: boolean): bigint {
  return oracleDelegatedInBatch ? 1n : 0n;
}

/** On-chain oracle_mode for AUTH_MARK (what ConfigureAuthMark sets). */
export const ORACLE_MODE_AUTH_MARK = 3;

/**
 * Whether the keeper oracle hand-off (ConfigureAuthMark + UpdateAssetAuthority
 * Oracle → keeper) has already landed on this market.
 *
 * After it lands the deployer is no longer the oracle authority, so sending it
 * again is refused with Unauthorized (Custom 8). A retry that re-sent it is
 * exactly how a user saw "not authorized" on the step after an earlier failure
 * (GH#2680). The resume path must check this first and skip the step.
 *
 * `keeper` is the pubkey the co-sign backend signs as (GET
 * /api/playground/keeper-cosign). When it is known, "applied" means the
 * authority IS that keeper — NOT merely "someone other than the deployer".
 * Those are not the same test: a market whose authority is a third key is
 * unpriceable (the keeper cannot call PushAuthMark on it, and registration
 * refuses it with `oracle-not-keeper`), yet the old test reported it as a
 * finished hand-off and the resume path skipped the only step that could
 * repair it. Use `oracleAuthorityMismatch` to detect that case.
 *
 * `keeper` omitted/null (the GET failed, or a caller that cannot reach it)
 * falls back to GH#2680's original test, so a resume still skips a hand-off
 * that genuinely landed rather than re-sending it into Custom(8).
 */
export function isOracleDelegationApplied(
  profile: { oracleMode: number; oracleAuthority: PublicKey },
  deployer: PublicKey,
  keeper?: PublicKey | null,
): boolean {
  if (profile.oracleMode !== ORACLE_MODE_AUTH_MARK) return false;
  if (keeper) return profile.oracleAuthority.equals(keeper);
  return !profile.oracleAuthority.equals(deployer);
}

/**
 * The oracle authority when it is neither the deployer nor the keeper — i.e. a
 * market that no one on this deployment can price, and that
 * `checkKeeperReadiness` will refuse with `oracle-not-keeper` (HTTP 403, which
 * the launch's registration loop treats as final and never retries).
 *
 * Returns null when there is nothing wrong, when the keeper is unknown, or when
 * the authority is still the deployer (the hand-off simply has not run yet).
 */
export function oracleAuthorityMismatch(
  profile: { oracleMode: number; oracleAuthority: PublicKey },
  deployer: PublicKey,
  keeper: PublicKey | null | undefined,
): PublicKey | null {
  if (!keeper || profile.oracleMode !== ORACLE_MODE_AUTH_MARK) return null;
  if (profile.oracleAuthority.equals(keeper)) return null;
  if (profile.oracleAuthority.equals(deployer)) return null;
  return profile.oracleAuthority;
}

/**
 * Which part of the launch a failure came from. The same program error means
 * different things at different steps (see parseMarketCreationError).
 */
export type CreateStepKind =
  | "create-market"
  | "oracle-delegation"
  | "lp-init"
  | "funding"
  | "insurance"
  | "earn-vault"
  | "vault-lp"
  | "stake-pool";

/** Step kind for a sequential step number (0-5). */
export function sequentialStepKind(step: number): CreateStepKind {
  const kinds: CreateStepKind[] = [
    "create-market",
    "oracle-delegation",
    "lp-init",
    "funding",
    "earn-vault",
    "stake-pool",
  ];
  return kinds[Math.min(Math.max(step, 0), kinds.length - 1)] ?? "create-market";
}
