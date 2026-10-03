/**
 * Upgrade detection for the matcher-inventory-sync + NAV-floor deploy (lib/program-upgrade-detect.ts).
 * Fixtures are the first 4096 bytes of the REAL ELFs (~/percolator-ops/artifacts/matcher-sync-2026-10-03):
 * the live/rollback builds (wrapper f2fbf36d, matcher 7d16a4b4; == devnet on-chain 2026-10-03, read-only
 * check) and EARLIER upgrade builds (wrapper 3a46ffac @ 7a3ac04c, superseded; matcher e0fe9a6a @
 * b5b419da). The app pins no post-upgrade hash: any build whose prefix differs from the pre one is
 * "post", so the final wrapper artifact is detected without a code change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ELF_FINGERPRINT_LEN,
  PRE_SYNC_FINGERPRINTS,
  PROGRAMDATA_ELF_OFFSET,
  READ_TIMEOUT_MS,
  __resetUpgradeDetectCache,
  invalidateUpgradeDetection,
  classifyElfPrefix,
  earnNavFloorLive,
  matcherLpSyncLive,
  programUpgradeState,
} from "@/lib/program-upgrade-detect";
import { DEVNET_PROGRAM_IDS, MAINNET_PROGRAM_IDS } from "@/lib/program-ids";

const fx = (f: string) => new Uint8Array(readFileSync(join(process.cwd(), "__tests__/fixtures/upgrade-detect", f)));
const W_PRE = fx("wrapper-f2fbf36d-pre.bin");
const W_POST = fx("wrapper-3a46ffac-7a3ac04c.bin");
const M_PRE = fx("matcher-7d16a4b4-pre.bin");
const M_POST = fx("matcher-e0fe9a6a-b5b419d.bin");
/** The H-1 wrapper artifact (bc228e1b, 45e24eb3; prefix d3b7bdff…d9e8) — itself superseded. */
const W_H1 = fx("wrapper-bc228e1b.bin");
const W = DEVNET_PROGRAM_IDS.wrapper;
const M = DEVNET_PROGRAM_IDS.matcher;

/** A connection whose two programs point at programdata holding `elf[id]` (sliced as RPC would). */
function conn(elf: Record<string, Uint8Array | null>, calls: { n: number } = { n: 0 }) {
  const pd = new Map<string, Uint8Array | null>();
  const prog = new Map<string, Uint8Array>();
  for (const [id, bytes] of Object.entries(elf)) {
    const pdKey = Keypair.generate().publicKey;
    const p = new Uint8Array(36);
    p.set(pdKey.toBytes(), 4);
    prog.set(id, p);
    pd.set(pdKey.toBase58(), bytes);
  }
  return {
    getAccountInfo: vi.fn(async (k: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) => {
      calls.n++;
      const id = k.toBase58();
      if (prog.has(id)) return { data: prog.get(id)!, owner: PublicKey.default, executable: true, lamports: 1 };
      if (!pd.has(id)) return null;
      const body = pd.get(id);
      if (!body) return null;
      const full = new Uint8Array(PROGRAMDATA_ELF_OFFSET + body.length);
      full.set(body, PROGRAMDATA_ELF_OFFSET);
      const s = cfg?.dataSlice;
      return { data: s ? full.subarray(s.offset, s.offset + s.length) : full, owner: PublicKey.default, executable: false, lamports: 1 };
    }),
  } as never;
}

afterEach(() => {
  __resetUpgradeDetectCache();
  vi.unstubAllEnvs();
});

describe("classifyElfPrefix (real ELF prefixes)", () => {
  it("fixtures are the recorded fingerprints", async () => {
    expect(W_PRE.length).toBe(ELF_FINGERPRINT_LEN);
    expect(PRE_SYNC_FINGERPRINTS[W]).toBe("af1cbc1101def37482ccca11cedbf56dcca2ebece8572f2d4195c64309cb8e2b");
    expect(PRE_SYNC_FINGERPRINTS[M]).toBe("76ff4adbd30acaeddc71f64726e30fda58b0f05c1a3d2e35ddf3520e714813ab");
  });
  it("live / rollback bytes = pre; upgrade builds = post", async () => {
    expect(await classifyElfPrefix(W, W_PRE)).toBe("pre");
    expect(await classifyElfPrefix(M, M_PRE)).toBe("pre");
    expect(await classifyElfPrefix(W, W_POST)).toBe("post");
    expect(await classifyElfPrefix(M, M_POST)).toBe("post");
  });
  it("the H-1 artifact (bc228e1b) and any later build are post with no pinned post hash", async () => {
    expect(await classifyElfPrefix(W, W_H1)).toBe("post");
  });
  it("any OTHER build (e.g. the pending impairment-pause rebuild) is post: detection keys on 'not the old bytes'", async () => {
    const other = W_POST.slice();
    other[100] ^= 1;
    expect(await classifyElfPrefix(W, other)).toBe("post");
  });
  it("unreadable / short / zeroed programdata = unknown; non-relaunch ids = pre", async () => {
    expect(await classifyElfPrefix(W, null)).toBe("unknown");
    expect(await classifyElfPrefix(W, W_PRE.subarray(0, 100))).toBe("unknown");
    expect(await classifyElfPrefix(W, new Uint8Array(ELF_FINGERPRINT_LEN))).toBe("unknown");
    expect(await classifyElfPrefix(MAINNET_PROGRAM_IDS.wrapper, W_POST)).toBe("pre");
  });
});

