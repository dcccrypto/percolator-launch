/**
 * The two program worlds the Move flow straddles. v1 = the live ETDLAdi relaunch (close-only after
 * cutover); v2.1 = the fresh-ID deploy (ledger/v21-fresh-ids-2026-10-05.md). v1 ids default to the
 * deployed constants; v2.1 ids come only from NEXT_PUBLIC_V21_* (unset = v2.1 not live: the flow
 * stops at "withdrawn to your wallet"). A v1 step is never built against a non-v1 program and a
 * v2.1 step never against v1: `assertV1Program` / `assertV21Program` throw.
 */
import { PublicKey } from "@solana/web3.js";
import { DEVNET_PROGRAM_IDS, type ProgramIdSet } from "@/lib/program-ids";

export const V1_PROGRAM_IDS: Readonly<ProgramIdSet> = DEVNET_PROGRAM_IDS;

const valid = (v: string | undefined): string | null => {
  const t = v?.trim();
  if (!t) return null;
  try {
    return new PublicKey(t).toBase58() === t ? t : null;
  } catch {
    return null;
  }
};

/** v2.1 program ids from the environment, or null unless all four are valid and none equals a v1 id. */
export function resolveV21ProgramIds(env: {
  wrapper?: string; matcher?: string; nft?: string; stake?: string;
} = {
  wrapper: process.env.NEXT_PUBLIC_V21_WRAPPER_PROGRAM_ID,
  matcher: process.env.NEXT_PUBLIC_V21_MATCHER_PROGRAM_ID,
  nft: process.env.NEXT_PUBLIC_V21_NFT_PROGRAM_ID,
  stake: process.env.NEXT_PUBLIC_V21_STAKE_PROGRAM_ID,
}): ProgramIdSet | null {
  const wrapper = valid(env.wrapper), matcher = valid(env.matcher), nft = valid(env.nft), stake = valid(env.stake);
  if (!wrapper || !matcher || !nft || !stake) return null;
  const v1 = new Set<string>(Object.values(V1_PROGRAM_IDS));
  if ([wrapper, matcher, nft, stake].some((id) => v1.has(id))) return null;
  return { wrapper, matcher, nft, stake };
}

export function isV1Program(programId: string): boolean {
  return programId === V1_PROGRAM_IDS.wrapper;
}

export function assertV1Program(programId: string): void {
  if (!isV1Program(programId)) throw new Error(`Move: ${programId} is not the v1 wrapper`);
}

export function assertV21Program(programId: string, v21: ProgramIdSet | null): void {
  if (!v21 || programId !== v21.wrapper) throw new Error(`Move: ${programId} is not the v2.1 wrapper`);
  if (isV1Program(programId)) throw new Error("Move: refusing a v2.1 step against the v1 wrapper");
}

/** The label shown on v1 markets while the Move flag is on. */
export const V1_CLOSE_ONLY_LABEL = "v1 · close-only";

/** True when the app is looking at the v1 world (the market's program is the v1 wrapper) and Move is on. */
export function isV1CloseOnly(programId: string | null | undefined, enabled: boolean): boolean {
  return enabled && !!programId && isV1Program(programId);
}
