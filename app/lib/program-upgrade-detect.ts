/**
 * Has the devnet "matcher inventory sync + non-bound NAV floor" upgrade landed?
 *
 * Runbook: ~/percolator-ops/ledger/deploy-runbook-matcher-sync-2026-10-03.md. Two in-place upgrades
 * at the SAME program ids: matcher EDKKgRaV (4a0f696 -> b5b419da, first) and wrapper ETDLAdi
 * (553d76f0/cc5095fb -> the fix/matcher-inventory-sync head, second; rebuilt several times). Neither exposes a version byte or
 * a ctx-layout change, so the app reads the PROGRAM BYTES: the first 4096 bytes of each program's
 * ELF (programdata offset 45; the ELF header encodes the section-table offset, i.e. the file size,
 * so any rebuild of different code differs here) are hashed and compared with the PRE-upgrade
 * build that is live today (verified read-only against devnet 2026-10-03):
 *
 *   wrapper f2fbf36d...5e43 (cc5095fb)  first 4096 B sha256 af1cbc11...8e2b
 *   matcher 7d16a4b4...1422 (4a0f696)   first 4096 B sha256 76ff4adb...13ab
 *
 * "pre"  = still exactly those bytes (also what a rollback restores).
 * "post" = different bytes. Detection deliberately keys ONLY on "not the old build": the shipping
 *          wrapper has been rebuilt several times (7a3ac04c -> bc228e1b H-1 -> impairment-ratio
 *          pause + inline(never)), so no post-upgrade hash is pinned anywhere in the app.
 * "unknown" = the read failed. Every caller treats unknown exactly like "pre" (conservative).
 *
 * Only the devnet relaunch ids are probed; any other program id (mainnet, a test program) is "pre":
 * a mainnet build does not carry the sync (`matcher_takes_lp_position` is devnet-only, L-2).
 *
 * Override (build-time): NEXT_PUBLIC_MATCHER_SYNC_UPGRADE = "pre" | "post" | "auto" (default).
 *
 * NOTE: ANY later wrapper/matcher deploy will also read as "post". Revisit this module (move the
 * pre fingerprints forward, or retire it) before the next program deploy.
 *
 * Freshness around the cutover: results are cached 45 s (a failed or timed-out read 15 s); every
 * read is raced against READ_TIMEOUT_MS so a hung RPC can never wedge the callers, and an Earn tx
 * refused with 91 / 25 calls `invalidateUpgradeDetection()` and rebuilds once with fresh state.
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

const TTL_MS = 45_000;
const FAIL_TTL_MS = 15_000;
/** A detection read that has not answered by then is "unknown" (treated as pre). */
export const READ_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("upgrade-detect read timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
const cache = new Map<string, { v: UpgradeState; ts: number }>();
const inflight = new Map<string, Promise<UpgradeState>>();

/** One program's state (cached 45 s; a failed / timed-out read is retried after 15 s). */
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
      v = await withTimeout(
        (async () => classifyElfPrefix(id, await readElfPrefix(connection, new PublicKey(id))))(),
        READ_TIMEOUT_MS,
      );
    } catch {
      v = "unknown";
    } finally {
      inflight.delete(id);
    }
    cache.set(id, { v, ts: Date.now() });
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

/**
 * Drop every cached detection result (and any in-flight read) so the next call re-reads the
 * program bytes. Called when an Earn tx is refused with 91 / 25: around the cutover that refusal
 * is exactly the symptom of building against the other program version.
 */
export function invalidateUpgradeDetection(): void {
  cache.clear();
  inflight.clear();
}

/** Tests only. */
export function __resetUpgradeDetectCache(): void {
  cache.clear();
  inflight.clear();
}
