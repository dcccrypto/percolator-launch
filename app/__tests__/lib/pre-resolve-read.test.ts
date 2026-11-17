// @vitest-environment node
/**
 * lib/pre-resolve.ts — the creator-fee gate, the v2.2 pool decoder, the LP crank builder variants and the
 * read-then-plan path (registry / pool reads, v2.2 tails, crank simulation). Collaborators are mocked; the
 * planning/decision logic under test is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

const m = vi.hoisted(() => ({
  v22: false,
  creator: undefined as unknown,
  creatorThrows: false,
  parseRegistry: vi.fn(),
  bound: vi.fn(),
  decodeLp: vi.fn(),
  tails: vi.fn(),
  v5: vi.fn(),
  v22Builder: vi.fn(),
  decodeStakePool: vi.fn(),
  simulate: vi.fn(),
}));

vi.mock("@/lib/v22/flag", () => ({ isDevnetV22Enabled: () => m.v22 }));
vi.mock("@/lib/v22/records", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/records")>()), decodeAssetVaultLpP3: m.decodeLp, parseLpVaultRegistry: m.parseRegistry }));
vi.mock("@/lib/v22/market-tails", () => ({ fetchMarketTailsV22: m.tails }));
vi.mock("@/lib/v22/sdk", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/sdk")>()), buildLpVaultCrankFeesIxBoundV22: m.v22Builder, decodeStakePoolV5: m.v5 }));
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<typeof import("@/lib/limits/decode")>()), decodeLpVaultRegistryBound: m.bound }));
vi.mock("@/lib/v17-creator-fee", () => ({
  readCreatorFeeClaimable: () => {
    if (m.creatorThrows) throw new Error("bad");
    return m.creator;
  },
}));
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<typeof import("@percolatorct/sdk")>()), decodeStakePool: m.decodeStakePool }));
vi.mock("@/lib/self-heal", async (orig) => ({
  ...(await orig<typeof import("@/lib/self-heal")>()),
  connectionSelfHealDeps: () => ({ simulate: m.simulate }),
}));

import {
  buildLpCrankIx,
  decodePreResolvePool,
  PRE_RESOLVE_CRANK_CU,
  planPreResolve,
  readAndPlanPreResolve,
  readFeeLegs,
} from "@/lib/pre-resolve";

const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "CaS8oiDW.market.json"), "utf-8")) as { dataBase64: string };
const base = () => new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
const WRAPPER = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
const MARKET = new PublicKey("CaS8oiDWpPNzUD9cwFVZT5cYTNjhWFKB451JE2BNCXuF");
const CRANKER = Keypair.generate().publicKey;
const POOL = Keypair.generate().publicKey;

function setU128(d: Uint8Array, off: number, v: bigint) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  dv.setBigUint64(off, v & 0xffff_ffff_ffff_ffffn, true);
  dv.setBigUint64(off + 8, v >> 64n, true);
}
const withLegs = (lp: bigint, stake: bigint, protocol = 0n) => {
  const d = base();
  setU128(d, 16 + 464, protocol);
  setU128(d, 16 + 496, lp);
  setU128(d, 16 + 528, stake);
  return d;
};
const args = (marketData: Uint8Array) => ({ programId: WRAPPER, stakeProgramId: STAKE, cranker: CRANKER, market: MARKET, marketData });
const plan = (data: Uint8Array) =>
  planPreResolve({ ...args(data), registry: null, pool: null, poolAddress: POOL });

beforeEach(() => {
  vi.resetAllMocks();
  m.v22 = false;
  m.creator = null;
  m.creatorThrows = false;
});

describe("creator fee leg", () => {
  it("claimable > 0 → blocker naming the amount and the claim path", () => {
    m.creator = { atoms: 1_500_000n };
    const r = plan(base());
    expect(r.blockers).toEqual(["You have 1.5 (collateral units) of creator fees to claim. Claim them first (My Markets → Claim); closing the market burns them."]);
    expect(r.warnings).toEqual([]);
  });
  it("claimable exactly 0 → neither blocker nor warning", () => {
    m.creator = { atoms: 0n };
    const r = plan(base());
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
  it("unreadable (null result) → warning, not a blocker", () => {
    m.creator = null;
    const r = plan(base());
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual(["Creator fees could not be read; check My Markets before closing."]);
  });
  it("reader throws → treated as unreadable", () => {
    m.creatorThrows = true;
    const legs = readFeeLegs(base());
    expect(legs.creatorClaimable).toBeNull();
    expect(plan(base()).warnings[0]).toMatch(/could not be read/);
  });
  it("protocol-owed warning formats the amount; whole-number amounts drop the decimals", () => {
    m.creator = { atoms: 0n };
    expect(plan(withLegs(0n, 0n, 2_000_000n)).warnings).toEqual(["2 (collateral units) of protocol fees are unclaimed and will be burned at close."]);
  });
});

describe("decodePreResolvePool", () => {
  it("flag off: the installed decoder, isInitialized from the decoder", () => {
    const d = { slab: MARKET, poolMode: 0, totalLpSupply: 7n, isInitialized: false, percolatorProgram: WRAPPER, vault: POOL };
    m.decodeStakePool.mockReturnValue(d);
    const data = new Uint8Array(400);
    data[381] = 2;
    expect(decodePreResolvePool(data)).toEqual({ ...d, floorFlags: 2 });
    expect(m.v5).not.toHaveBeenCalled();
  });
  it("flag on: the v5 decoder, isInitialized from byte 0", () => {
    m.v22 = true;
    m.v5.mockReturnValue({ slab: MARKET, poolMode: 1, totalLpSupply: 9n, percolatorProgram: WRAPPER, vault: POOL });
    const data = new Uint8Array(480);
    data[0] = 1;
    expect(decodePreResolvePool(data)).toEqual({ slab: MARKET, poolMode: 1, totalLpSupply: 9n, floorFlags: 0, isInitialized: true, percolatorProgram: WRAPPER, vault: POOL });
    data[0] = 0;
    expect(decodePreResolvePool(data).isInitialized).toBe(false);
  });
});

describe("buildLpCrankIx", () => {
  it("unbound: plain 78 builder, no tail", () => {
    const ix = buildLpCrankIx(WRAPPER, CRANKER, MARKET, 0);
    expect(ix.data[0]).toBe(78);
    expect(ix.keys[0].pubkey.equals(CRANKER)).toBe(true);
    const bound = buildLpCrankIx(WRAPPER, CRANKER, MARKET, 0, true);
    expect(bound.keys.length).toBeGreaterThan(ix.keys.length);
  });
  it("bound + v22 ext/bond with the flag on → the SDK tail-aware builder", () => {
    m.v22 = true;
    const sentinel = { sentinel: true };
    m.v22Builder.mockReturnValue(sentinel);
    const lpPortfolio = Keypair.generate().publicKey;
    expect(buildLpCrankIx(WRAPPER, CRANKER, MARKET, 1, true, { lpPortfolio, bond: true })).toBe(sentinel);
    expect(m.v22Builder).toHaveBeenCalledWith({ programId: WRAPPER, market: MARKET, registryDomain: 1, lpPortfolio, vaultLpExt: undefined }, CRANKER, 1, { bond: true });
  });
  it("v22 data without ext or bond, or flag off, falls back to the plain bound builder", () => {
    const lpPortfolio = Keypair.generate().publicKey;
    m.v22 = true;
    expect(buildLpCrankIx(WRAPPER, CRANKER, MARKET, 0, true, { lpPortfolio, bond: false }).data[0]).toBe(78);
    m.v22 = false;
    expect(buildLpCrankIx(WRAPPER, CRANKER, MARKET, 0, true, { lpPortfolio, bond: true }).data[0]).toBe(78);
    expect(m.v22Builder).not.toHaveBeenCalled();
  });
});

describe("readAndPlanPreResolve", () => {
  const info = (owner: PublicKey) => ({ owner, data: Buffer.from(new Uint8Array(400)) });
  const conn = (ri: unknown, pi: unknown) => ({ getMultipleAccountsInfo: vi.fn().mockResolvedValue([ri, pi]) }) as never;
  const goodPool = { slab: MARKET, poolMode: 0, totalLpSupply: 1_000_000n, isInitialized: true, percolatorProgram: WRAPPER, vault: POOL };

  beforeEach(() => {
    m.creator = { atoms: 0n };
    m.parseRegistry.mockReturnValue({ domain: 0n, totalLpSharesOutstanding: 5n });
    m.bound.mockReturnValue(false);
    m.decodeStakePool.mockReturnValue(goodPool);
    m.simulate.mockResolvedValue({ err: null });
  });

  it("nothing owed, nothing on chain → empty plan, no simulation", async () => {
    const r = await readAndPlanPreResolve(conn(null, null), args(base()));
    expect(r.cranks).toEqual([]);
    expect(r.blockers).toEqual([]);
    expect(r.extraComputeUnits).toBe(0);
    expect(m.simulate).not.toHaveBeenCalled();
  });

  it("accounts owned by the wrong program are ignored (LP leg owed → blocked as no Earn vault)", async () => {
    const r = await readAndPlanPreResolve(conn(info(STAKE), info(WRAPPER)), args(withLegs(5n, 5n)));
    expect(r.blockers).toHaveLength(2);
    expect(r.blockers[0]).toMatch(/no Earn vault/);
    expect(r.blockers[1]).toMatch(/no initialised stake pool/);
  });

  it("registry parse failure and pool decode failure count as absent", async () => {
    m.parseRegistry.mockImplementation(() => {
      throw new Error("bad");
    });
    m.decodeStakePool.mockImplementation(() => {
      throw new Error("bad");
    });
    const r = await readAndPlanPreResolve(conn(info(WRAPPER), info(STAKE)), args(withLegs(5n, 5n)));
    expect(r.cranks).toEqual([]);
    expect(r.blockers.map((b) => b.match(/no Earn vault|no initialised stake pool/)?.[0])).toEqual(["no Earn vault", "no initialised stake pool"]);
  });

  it("owed legs with vault + pool and a clean simulation → cranks kept with the extra CU", async () => {
    const r = await readAndPlanPreResolve(conn(info(WRAPPER), info(STAKE)), args(withLegs(5n, 5n)));
    expect(r.blockers).toEqual([]);
    expect(r.cranks.map((c) => c.data[0])).toEqual([78, 87, 12]);
    expect(r.extraComputeUnits).toBe(PRE_RESOLVE_CRANK_CU);
    expect(m.simulate).toHaveBeenCalledTimes(1);
    expect(m.simulate.mock.calls[0][0].length).toBeGreaterThanOrEqual(4); // compute-budget prefix + 3 cranks
  });

  it("simulation Custom(56) / Custom(54) → cranks dropped, 'not bound to its stake pool' blocker", async () => {
    for (const code of [56, 54]) {
      m.simulate.mockResolvedValue({ err: { InstructionError: [0, { Custom: code }] } });
      const r = await readAndPlanPreResolve(conn(info(WRAPPER), info(STAKE)), args(withLegs(0n, 5n)));
      expect(r.cranks).toEqual([]);
      expect(r.blockers).toEqual([
        "Outstanding fees can't be paid out before resolving: the market's insurance is not bound to its stake pool (an operator must run stake Bind first). Resolving now would burn them.",
      ]);
    }
  });

  it("simulation other Custom code → 'refused (Custom(N))'; non-custom error → JSON of the error", async () => {
    m.simulate.mockResolvedValue({ err: { InstructionError: [1, { Custom: 99 }] } });
    let r = await readAndPlanPreResolve(conn(info(WRAPPER), info(STAKE)), args(withLegs(5n, 0n)));
    expect(r.blockers.at(-1)).toContain("the fee crank was refused (Custom(99))");
    m.simulate.mockResolvedValue({ err: "BlockhashNotFound" });
    r = await readAndPlanPreResolve(conn(info(WRAPPER), info(STAKE)), args(withLegs(5n, 0n)));
    expect(r.blockers.at(-1)).toContain('the fee crank was refused ("BlockhashNotFound")');
  });

  it("simulation RPC throwing keeps the plan", async () => {
    m.simulate.mockRejectedValue(new Error("rpc down"));
    const r = await readAndPlanPreResolve(conn(info(WRAPPER), info(STAKE)), args(withLegs(5n, 5n)));
    expect(r.blockers).toEqual([]);
    expect(r.cranks).toHaveLength(3);
  });

  describe("v2.2 bound vault tails", () => {
    const lp = Keypair.generate().publicKey;
    const ext = Keypair.generate().publicKey;
    beforeEach(() => {
      m.v22 = true;
      m.bound.mockReturnValue(true);
      m.decodeLp.mockReturnValue({ vaultLpPortfolio: lp });
      m.v22Builder.mockImplementation(() => ({ data: Buffer.from([78]), keys: [], programId: WRAPPER }));
    });
    it("ext present → registry gets v22 tail and the SDK builder is used", async () => {
      m.tails.mockResolvedValue({ vaultLpExt: ext, bondTranche: null });
      const r = await readAndPlanPreResolve(conn(info(WRAPPER), null), args(withLegs(5n, 0n)));
      expect(m.v22Builder).toHaveBeenCalledWith({ programId: WRAPPER, market: MARKET, registryDomain: 0, lpPortfolio: lp, vaultLpExt: ext }, CRANKER, 0, { bond: false });
      expect(r.cranks).toHaveLength(1);
    });
    it("bond tranche only → bond: true, ext undefined", async () => {
      m.tails.mockResolvedValue({ vaultLpExt: null, bondTranche: Keypair.generate().publicKey });
      await readAndPlanPreResolve(conn(info(WRAPPER), null), args(withLegs(5n, 0n)));
      expect(m.v22Builder).toHaveBeenCalledWith(expect.objectContaining({ vaultLpExt: undefined }), CRANKER, 0, { bond: true });
    });
    it("no tails, or no vault LP portfolio → plain bound builder", async () => {
      m.tails.mockResolvedValue({ vaultLpExt: null, bondTranche: null });
      await readAndPlanPreResolve(conn(info(WRAPPER), null), args(withLegs(5n, 0n)));
      m.tails.mockResolvedValue({ vaultLpExt: ext, bondTranche: null });
      m.decodeLp.mockReturnValue({ vaultLpPortfolio: null });
      await readAndPlanPreResolve(conn(info(WRAPPER), null), args(withLegs(5n, 0n)));
      expect(m.v22Builder).not.toHaveBeenCalled();
    });
    it("tail read failure keeps the plain builder", async () => {
      m.tails.mockRejectedValue(new Error("rpc"));
      const r = await readAndPlanPreResolve(conn(info(WRAPPER), null), args(withLegs(5n, 0n)));
      expect(m.v22Builder).not.toHaveBeenCalled();
      expect(r.cranks[0].data[0]).toBe(78);
    });
    it("unbound registry skips the tail read even with the flag on", async () => {
      m.bound.mockReturnValue(false);
      await readAndPlanPreResolve(conn(info(WRAPPER), null), args(withLegs(5n, 0n)));
      expect(m.tails).not.toHaveBeenCalled();
    });
  });
});
