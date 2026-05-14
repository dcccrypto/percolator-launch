import { randomBytes } from "node:crypto";

/**
 * Crockford base32 alphabet — 32 characters, intentionally omits:
 *   I (looks like 1)
 *   L (looks like 1)
 *   O (looks like 0)
 *   U (rarely needed; dropping it also avoids the only English vowel that
 *      makes short random strings look like accidental words)
 *
 * 8 characters → 32^8 ≈ 1.1 trillion codes. Collision is astronomically
 * unlikely at any realistic waitlist scale; we still retry on the unique
 * constraint defensively.
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const REFERRAL_CODE_LENGTH = 8;

export function generateReferralCode(length: number = REFERRAL_CODE_LENGTH): string {
  if (length < 4 || length > 64) {
    throw new Error(`generateReferralCode: length must be 4..64, got ${length}`);
  }
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return out;
}

const VALID_CHARS = new Set(CROCKFORD_ALPHABET);

/**
 * Returns true if `s` is a syntactically valid referral code (right length,
 * right alphabet, uppercase). Does NOT check whether the code exists in the DB.
 */
export function isValidReferralCodeShape(s: string): boolean {
  if (typeof s !== "string" || s.length !== REFERRAL_CODE_LENGTH) return false;
  for (const ch of s) {
    if (!VALID_CHARS.has(ch)) return false;
  }
  return true;
}
