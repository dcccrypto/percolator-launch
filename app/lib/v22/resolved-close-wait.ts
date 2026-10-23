/**
 * SEC-RC §S16AC Info I-S1: the S1-6 a/c "waiting for the other side" close (engine e59aa6a6).
 *
 * With that engine, a winner on a Resolved market WITHOUT vault cover who closes before the losing side has settled is
 * refused with EngineLockActive (Custom 21): e59aa6a6 src/v16.rs:24542 returns LockActive from the resolved close, mapped
 * to wrapper EngineLockActive = 21 (wrapper 367e3d08 src/v16_program.rs:2023), and the whole transaction reverts. The
 * refusal clears once the loss side closes; if it never acts, anyone can force-close it after the market's force-close
 * delay (at most 10,000,000 slots, v16_program.rs:859). That is not an error the user can fix, so the app shows one calm
 * line instead.
 *
 * GATED ON THE DEPLOYED ENGINE. No build exposes a version byte, so (as lib/program-upgrade-detect.ts does) the app reads
 * the first 4096 ELF bytes of the deployed wrapper and compares their sha256 with the known S1-6 a/c builds
 * (~/percolator-ops/ledger/v22-release-push-2026-10-20/RC-S16AC.md §2 / §8.1, canonical double builds):
 *   rc-s16ac-build1.so        ddd5a2fa…89fa5  first 4096 B sha256 4613f80e…ac61  (wrapper 367e3d08)
 *   rollback-s16ac-build1.so  bae71e12…5c20   first 4096 B sha256 0c5eb29e…1fda  (wrapper 0e8bb0c9; same engine)
 *   rc2-s16ac-build1.so       4fe8fd53…ac16   first 4096 B sha256 7d4d6e56…fe2d  (wrapper 7f368f0e; RC2.md §3)
 *   rollback2-s16ac-build1.so b6aec357…45e1   first 4096 B sha256 d957421d…b4ef  (wrapper 9e54004c; same engine)
 *   rc22-s16ac-build1.so     776d2491…13f1   first 4096 B sha256 29c9f500…b0e4  (RC2.2, canonical per decision Option B, 2026-10-22)
 *   rollback4b-s16ac-build1.so 3958c36b…3bfc  first 4096 B sha256 5f364f92…36a5  (same engine)
 * The plain RC2.2 twins (rc22 9b630735 / rollback4b 71a891b9) are engine 1c96c22f and must read OFF.
 * POSITIVE match only, and only for the devnet v2.2 wrapper id. Anything else (RC 357fc23f / rollback fac4d19c, RC2
 * cc720a0e / rollback2 8b57d488, today's build, a failed read) keeps today's behaviour: the refused close reads "Your
 * payout will be ready shortly". THE GATE MUST MATCH THE BUILD THAT IS FINALLY DEPLOYED: any other S1-6 a/c build must
 * add its fingerprint here in the runbook step that deploys it.
 *
 * Pure apart from `resolvedCloseWaitLive` (one cached RPC read, raced against a timeout).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { DEVNET_V22_PROGRAM_IDS } from "@/lib/program-ids";
import { ELF_FINGERPRINT_LEN, readElfPrefix, sha256Hex } from "@/lib/program-upgrade-detect";

/** Wrapper EngineLockActive: on a Resolved market's own close, the S1-6 a/c wait. */
export const RESOLVED_CLOSE_WAIT_CODE = 21;

/** The one calm line: what is happening and that the close will go through. Not an error. */
export const RESOLVED_CLOSE_WAIT_COPY =
  "This market is waiting for the other side to settle. Your close will go through after that.";

