/**
 * Has the devnet "matcher inventory sync + non-bound NAV floor" upgrade landed?
 *
 * Runbook: ~/percolator-ops/ledger/deploy-runbook-matcher-sync-2026-10-03.md. Two in-place upgrades
 * at the SAME program ids: matcher EDKKgRaV (4a0f696 -> b5b419da, first) and wrapper ETDLAdi
 * (553d76f0/cc5095fb -> 7a3ac04c or its H-1 successor, second). Neither exposes a version byte or
 * a ctx-layout change, so the app reads the PROGRAM BYTES: the first 4096 bytes of each program's
 * ELF (programdata offset 45; the ELF header encodes the section-table offset, i.e. the file size,
 * so any rebuild of different code differs here) are hashed and compared with the PRE-upgrade
 * build that is live today (verified read-only against devnet 2026-10-03):
 *
 *   wrapper f2fbf36d...5e43 (cc5095fb)  first 4096 B sha256 af1cbc11...8e2b
 *   matcher 7d16a4b4...1422 (4a0f696)   first 4096 B sha256 76ff4adb...13ab
 *
 * "pre"  = still exactly those bytes (also what a rollback restores).
 * "post" = different bytes. Detecting by "not the old build" rather than "equals the new hash"
 *          is deliberate: the wrapper that ships is the H-1 successor of 7a3ac04c (security review
 *          2026-10-03), whose hash does not exist yet.
 * "unknown" = the read failed. Every caller treats unknown exactly like "pre" (conservative).
 *
 * Only the devnet relaunch ids are probed; any other program id (mainnet, a test program) is "pre":
 * a mainnet build does not carry the sync (`matcher_takes_lp_position` is devnet-only, L-2).
 *
 * Override (build-time): NEXT_PUBLIC_MATCHER_SYNC_UPGRADE = "pre" | "post" | "auto" (default).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";

export type UpgradeState = "pre" | "post" | "unknown";

export const ELF_FINGERPRINT_LEN = 4096;
/** BPF upgradeable loader ProgramData header: 4 (tag) + 8 (slot) + 1 + 32 (authority option). */
export const PROGRAMDATA_ELF_OFFSET = 45;

export const PRE_SYNC_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  [DEVNET_PROGRAM_IDS.wrapper]: "af1cbc1101def37482ccca11cedbf56dcca2ebece8572f2d4195c64309cb8e2b",
  [DEVNET_PROGRAM_IDS.matcher]: "76ff4adbd30acaeddc71f64726e30fda58b0f05c1a3d2e35ddf3520e714813ab",
});

/** For tests / the runbook: the first-4096 fingerprints of the built upgrade artifacts. */
export const KNOWN_POST_SYNC_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  // wrapper 7a3ac04c build 3a46ffac (NOT the one that ships: H-1 successor pending)
  [DEVNET_PROGRAM_IDS.wrapper]: "53f1bcf775b60ca33ac06363f43f7c24b18752e073bad53bb7e478b40dc0e568",
  // matcher b5b419da build e0fe9a6a
  [DEVNET_PROGRAM_IDS.matcher]: "23b91fe4a4590b65b4869adf3c10232b04edfe63803cab55d065f03015fa86f9",
});

function overrideMode(): "pre" | "post" | null {
  const v = process.env.NEXT_PUBLIC_MATCHER_SYNC_UPGRADE;
  return v === "pre" || v === "post" ? v : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto unavailable");
  const buf = new Uint8Array(bytes).buffer;
  const d = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pure: classify a program's first ELF bytes against its pre-upgrade fingerprint. */
export async function classifyElfPrefix(programId: string, elfPrefix: Uint8Array | null): Promise<UpgradeState> {
  const pre = PRE_SYNC_FINGERPRINTS[programId];
  if (!pre) return "pre";
  if (!elfPrefix || elfPrefix.length !== ELF_FINGERPRINT_LEN) return "unknown";
  // An all-zero prefix is a closed / never-written programdata, not a new build.
  if (elfPrefix.every((b) => b === 0)) return "unknown";
  return (await sha256Hex(elfPrefix)) === pre ? "pre" : "post";
}

async function readElfPrefix(connection: Connection, programId: PublicKey): Promise<Uint8Array | null> {
  const prog = await connection.getAccountInfo(programId, "confirmed");
  if (!prog || prog.data.length < 36) return null;
  const programData = new PublicKey(new Uint8Array(prog.data).subarray(4, 36));
  const pd = await connection.getAccountInfo(programData, {
    commitment: "confirmed",
    dataSlice: { offset: PROGRAMDATA_ELF_OFFSET, length: ELF_FINGERPRINT_LEN },
  });
  return pd ? new Uint8Array(pd.data) : null;
}

const TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000;
const cache = new Map<string, { v: UpgradeState; ts: number }>();
const inflight = new Map<string, Promise<UpgradeState>>();

/** One program's state (cached 5 min; a failed read is retried after 30 s). */
export function programUpgradeState(connection: Connection, programId: PublicKey | string): Promise<UpgradeState> {
  const id = typeof programId === "string" ? programId : programId.toBase58();
  const forced = overrideMode();
  if (forced) return Promise.resolve(PRE_SYNC_FINGERPRINTS[id] ? forced : "pre");
  if (!PRE_SYNC_FINGERPRINTS[id]) return Promise.resolve("pre");
  const hit = cache.get(id);
  if (hit && Date.now() - hit.ts < (hit.v === "unknown" ? FAIL_TTL_MS : TTL_MS)) return Promise.resolve(hit.v);
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    let v: UpgradeState;
    try {
      v = await classifyElfPrefix(id, await readElfPrefix(connection, new PublicKey(id)));
    } catch {
      v = "unknown";
    }
    cache.set(id, { v, ts: Date.now() });
    inflight.delete(id);
    return v;
  })();
  inflight.set(id, p);
  return p;
}

/**
 * The NON-BOUND Earn NAV floor (and the 75 refusal 91) is live: the wrapper has been upgraded.
 * Unknown -> false (keep today's fail-closed maths and the repair prefix the live program needs).
 */
export async function earnNavFloorLive(connection: Connection, wrapperProgramId: PublicKey | string): Promise<boolean> {
  return (await programUpgradeState(connection, wrapperProgramId)) === "post";
}

/**
 * The matcher prices / caps from the LP's REAL engine position: BOTH programs upgraded (the new
 * wrapper sends the v2 ext only to the canonical matcher, which must already understand it) and
 * this LP's configured matcher IS the canonical one. Anything unknown -> false.
 */
export async function matcherLpSyncLive(
  connection: Connection,
  wrapperProgramId: PublicKey | string,
  lpMatcherProgram: PublicKey | string | null,
): Promise<boolean> {
  const wrapper = typeof wrapperProgramId === "string" ? wrapperProgramId : wrapperProgramId.toBase58();
  const lpMatcher = lpMatcherProgram === null ? null : typeof lpMatcherProgram === "string" ? lpMatcherProgram : lpMatcherProgram.toBase58();
  if (wrapper !== DEVNET_PROGRAM_IDS.wrapper || lpMatcher !== DEVNET_PROGRAM_IDS.matcher) return false;
  const [w, m] = await Promise.all([programUpgradeState(connection, wrapper), programUpgradeState(connection, lpMatcher)]);
  return w === "post" && m === "post";
}

/** Tests only. */
export function __resetUpgradeDetectCache(): void {
  cache.clear();
  inflight.clear();
}
