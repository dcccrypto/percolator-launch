/**
 * Ed25519 verification of a signed vote message (Solana signMessage: the
 * wallet signs the raw UTF-8 bytes). Pure, no env, no I/O.
 *
 * Strict: canonical base58 for both key and signature, exactly 32/64 bytes,
 * and the scalar S must be < L (tweetnacl alone accepts some malleated
 * signatures; we refuse them so one vote has exactly one valid signature).
 */
import bs58 from "bs58";
import nacl from "tweetnacl";

/** Ed25519 group order L (RFC 8032), little-endian bytes. */
const L_BYTES = [
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];
const L = L_BYTES.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);

export function decodeCanonical(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 100 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return null;
  let b: Uint8Array;
  try {
    b = bs58.decode(s);
  } catch {
    return null;
  }
  if (b.length !== len || bs58.encode(b) !== s) return null;
  return b;
}

function scalarBelowL(sig: Uint8Array): boolean {
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
  return s < L;
}

/** Signature bytes when `signatureB58` is a valid signature of `message` by `wallet`, else null. */
export function verifyVoteSignature(wallet: string, message: string, signatureB58: unknown): Uint8Array | null {
  const pk = decodeCanonical(wallet, 32);
  const sig = decodeCanonical(signatureB58, 64);
  if (!pk || !sig || !scalarBelowL(sig)) return null;
  let ok = false;
  try {
    // Uint8Array.from: tweetnacl checks instanceof, which fails across JS realms.
    ok = nacl.sign.detached.verify(Uint8Array.from(new TextEncoder().encode(message)), Uint8Array.from(sig), Uint8Array.from(pk));
  } catch {
    ok = false;
  }
  return ok ? sig : null;
}