describe("programUpgradeState / earnNavFloorLive / matcherLpSyncLive over RPC", () => {
  it("today's devnet (both pre): nothing live", async () => {
    const c = conn({ [W]: W_PRE, [M]: M_PRE });
    expect(await programUpgradeState(c, W)).toBe("pre");
    expect(await earnNavFloorLive(c, W)).toBe(false);
    expect(await matcherLpSyncLive(c, W, M)).toBe(false);
  });
  it("matcher upgraded first (runbook step 3, old wrapper still sends v1): sync NOT live", async () => {
    const c = conn({ [W]: W_PRE, [M]: M_POST });
    expect(await matcherLpSyncLive(c, W, M)).toBe(false);
    expect(await earnNavFloorLive(c, W)).toBe(false);
  });
  it("both upgraded: sync live for an LP on the canonical matcher only", async () => {
    const c = conn({ [W]: W_POST, [M]: M_POST });
    expect(await earnNavFloorLive(c, W)).toBe(true);
    expect(await matcherLpSyncLive(c, W, M)).toBe(true);
    expect(await matcherLpSyncLive(c, W, Keypair.generate().publicKey)).toBe(false);
    expect(await matcherLpSyncLive(c, Keypair.generate().publicKey, M)).toBe(false);
  });
  it("wrapper rolled back (new matcher kept): not live again", async () => {
    expect(await matcherLpSyncLive(conn({ [W]: W_PRE, [M]: M_POST }), W, M)).toBe(false);
  });
  it("a failed read is unknown -> treated as pre (conservative)", async () => {
    const c = conn({ [W]: null, [M]: M_POST });
    expect(await programUpgradeState(c, W)).toBe("unknown");
    expect(await earnNavFloorLive(c, W)).toBe(false);
  });
  it("cached: two calls, one probe (2 reads)", async () => {
    const calls = { n: 0 };
    const c = conn({ [W]: W_POST }, calls);
    await programUpgradeState(c, W);
    await programUpgradeState(c, W);
    expect(calls.n).toBe(2);
  });
  it("NEXT_PUBLIC_MATCHER_SYNC_UPGRADE forces the state without RPC", async () => {
    vi.stubEnv("NEXT_PUBLIC_MATCHER_SYNC_UPGRADE", "post");
    const calls = { n: 0 };
    const c = conn({ [W]: W_PRE }, calls);
    expect(await programUpgradeState(c, W)).toBe("post");
    expect(await programUpgradeState(c, MAINNET_PROGRAM_IDS.wrapper)).toBe("pre");
    expect(calls.n).toBe(0);
  });
  it("a THROWING read is never 'post' (unknown -> treated as pre)", async () => {
    const c = { getAccountInfo: vi.fn(async () => { throw new Error("429"); }) } as never;
    expect(await programUpgradeState(c, W)).toBe("unknown");
    expect(await earnNavFloorLive(c, W)).toBe(false);
    expect(await matcherLpSyncLive(c, W, M)).toBe(false);
  });
});

describe("freshness around the cutover", () => {
  afterEach(() => vi.useRealTimers());

  it("a HUNG read resolves 'unknown' after READ_TIMEOUT_MS and does not wedge later calls", async () => {
    vi.useFakeTimers();
    const hung = { getAccountInfo: vi.fn(() => new Promise(() => {})) } as never;
    const p = programUpgradeState(hung, W);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    expect(await p).toBe("unknown");
    // NEGATIVE CONTROL for the inflight leak: after the failure TTL a healthy connection is read.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await programUpgradeState(conn({ [W]: W_H1 }), W)).toBe("post");
  });

  it("a cached 'pre' expires within 45 s (was 5 min)", async () => {
    vi.useFakeTimers();
    const pre = conn({ [W]: W_PRE });
    expect(await programUpgradeState(pre, W)).toBe("pre");
    const post = conn({ [W]: W_H1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await programUpgradeState(post, W)).toBe("pre"); // still cached
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await programUpgradeState(post, W)).toBe("post");
  });

  it("invalidateUpgradeDetection() forces a re-read immediately (Earn 91/25 retry path)", async () => {
    expect(await programUpgradeState(conn({ [W]: W_PRE }), W)).toBe("pre");
    expect(await programUpgradeState(conn({ [W]: W_H1 }), W)).toBe("pre");
    invalidateUpgradeDetection();
    expect(await programUpgradeState(conn({ [W]: W_H1 }), W)).toBe("post");
  });
});
