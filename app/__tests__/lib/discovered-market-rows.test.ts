// @vitest-environment node
/**
 * Leads on lib/discovered-market-rows.ts: registry persistence/validation, insurance precision,
 * max-leverage derivation, lot_exp pass-through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({}) }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@/lib/lp-portfolio", () => ({ getKnownMarketLpCapitals: async () => new Map(), scanEnabledMarketLpCapitals: async () => new Map() }));

const GOOD_A = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const GOOD_B = "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg";

let dir: string;
let file: string;
const savedPath = process.env.PLAYGROUND_REGISTRY_PATH;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function loadModule(crashMidWrite = false) {
  vi.resetModules();
  vi.doUnmock("fs");
  if (crashMidWrite) {
    // simulate the process dying mid-write: half the bytes land in whatever file is targeted, then it throws
    vi.doMock("fs", async (orig) => {
      const actual = await orig<typeof import("fs")>();
      const crash = (p: string, d: string, o?: never) => { actual.writeFileSync(p, String(d).slice(0, 5), o); throw new Error("ENOSPC"); };
      return { ...actual, default: { ...actual, writeFileSync: crash }, writeFileSync: crash };
    });
  }
  process.env.PLAYGROUND_REGISTRY_PATH = file;
  return await import("@/lib/discovered-market-rows");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmr-"));
  file = path.join(dir, "reg.json");
});
afterEach(() => {
  process.env.PLAYGROUND_REGISTRY_PATH = savedPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lead 1: registry", () => {
  it("persists a valid slab and reloads it", async () => {
    const m = await loadModule();
    m.registerPlaygroundSlab(GOOD_A);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([GOOD_A]);
  });

  it("rejects a string that is not a base58 public key (not added, not persisted)", async () => {
    const m = await loadModule();
    m.registerPlaygroundSlab("not-a-key");
    m.registerPlaygroundSlab("");
    m.registerPlaygroundSlab(GOOD_A);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([GOOD_A]);
  });

  it("ignores invalid entries already in the file at load, keeping the valid ones", async () => {
    fs.writeFileSync(file, JSON.stringify([GOOD_A, "junk", 5, GOOD_B]));
    const m = await loadModule();
    m.registerPlaygroundSlab(GOOD_B); // rewrite: result lists only valid keys
    const out = JSON.parse(fs.readFileSync(file, "utf8")) as string[];
    expect(out.sort()).toEqual([GOOD_A, GOOD_B].sort());
  });

  it("writes atomically: a failed write leaves the previous file intact and no temp file behind", async () => {
    fs.writeFileSync(file, JSON.stringify([GOOD_A]));
    const m = await loadModule(true);
    m.registerPlaygroundSlab(GOOD_B);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([GOOD_A]);
    expect(fs.readdirSync(dir)).toEqual(["reg.json"]);
  });
});

describe("lead 2: insurance", () => {
  it("is null when the engine read failed, exact below 2^53, and a finite number above it", async () => {
    const m = await loadModule();
    const mk = (ins?: bigint) =>
      m.discoveredToApiRow(
        {
          slabAddress: new PublicKey(GOOD_A),
          programId: new PublicKey(GOOD_B),
          config: {},
          configV17: { markEwmaE6: 1_000_000n, collateralMint: new PublicKey(GOOD_B), marketauth: new PublicKey(GOOD_A), oracleMode: 3 },
        } as never,
        ins === undefined ? undefined : ({ insuranceBalance: ins, totalLongOiQ: 0n, totalShortOiQ: 0n } as never),
      );
    expect(mk().insurance_fund).toBeNull();
    expect(mk(2n ** 53n - 1n).insurance_fund).toBe(Number(2n ** 53n - 1n));
    const big = mk(2n ** 64n - 1n).insurance_fund as number;
    expect(Number.isFinite(big)).toBe(true);
    // Documented: JSON cannot carry bigint; > 9e15 atoms (9e9 USDC) is display-only float.
    expect(Math.abs(big - Number(2n ** 64n - 1n))).toBe(0);
  });
});

describe("lead 3: max_leverage", () => {
  const row = async (bps: bigint | undefined) => {
    const m = await loadModule();
    return m.discoveredToApiRow(
      { slabAddress: new PublicKey(GOOD_A), programId: new PublicKey(GOOD_B), config: {}, params: bps === undefined ? undefined : { initialMarginBps: bps } } as never,
    ).max_leverage;
  };
  it.each([
    [1000n, 10],
    [667n, 14.99 > 0 ? 15 : 0], // ceil(10000/15)=667 round-trips to 15x
    [3334n, 3],
    [10000n, 1],
    [1538n, 6.5],
  ])("bps %s -> %s", async (bps, want) => {
    expect(await row(bps)).toBe(want);
  });
  it("falls back to 10 for missing, zero and negative bps", async () => {
    expect(await row(undefined)).toBe(10);
    expect(await row(0n)).toBe(10);
    expect(await row(-5n)).toBe(10);
  });
  it("bps above 10000 yields a sub-1x cap, not a crash or the fallback; huge bps stays positive-or-fallback", async () => {
    expect(await row(20000n)).toBe(0.5);
    const huge = (await row(2n ** 80n)) as number;
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBe(10); // 10000/1.2e24 floors to 0.0x -> falls back to 10
  });
});

describe("lead 4: lot_exp", () => {
  it("lot_exp is emitted only for lotExp > 0 and scales price and OI per token", async () => {
    const m = await loadModule();
    const mk = (lotExp?: number) =>
      m.discoveredToApiRow(
        {
          slabAddress: new PublicKey(GOOD_A),
          programId: new PublicKey(GOOD_B),
          config: {},
          configV17: { markEwmaE6: 5_000_000n, collateralMint: new PublicKey(GOOD_B), marketauth: new PublicKey(GOOD_A), oracleMode: 3 },
        } as never,
        undefined,
        undefined,
        null,
        lotExp,
      );
    expect(mk().lot_exp).toBeUndefined();
    expect(mk(0).lot_exp).toBeUndefined();
    expect(mk(3).lot_exp).toBe(3);
    expect(mk(3).mark_price).toBeCloseTo(0.005, 9);
    expect(mk(0).mark_price).toBe(5);
  });
});
