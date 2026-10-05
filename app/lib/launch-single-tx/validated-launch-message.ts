/**
 * The ONLY bytes the keeper signer will sign raw (L-4, security review 2026-10-05).
 *
 * Dependency-free on purpose: lib/playground-keeper-signer.ts imports it, and every route that holds the
 * keeper signer (faucet, keeper-register, cosign) would otherwise load the whole launch validator.
 *
 * Minting is claim-once: `claimValidatedLaunchMessageMinter()` hands out the minter exactly once per module
 * instance, and lib/launch-single-tx/cosign-validate.ts claims it when it loads. A second claim throws, so
 * any other module that tries to mint makes the claim fail loudly (in the validator or in itself) instead
 * of silently gaining a raw signer.
 */

/** Module-private constructor token. */
const MINT_TOKEN: unique symbol = Symbol("ValidatedLaunchMessage.mint");
/** Runtime brand: only instances minted here are in it (a prototype-forged object is not). */
const MINTED = new WeakSet<object>();
let claimed = false;

/**
 * A v1 launch message that passed the keeper co-sign validation AND the blockhash freshness check
 * (cosign-validate.ts authorizeKeeperCosignV1). Holds a private copy of the bytes, so a caller mutating its
 * buffer after validation cannot change what is signed.
 */
export class ValidatedLaunchMessage {
  readonly #bytes: Uint8Array;
  readonly nowSlot: bigint;
  readonly blockhash: string;
  constructor(token: typeof MINT_TOKEN, bytes: Uint8Array, nowSlot: bigint, blockhash: string) {
    if (token !== MINT_TOKEN) throw new Error("a ValidatedLaunchMessage can only be created by the keeper co-sign validator");
    this.#bytes = Uint8Array.from(bytes);
    this.nowSlot = nowSlot;
    this.blockhash = blockhash;
    MINTED.add(this);
  }
  /** A copy of the validated message bytes. */
  bytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** Throws unless `m` was minted by the claimed minter in this process. */
export function assertValidatedLaunchMessage(m: unknown): asserts m is ValidatedLaunchMessage {
  if (typeof m !== "object" || m === null || !MINTED.has(m) || !(m instanceof ValidatedLaunchMessage)) {
    throw new Error("refusing to sign: not a validated launch message");
  }
}

export type ValidatedLaunchMessageMinter = (bytes: Uint8Array, nowSlot: bigint, blockhash: string) => ValidatedLaunchMessage;

/**
 * The minter, handed out once. Only lib/launch-single-tx/cosign-validate.ts may call this.
 *
 * @throws if it was already claimed.
 */
export function claimValidatedLaunchMessageMinter(): ValidatedLaunchMessageMinter {
  if (claimed) throw new Error("the ValidatedLaunchMessage minter is already claimed (only the keeper co-sign validator may mint)");
  claimed = true;
  return (bytes, nowSlot, blockhash) => new ValidatedLaunchMessage(MINT_TOKEN, bytes, nowSlot, blockhash);
}
