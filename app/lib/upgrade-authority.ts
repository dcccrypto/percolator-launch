/**
 * GH#2014 / GH#1823 — Program upgrade authority classification (pure, no web3).
 *
 * Chain I/O lives in scripts/check-upgrade-authority.ts.
 */

/** Squads V4 program (mainnet + devnet). */
export const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/** System Program — owner of plain keypair accounts. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** Documented deploy authority still on mainnet (GH#1823, GH#2014). */
export const MAINNET_EOA_UPGRADE_AUTHORITY =
  "7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G";

/** Documented devnet upgrade authority (pre-Squads migration). */
export const DEVNET_EOA_UPGRADE_AUTHORITY =
  "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x";

export const MAINNET_PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

export const DEVNET_PROGRAM_ID = "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in";

export type UpgradeAuthorityKind =
  | "squads_multisig"
  | "known_eoa"
  | "other_eoa"
  | "immutable"
  | "missing_program_data";

export type UpgradeAuthorityAssessment = {
  programId: string;
  authority: string | null;
  authorityOwner: string | null;
  kind: UpgradeAuthorityKind;
  safe: boolean;
  message: string;
};

/** ProgramData layout: [u32 type][u64 slot][Option<Pubkey> upgrade_authority]. */
export const PROGRAM_DATA_AUTHORITY_OPTION_OFFSET = 12;
export const PROGRAM_DATA_AUTHORITY_PUBKEY_OFFSET = 13;

/** Read base58 upgrade authority from raw ProgramData account bytes. */
export function parseUpgradeAuthorityBase58(data: Uint8Array): string | null {
  if (data.length < PROGRAM_DATA_AUTHORITY_PUBKEY_OFFSET + 32) return null;
  const hasAuthority = data[PROGRAM_DATA_AUTHORITY_OPTION_OFFSET] === 1;
  if (!hasAuthority) return null;
  const bytes = data.subarray(
    PROGRAM_DATA_AUTHORITY_PUBKEY_OFFSET,
    PROGRAM_DATA_AUTHORITY_PUBKEY_OFFSET + 32,
  );
  return base58Encode(bytes);
}

/** Minimal base58 encoder for 32-byte pubkeys (no @solana/web3.js dependency). */
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const size = Math.floor(((bytes.length - zeros) * 138) / 100 + 1);
  const b58 = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }

  let it = size - length;
  while (it < size && b58[it] === 0) it++;

  let str = "1".repeat(zeros);
  for (; it < size; it++) str += ALPHABET[b58[it]];
  return str;
}

export function classifyUpgradeAuthority(
  authority: string | null,
  authorityOwner: string | null,
): UpgradeAuthorityKind {
  if (!authority) return "immutable";
  if (authorityOwner === SQUADS_V4_PROGRAM_ID) return "squads_multisig";
  if (
    authority === MAINNET_EOA_UPGRADE_AUTHORITY ||
    authority === DEVNET_EOA_UPGRADE_AUTHORITY
  ) {
    return "known_eoa";
  }
  if (authorityOwner === SYSTEM_PROGRAM_ID) return "other_eoa";
  return "other_eoa";
}

export function assessUpgradeAuthority(input: {
  programId: string;
  authority: string | null;
  authorityOwner: string | null;
}): UpgradeAuthorityAssessment {
  const kind = classifyUpgradeAuthority(input.authority, input.authorityOwner);

  switch (kind) {
    case "squads_multisig":
      return {
        ...input,
        kind,
        safe: true,
        message: "Upgrade authority is a Squads vault (threshold-gated).",
      };
    case "immutable":
      return {
        ...input,
        kind,
        safe: true,
        message: "Program is immutable (no upgrade authority).",
      };
    case "known_eoa":
      return {
        ...input,
        kind,
        safe: false,
        message:
          "CRITICAL: upgrade authority is a documented single EOA. Transfer to Squads per docs/SQUADS-SETUP.md.",
      };
    case "other_eoa":
      return {
        ...input,
        kind,
        safe: false,
        message:
          "CRITICAL: upgrade authority is a single keypair (System Program owner). Use Squads multisig.",
      };
    case "missing_program_data":
      return {
        ...input,
        kind,
        safe: false,
        message: "Could not read ProgramData account for this program ID.",
      };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
