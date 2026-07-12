import type { PublicKey } from "@solana/web3.js";
import { getAllProgramIds, getConfig } from "@/lib/config";

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

/**
 * Throws unless `matcherProgram` is EXACTLY the configured matcher program for
 * the current network.
 *
 * The v17 trade/batch-trade instructions take the matcher program as account
 * [4] — an executable CPI target — and the matcher context as account [5], a
 * WRITABLE account. Both are read from the LP portfolio's on-chain matcher
 * config, which the LP sets. For an attacker-CREATED market the attacker is
 * the LP and controls those bytes, so without this check a victim trading
 * that market would sign a tx whose wrapper CPIs into an attacker-chosen
 * program with an attacker-writable context. `assertKnownProgram` is too
 * loose here — it accepts ANY deployed program (wrapper/vault/nft/matcher),
 * so it wouldn't reject swapping the matcher for, say, the wrapper id. This
 * pins it to the one canonical matcher. Every legitimate market uses it, so
 * this is free for honest flows and removes the arbitrary-CPI-target
 * property entirely.
 *
 * Generic error + no echo, same rationale as `assertKnownProgram`.
 */
export function assertCanonicalMatcher(matcherProgram: PublicKey | string | null | undefined): void {
  const canonical = getConfig().matcherProgramId as string | undefined;
  const idStr =
    matcherProgram == null
      ? null
      : typeof matcherProgram === "string"
        ? matcherProgram
        : matcherProgram.toBase58();
  if (canonical && idStr && idStr === canonical) return;
  if (process.env.NODE_ENV !== "production") {
    console.error(
      `[assertCanonicalMatcher] Refusing to build a trade whose matcher program ` +
        `(${idStr ?? "<null>"}) is not the canonical matcher (${canonical ?? "<unset>"}).`,
    );
  }
  throw new Error(
    "This market's matcher is not the recognized Percolator matcher program. Refusing to build a transaction.",
  );
}
