/**
 * Playground Keeper Signer
 *
 * Loads the keeper oracle authority keypair for the playground's
 * bundled create+delegate flow (ConfigureAuthMark + UpdateAssetAuthority).
 *
 * Reads PLAYGROUND_KEEPER_KEYPAIR env var first, falls back to
 * DEVNET_MINT_AUTHORITY_KEYPAIR (shared mint-authority key used in PoCs).
 *
 * The keeper service (dcccrypto/percolator-oracle-keeper feat/cross-cluster-keeper)
 * must be configured with the SAME keypair so it can call PushAuthMark on markets
 * whose oracle_authority was delegated here.
 *
 * Pattern mirrors lib/devnet-signer.ts.
 */

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import _bs58 from "bs58";
import { assertValidatedLaunchMessage, type ValidatedLaunchMessage } from "@/lib/launch-single-tx/cosign-validate";

const bs58: { encode(buf: Uint8Array): string; decode(str: string): Uint8Array } = _bs58 as any;

export interface KeeperSealedSigner {
  publicKey(): string;
  signTransaction(tx: Transaction | VersionedTransaction): Transaction | VersionedTransaction;
  partialSign(tx: Transaction): void;
  /**
   * Ed25519 signature over a Solana v1 launch message (web3.js 1.x cannot represent a v1 message, so
   * there is no transaction object to sign). Takes ONLY a {@link ValidatedLaunchMessage}, which nothing but
   * `authorizeKeeperCosignV1` (lib/launch-single-tx/cosign-validate.ts) can create; raw bytes, or an
   * object that merely looks like one, throw (L-4, security review 2026-10-05). So the faucet and every
   * other route that holds this signer cannot sign arbitrary bytes with the keeper key.
   */
  signMessageBytes(message: ValidatedLaunchMessage): Uint8Array;
}

let _keeperSigner: KeeperSealedSigner | null = null;
let _loadAttempted = false;

function loadKeeperKeypair(env: NodeJS.ProcessEnv): KeeperSealedSigner | null {
  // Prefer playground-specific key; fall back to shared devnet mint authority
  const rawKey =
    env.PLAYGROUND_KEEPER_KEYPAIR?.trim() ||
    env.DEVNET_MINT_AUTHORITY_KEYPAIR?.trim();

  if (!rawKey) return null;

  let keypair: Keypair;
  try {
    const parsed = JSON.parse(rawKey);
    if (!Array.isArray(parsed) || parsed.length !== 64) {
      throw new Error(`Invalid key: expected 64-byte array`);
    }
    keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    // Try base58
    try {
      const decoded = bs58.decode(rawKey);
      if (decoded.length !== 64) throw new Error(`Invalid key length: ${decoded.length}`);
      keypair = Keypair.fromSecretKey(decoded);
    } catch {
      throw new Error(
        "Invalid PLAYGROUND_KEEPER_KEYPAIR / DEVNET_MINT_AUTHORITY_KEYPAIR format. " +
        "Must be a JSON [64 bytes] array or a base58-encoded secret key.",
      );
    }
  }

  const pubkeyStr = keypair.publicKey.toBase58();
  return {
    publicKey(): string {
      return pubkeyStr;
    },
    signTransaction(tx: Transaction | VersionedTransaction): Transaction | VersionedTransaction {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }
      return tx;
    },
    partialSign(tx: Transaction): void {
      tx.partialSign(keypair);
    },
    signMessageBytes(message: ValidatedLaunchMessage): Uint8Array {
      assertValidatedLaunchMessage(message);
      return ed25519.sign(message.bytes(), keypair.secretKey.slice(0, 32));
    },
  };
}

export function getPlaygroundKeeperSigner(): KeeperSealedSigner | null {
  if (!_loadAttempted) {
    _keeperSigner = loadKeeperKeypair(process.env);
    _loadAttempted = true;
  }
  return _keeperSigner;
}

export function requirePlaygroundKeeperSigner(): KeeperSealedSigner {
  const s = getPlaygroundKeeperSigner();
  if (!s) {
    throw new Error(
      "PLAYGROUND_KEEPER_KEYPAIR (or DEVNET_MINT_AUTHORITY_KEYPAIR) not configured. " +
      "The playground bundled-create flow requires a keeper signing key.",
    );
  }
  return s;
}

export function getPlaygroundKeeperPubkey(): string | null {
  return getPlaygroundKeeperSigner()?.publicKey() ?? null;
}