/** sha256 of the first 4096 ELF bytes of each known S1-6 a/c build, per wrapper program id. */
export const S16AC_WRAPPER_ELF_PREFIX_SHA256: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [DEVNET_V22_PROGRAM_IDS.wrapper]: Object.freeze([
    "4613f80ecbab0d2157e16005ad08ad332d291f14f3329bce6dfaded47ce0ac61", // rc-s16ac-build1.so (367e3d08)
    "0c5eb29e16466c52551697118d9f2e7e5a372b4815c7dbb272dcfa0332551fda", // rollback-s16ac-build1.so (0e8bb0c9)
    "7d4d6e5687d67ec1b1e106f2064ea2f249cb3074927426e25f19c1025365fe2d", // rc2-s16ac-build1.so (7f368f0e) — the RC2 variant
    "d957421dad0766aec7ec8fb595db48fe9ef683a71d74503066c545a21df1b4ef", // rollback2-s16ac-build1.so (9e54004c)
    "29c9f50049d60617098c1624045aa4069e2f282891ca91e1d830e7cf9386b0e4", // rc22-s16ac-build1.so (776d2491) — canonical RC2.2
    "5f364f924c39e2f1c6870ca6b26f7c741f2d52768aad9ed3d9a81e5c5c0336a5", // rollback4b-s16ac-build1.so (3958c36b)
  ]),
});

export type S16acState = "s16ac" | "other" | "unknown";

/** Pure: classify a wrapper's first ELF bytes. An unlisted program id is "other"; a short / zeroed prefix "unknown". */
export async function classifyS16acElfPrefix(programId: string, prefix: Uint8Array | null): Promise<S16acState> {
  const known = S16AC_WRAPPER_ELF_PREFIX_SHA256[programId];
  if (!known) return "other";
  if (!prefix || prefix.length !== ELF_FINGERPRINT_LEN || prefix.every((b) => b === 0)) return "unknown";
  return known.includes(await sha256Hex(prefix)) ? "s16ac" : "other";
}

const TTL_MS = 60_000;
const FAIL_TTL_MS = 15_000;
const READ_TIMEOUT_MS = 5_000;
const cache = new Map<string, { v: S16acState; ts: number }>();
let override: boolean | null = null;

/** Test seam: force the gate (`null` = read the chain). */
export function __setResolvedCloseWaitForTest(v: boolean | null): void {
  override = v;
}
/** Tests only. */
export function __resetResolvedCloseWaitCache(): void {
  cache.clear();
}

/**
 * Is the deployed wrapper a known S1-6 a/c build? Cached 60 s (a failed read 15 s). Unknown -> false (today's copy).
 * Never throws.
 */
export async function resolvedCloseWaitLive(connection: Pick<Connection, "getAccountInfo">, wrapperProgramId: PublicKey | string): Promise<boolean> {
  if (override !== null) return override;
  const id = typeof wrapperProgramId === "string" ? wrapperProgramId : wrapperProgramId.toBase58();
  if (!S16AC_WRAPPER_ELF_PREFIX_SHA256[id]) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.ts < (hit.v === "unknown" ? FAIL_TTL_MS : TTL_MS)) return hit.v === "s16ac";
  let v: S16acState;
  try {
    v = await Promise.race([
      (async () => classifyS16acElfPrefix(id, await readElfPrefix(connection as Connection, new PublicKey(id))))(),
      new Promise<S16acState>((resolve) => setTimeout(() => resolve("unknown"), READ_TIMEOUT_MS)),
    ]);
  } catch {
    v = "unknown";
  }
  cache.set(id, { v, ts: Date.now() });
  return v === "s16ac";
}

/**
 * A resolved close refused in simulation is the S1-6 a/c wait: Custom(21) raised by the CloseResolved instruction itself
 * (`wrapperIxIndex`, so a 21 from another program in the same tx never counts), with the gate live.
 */
export function isResolvedCloseWait(refusal: { index: number; code: number } | null, wrapperIxIndex: number, gateLive: boolean): boolean {
  return gateLive && refusal !== null && refusal.code === RESOLVED_CLOSE_WAIT_CODE && refusal.index === wrapperIxIndex;
}
