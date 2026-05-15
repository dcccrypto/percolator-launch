import type { PublicKey } from "@solana/web3.js";
import { getAllProgramIds } from "@/lib/config";

/**
 * Returns true iff `programId` is one of the deployed program IDs for the
 * currently selected network. Null/undefined returns false — callers should
 * treat "not yet loaded" as "not safe to sign".
 *
 * The set is computed from `getAllProgramIds()` (config.programId plus every
 * entry in `programsBySlabTier`). Adding a new tier in config automatically
 * extends the allowlist — no code change here.
 */
export function isKnownProgram(programId: PublicKey | string | null | undefined): boolean {
  if (!programId) return false;
  const idStr = typeof programId === "string" ? programId : programId.toBase58();
  return getAllProgramIds().includes(idStr);
}

/**
 * Throws if `programId` is not one of the deployed programs. Use at the top
 * of any hook that builds a transaction whose `programId` is derived from
 * on-chain state via `useSlabState()`.
 *
 * The thrown message is intentionally generic and does NOT echo the bad
 * program ID — that would confirm to a phishing attacker that their URL
 * reached a victim's browser. The bad ID is logged to the console in dev.
 */
export function assertKnownProgram(programId: PublicKey | string | null | undefined): void {
  if (isKnownProgram(programId)) return;
  if (process.env.NODE_ENV !== "production") {
    const idStr =
      programId == null
        ? "<null>"
        : typeof programId === "string"
          ? programId
          : programId.toBase58();
    console.error(
      `[assertKnownProgram] Refusing to build tx for unknown program: ${idStr}. ` +
        `Allowed: ${getAllProgramIds().join(", ")}`,
    );
  }
  throw new Error(
    "This market is not owned by a recognized Percolator program. Refusing to build a transaction.",
  );
}
