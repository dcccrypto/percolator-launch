/**
 * THE single source of truth for on-chain program IDs.
 *
 * Repointing the app to a new deployment is ONE edit: DEVNET_PROGRAM_IDS below.
 * Current pin is the v2.2 fresh-address set deployed 2026-11-06 (ops ledger
 * deployments.md). The 2026-10 relaunch IDs (ETDLAdiA… / EDKKgRaV… / EMYT15LZ…
 * / VmpVUArR…) and the earlier GnwdeQr world are no longer the playground
 * default. Everything else — config.ts (`programId`, `programsBySlabTier`, the
 * known-program allowlist), the markets static fallback, the warmup route, the
 * NFT/stake helpers, the error map's program routing — reads from here.
 * Published @percolatorct/sdk@8.0.0 still defaults to an older devnet set;
 * keep launch pins authoritative here until that SDK is published with the
 * 11-06 IDs (companion PR on percolator-sdk).
 *
 * Env overrides (devnet builds only, and only with
 * NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE=1; a mainnet build ignores them):
 *   NEXT_PUBLIC_WRAPPER_PROGRAM_ID, NEXT_PUBLIC_MATCHER_PROGRAM_ID,
 *   NEXT_PUBLIC_NFT_PROGRAM_ID, NEXT_PUBLIC_STAKE_PROGRAM_ID
 * For a local fork / E2E run against freshly deployed programs. Each must be a
 * valid base58 32-byte key or it is ignored (with a console warning).
 * `NEXT_PUBLIC_*` values are inlined at build time, so they are referenced
 * literally below (Next.js cannot inline a computed `process.env[name]`).
 *
 * Leaf module: no app imports (errorMessages.ts and nft-program.ts import it).
 */
import { PublicKey } from "@solana/web3.js";

export interface ProgramIdSet {
  wrapper: string;
  matcher: string;
  nft: string;
  stake: string;
}

/** Deployed devnet programs (deployments.md). The wrapper line is the repoint. */
export const DEVNET_PROGRAM_IDS: Readonly<ProgramIdSet> = Object.freeze({
  // v2.2 fresh-address set, deployed 2026-11-06. Verified executable on devnet
  // 2026-11-21 via getAccountInfo / solana program show. Collateral mint
  // DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC is already the default in config.ts.
  wrapper: "5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe",
  matcher: "DfTxJUT5BbERs1tR33dP82kaUJ1NLymRxXErXAYXcDam",
  nft: "DWUNq2iYh6Sdgdv3qv7aWJNJGhoK25FqyQrqDUrDD9zs",
  stake: "A6DVNubvzMMETQinK6bipekkaTTrkUu2RMw2kBoJrdkE",
});

export const MAINNET_PROGRAM_IDS: Readonly<Omit<ProgramIdSet, "nft">> = Object.freeze({
  wrapper: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
  matcher: "GDK8wx38kpiSVSfGTVNiSdptX3Z5R4kQyqh6Q3QX6wmi",
  stake: "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F",
});

/** Validate a base58 program id override; null when unset or invalid. */
export function parseProgramIdOverride(name: string, raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const pk = new PublicKey(v);
    if (pk.toBase58() !== v) throw new Error("non-canonical");
    return v;
  } catch {
    console.warn(`[program-ids] ignoring invalid ${name}="${v}"`);
    return null;
  }
}

function isMainnetBuild(): boolean {
  return process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() === "mainnet";
}

/**
 * Overrides also need an explicit opt-in (security review INFO, 2026-09-30), so
 * a stray `NEXT_PUBLIC_*_PROGRAM_ID` in a Vercel project can't silently repoint
 * the playground. Mirrors the SDK's PERCOLATOR_SDK_ALLOW_PROGRAM_OVERRIDE.
 */
function overridesAllowed(): boolean {
  const v = process.env.NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE?.trim();
  return v === "1" || v === "true";
}

/** Devnet program ids after env overrides. Pure function of build-time env. */
export function resolveDevnetProgramIds(): ProgramIdSet {
  if (isMainnetBuild() || !overridesAllowed()) return { ...DEVNET_PROGRAM_IDS };
  return {
    wrapper:
      parseProgramIdOverride("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", process.env.NEXT_PUBLIC_WRAPPER_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.wrapper,
    matcher:
      parseProgramIdOverride("NEXT_PUBLIC_MATCHER_PROGRAM_ID", process.env.NEXT_PUBLIC_MATCHER_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.matcher,
    nft:
      parseProgramIdOverride("NEXT_PUBLIC_NFT_PROGRAM_ID", process.env.NEXT_PUBLIC_NFT_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.nft,
    stake:
      parseProgramIdOverride("NEXT_PUBLIC_STAKE_PROGRAM_ID", process.env.NEXT_PUBLIC_STAKE_PROGRAM_ID) ??
      DEVNET_PROGRAM_IDS.stake,
  };
}
