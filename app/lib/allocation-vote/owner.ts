/**
 * Solana owner-address syntax check, ported from the local PERC allocation
 * checker (src/base58.js validateOwner). Strict base58, 32-44 chars, decodes to
 * exactly 32 bytes and re-encodes to the same string. Deliberately no ed25519
 * on-curve check: PDAs and smart wallets are valid owners.
 */
import bs58 from "bs58";

const CHARSET_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const OWNER_MESSAGES = {
  type: "Wallet address must be a text string.",
  empty: "Enter a wallet address (input is empty).",
  charset: "Address contains invalid characters (base58 only: no 0, O, I, l, spaces or symbols).",
  length: "Address length must be 32 to 44 characters.",
  decoded_length: "Address must decode to exactly 32 bytes.",
} as const;

export type OwnerReason = keyof typeof OWNER_MESSAGES;
export type OwnerResult = { ok: true; owner: string } | { ok: false; reason: OwnerReason; message: string };

const fail = (reason: OwnerReason): OwnerResult => ({ ok: false, reason, message: OWNER_MESSAGES[reason] });

export function validateOwner(input: unknown): OwnerResult {
  if (typeof input !== "string") return fail("type");
  if (input.length > 256) return fail("length");
  const s = input.trim();
  if (s === "") return fail("empty");
  if (!CHARSET_RE.test(s)) return fail("charset");
  if (s.length < 32 || s.length > 44) return fail("length");
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(s);
  } catch {
    return fail("charset");
  }
  if (bytes.length !== 32 || bs58.encode(bytes) !== s) return fail("decoded_length");
  return { ok: true, owner: s };
}
