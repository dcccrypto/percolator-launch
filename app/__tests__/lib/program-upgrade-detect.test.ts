/**
 * Upgrade detection for the matcher-inventory-sync + NAV-floor deploy (lib/program-upgrade-detect.ts).
 * Fixtures are the first 4096 bytes of the REAL ELFs (~/percolator-ops/artifacts/matcher-sync-2026-10-03):
 * the live/rollback builds (wrapper f2fbf36d, matcher 7d16a4b4; == devnet on-chain 2026-10-03, read-only
 * check) and the upgrade builds (wrapper 3a46ffac @ 7a3ac04c, matcher e0fe9a6a @ b5b419da).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ELF_FINGERPRINT_LEN,
  KNOWN_POST_SYNC_FINGERPRINTS,
  PRE_SYNC_FINGERPRINTS,
  PROGRAMDATA_ELF_OFFSET,
  __resetUpgradeDetectCache,
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
    expect(KNOWN_POST_SYNC_FINGERPRINTS[M]).toBe("23b91fe4a4590b65b4869adf3c10232b04edfe63803cab55d065f03015fa86f9");
  });
  it("live / rollback bytes = pre; upgrade builds = post", async () => {
    expect(await classifyElfPrefix(W, W_PRE)).toBe("pre");
    expect(await classifyElfPrefix(M, M_PRE)).toBe("pre");
    expect(await classifyElfPrefix(W, W_POST)).toBe("post");
    expect(await classifyElfPrefix(M, M_POST)).toBe("post");
  });
  it("any OTHER build (e.g. the pending H-1 successor) is post: detection keys on 'not the old bytes'", async () => {
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
});
