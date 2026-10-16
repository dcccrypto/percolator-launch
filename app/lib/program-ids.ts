/**
 * THE single source of truth for on-chain program IDs.
 *
 * Repointing the app to a new deployment is ONE edit: DEVNET_PROGRAM_IDS below. The
 * 2026-10 relaunch is ALL-FRESH (wrapper, matcher, nft and stake all new devnet addresses,
 * @percolatorct/sdk 8.0.0); the old GnwdeQr world (matcher 4seJWjv3…, stake GCHhcgw…,
 * nft CNGBPZR…) is abandoned. Everything
 * else — config.ts (`programId`, `programsBySlabTier`, the known-program
 * allowlist), the markets static fallback, the warmup route, the NFT/stake
 * helpers, the error map's program routing — reads from here.
 * `__tests__/lib/program-ids.test.ts` fails if the SDK's own default devnet
 * wrapper id and this file disagree, so an SDK bump without the repoint (or
 * the reverse) cannot ship silently.
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
  // ALL-FRESH relaunch (2026-10, wrapper 7c906e45 / SDK 8.0.0; 592286b4, the 2026-09-30 in-place upgrade, is its ancestor): every program at a new address.
  wrapper: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  matcher: "EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX",
  nft: "EMYT15LZWaP7Mmmm245kQPbrTyVjG16yZiU9kfNTF3GZ",
  stake: "VmpVUArRnVkrjaPXQ2qaqCQa3ZrZFgsz7rjeALitF5w",
});

/**
 * Devnet v2.2 fresh-ID set (deployed 2026-10-10; ledger v22-devnet-fresh-2026-10-10.md). Kept as one set: wrapper
 * 6kpg2wi7 pins nft 27LWmR72 in SetNftProgramId, so pairing it with the v2 nft EMYT15LZ answers Custom 9 and the create
 * wizard silently fell back to step-by-step signing (QA E2E-1).
 */
export const DEVNET_V22_PROGRAM_IDS: Readonly<ProgramIdSet> = Object.freeze({
  wrapper: "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM",
  matcher: "AsHvEJ8zNctKmdeS57H5E4w6nkTLi3bPVpd6ZCLc2ayN",
  nft: "27LWmR72Ru1NCkbN2xgxB7BgYcTUrU7qeEJoV3D8sZh1",
  stake: "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V",
});

/** The program set each known devnet wrapper was deployed with (and pins). An unknown wrapper (a local fork) keeps DEVNET_PROGRAM_IDS. */
const PAIRED_SETS: Readonly<Record<string, Readonly<ProgramIdSet>>> = Object.freeze({
  [DEVNET_PROGRAM_IDS.wrapper]: DEVNET_PROGRAM_IDS,
  [DEVNET_V22_PROGRAM_IDS.wrapper]: DEVNET_V22_PROGRAM_IDS,
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

/**
 * Devnet program ids after env overrides. Pure function of build-time env. A program without an override defaults to the
 * one the resolved WRAPPER pins (QA E2E-1: a build pointing the wrapper at 6kpg2wi7 without NEXT_PUBLIC_NFT_PROGRAM_ID
 * signed SetNftProgramId with the v2 nft and was refused).
 */
export function resolveDevnetProgramIds(): ProgramIdSet {
  if (isMainnetBuild() || !overridesAllowed()) return { ...DEVNET_PROGRAM_IDS };
  const wrapper =
    parseProgramIdOverride("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", process.env.NEXT_PUBLIC_WRAPPER_PROGRAM_ID) ??
    DEVNET_PROGRAM_IDS.wrapper;
  const paired = PAIRED_SETS[wrapper] ?? DEVNET_PROGRAM_IDS;
  return {
    wrapper,
    matcher:
      parseProgramIdOverride("NEXT_PUBLIC_MATCHER_PROGRAM_ID", process.env.NEXT_PUBLIC_MATCHER_PROGRAM_ID) ??
      paired.matcher,
    nft:
      parseProgramIdOverride("NEXT_PUBLIC_NFT_PROGRAM_ID", process.env.NEXT_PUBLIC_NFT_PROGRAM_ID) ??
      paired.nft,
    stake:
      parseProgramIdOverride("NEXT_PUBLIC_STAKE_PROGRAM_ID", process.env.NEXT_PUBLIC_STAKE_PROGRAM_ID) ??
      paired.stake,
  };
}
