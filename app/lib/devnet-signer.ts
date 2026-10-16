/**
 * Devnet Signer Factory
 *
 * Provides a sealed signer interface for DEVNET_MINT_AUTHORITY_KEYPAIR.
 * The private key is loaded once and sealed - never exposed directly.
 * This centralizes key loading and ensures consistent handling across all devnet endpoints.
 *
 * Pattern mirrors packages/shared/src/sealedKeypair.ts
 */

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import _bs58 from "bs58";
import nacl from "tweetnacl";

// bs58 v6 types vary across module-resolution strategies; cast to avoid CI breakage
const bs58: { encode(buf: Uint8Array): string; decode(str: string): Uint8Array } = _bs58 as any;

/**
 * Sealed signer for devnet mint authority.
 * Never exposes the private key - only provides signing capability.
 */
export interface DevnetSealedSigner {
  /** Public key of the mint authority */
  publicKey(): string;

  /** Sign a transaction */
  signTransaction(tx: Transaction | VersionedTransaction): Transaction | VersionedTransaction;

  /** Sign a message */
  signMessage(message: Uint8Array): Uint8Array;
}

let _devnetSigner: DevnetSealedSigner | null = null;
let _loadAttempted = false;

/**
 * Load and seal the devnet mint authority keypair from environment variable.
 * Returns null if the env var is not set (allows graceful handling for routes that don't need it).
 *
 * @throws Error if DEVNET_MINT_AUTHORITY_KEYPAIR is set but invalid
 */
function loadDevnetSealedKeypair(env: NodeJS.ProcessEnv): DevnetSealedSigner | null {
  const rawKey = env.DEVNET_MINT_AUTHORITY_KEYPAIR;

  // Allow missing key (return null) - some routes might not need it
  if (!rawKey) {
    return null;
  }

  // Key is set - validate it
  let keypair: Keypair;
  try {
    // Try JSON array format first (most common)
    const parsed = JSON.parse(rawKey);
    if (!Array.isArray(parsed) || parsed.length !== 64) {
      throw new Error(`Invalid key: must be 64-byte array, got ${parsed.length} items`);
    }
    const decoded = Uint8Array.from(parsed);
    keypair = Keypair.fromSecretKey(decoded);
  } catch (jsonError) {
    // Try base58 format as fallback
    try {
      const decoded = bs58.decode(rawKey);

      if (decoded.length !== 64) {
        throw new Error(
          `Invalid key length: expected 64 bytes, got ${decoded.length}. ` +
          `Did you paste only the public key instead of the full keypair?`,
        );
      }

      keypair = Keypair.fromSecretKey(decoded);
    } catch (e) {
      throw new Error(
        "❌ Invalid DEVNET_MINT_AUTHORITY_KEYPAIR format.\n" +
        "Must be either:\n" +
        "  1. JSON array of 64 bytes: [1, 2, 3, ..., 64]\n" +
        "  2. Base58-encoded secret key (44-88 characters)",
      );
    }
  }

  // Return sealed signer (key is sealed in closure, never exposed)
  return createDevnetSealedSigner(keypair, env.DEVNET_SIGNER_AUDIT_LOG === "1");
}

/**
 * Create a sealed signer from a keypair.
 * The keypair is kept in the closure and never exposed.
 */
function createDevnetSealedSigner(keypair: Keypair, auditEnabled: boolean): DevnetSealedSigner {
  const publicKeyString = keypair.publicKey.toBase58();

  return {
    publicKey(): string {
      return publicKeyString;
    },

    signTransaction(tx: Transaction | VersionedTransaction): Transaction | VersionedTransaction {
      if (auditEnabled) {
        console.log(`[AUDIT] Devnet mint authority signing transaction`);
      }

      // Sign the transaction.
      // Use partialSign (not sign) for Transaction so that other required signers'
      // partial signatures already present in the signatures array are preserved.
      // tx.sign() wipes all existing signatures before re-signing, which breaks
      // multi-signer flows (e.g. devnet-mirror-mint where mintKeypair also signs).
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }

      return tx;
    },

    signMessage(message: Uint8Array): Uint8Array {
      if (auditEnabled) {
        console.log(`[AUDIT] Devnet mint authority signing message (${message.length} bytes)`);
      }

      return nacl.sign.detached(message, keypair.secretKey);
    },
  };
}

/**
 * Get the sealed devnet mint authority signer.
 * Loads the keypair from DEVNET_MINT_AUTHORITY_KEYPAIR env var on first call.
 * Subsequent calls return the same sealed signer.
 * Returns null if the env var is not configured.
 *
 * @throws Error if DEVNET_MINT_AUTHORITY_KEYPAIR is set but invalid
 */
export function getDevnetMintSigner(): DevnetSealedSigner | null {
  if (!_loadAttempted) {
    _devnetSigner = loadDevnetSealedKeypair(process.env);
    _loadAttempted = true;
  }
  return _devnetSigner;
}

/**
 * Get the devnet mint authority public key (string).
 * Safe to log/display (no private key exposure).
 * Returns null if not configured.
 */
export function getDevnetMintPublicKey(): string | null {
  const signer = getDevnetMintSigner();
  return signer ? signer.publicKey() : null;
}

/**
 * Validate that the devnet mint signer is configured.
 * Use this in route handlers to check if minting is available.
 *
 * @throws Error if mint signer is not configured
 */
export function requireDevnetMintSigner(): DevnetSealedSigner {
  const signer = getDevnetMintSigner();
  if (!signer) {
    throw new Error(
      "❌ DEVNET_MINT_AUTHORITY_KEYPAIR not configured. " +
      "Minting endpoints require this environment variable.",
    );
  }
  return signer;
}
