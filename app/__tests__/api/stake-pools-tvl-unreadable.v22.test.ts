// @vitest-environment node
/**
 * #3611: a first-loss pool's value is vault + the insurance it has deployed (read from the market's InsuranceUnits
 * account). When that read failed (RPC error) or the account was missing, GET /api/stake/pools still sent a TVL: the
 * vault balance alone, understated by the deployed share, and /stake valued stakes from it. lib/v22/stake-pool-value.ts's
 * rule is that such a pool gets NO number (a dash), never a guess: `tvl` is now null for it.
 *
 * Real v5 pool bytes (fixtures/v22-stake-pools-2026-10-11.json): SOL (CcRu…) is first-loss, the other four are fee-only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../fixtures/v22-stake-pools-2026-10-11.json";
import { ACCOUNT_KIND, INSURANCE_UNITS_FIELD_OFF_V22, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, decodeStakePoolV5, deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";

const STAKE = "7JrgAUHi4PxaRv5JKHoGAxodDFbozYexpERei66Xgq4V";
const MARKETS = [
  { slab: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5", symbol: "SOL" },
  { slab: "ARSMzcMZzgZT2f4GJVbyJsLSuvyuTHvkbaS3fYeoMrvK", symbol: "JUP" },
  { slab: "ALdzXdcRjbHfKyf3XKHDAGWPvDD1Dt1qHBjsaEdN76PA", symbol: "CHILLHOUSE" },
  { slab: "A8XsQeovaevpHLgkWQx3Yg2Q3DuCfjiRvmtagmr53kew", symbol: "PENGU" },
  { slab: "DJM81s8hi5KnozZrgL5MzdJ8sN1mnxBzAY17VBTVkxwU", symbol: "CODEC" },
];
const ANY_KEY = "So11111111111111111111111111111111111111112";
const FIRST_LOSS_POOL = "CcRu14fpgk14xUytK88Cg49ehGygZNbQG2LpXuc27kAJ";
const VAULT_ATOMS = 500_000_000n; // $500 in every pool vault

const solPool = decodeStakePoolV5(new Uint8Array(Buffer.from(fixture.pools.find((p) => p.pubkey === FIRST_LOSS_POOL)!.b64, "base64")));
const UNITS_KEY = deriveInsuranceUnitsV22(solPool.percolatorProgram, solPool.slab)[0].toBase58();

/** InsuranceUnitsV20: stakers own `stake` of `total` units of an insurance fund holding `free` atoms. */
function unitsBytes(stake: bigint, total: bigint, free: bigint): Buffer {
  const d = new Uint8Array(16 + 192);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = ACCOUNT_KIND.InsuranceUnits;
  const b = 16, F = INSURANCE_UNITS_FIELD_OFF_V22;
  d.set(solPool.slab.toBytes(), b + F.marketGroup);
  const u128 = (o: number, x: bigint) => { v.setBigUint64(b + o, x & ((1n << 64n) - 1n), true); v.setBigUint64(b + o + 8, x >> 64n, true); };
  u128(F.unitsTotal, total); u128(F.unitsStake, stake); u128(F.unitsCreator, total - stake);
  u128(F.snapInsuranceMintAtoms, free); u128(F.snapInsuranceFreeAtoms, free);
  d[b + F.version] = 1;
  return Buffer.from(d);
}
function tokenAccount(amount: bigint): Buffer {
  const d = Buffer.alloc(165);
  d.writeBigUInt64LE(amount, 64);
  return d;
}

const rpc = vi.hoisted(() => ({ units: "throw" as "throw" | "missing" | "ok" }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getProgramAccounts: async (pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) =>
      fixture.pools
        .map((p) => ({ pubkey: new PublicKey(p.pubkey), account: { data: Buffer.from(p.b64, "base64"), executable: false, lamports: 1, owner: pid } }))
        .filter((a) => a.account.data.length === (cfg.filters[0]?.dataSize ?? -1)),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (keys.some((k) => k.toBase58() === UNITS_KEY)) {
        if (rpc.units === "throw") throw new Error("429 Too Many Requests");
        return keys.map((k) => (k.toBase58() === UNITS_KEY && rpc.units === "ok" ? { data: unitsBytes(600n, 1_000n, 500_000_000n), executable: false, lamports: 1, owner: PublicKey.default } : null));
      }
      return keys.map(() => ({ data: tokenAccount(VAULT_ATOMS), executable: false, lamports: 1, owner: PublicKey.default }));
    },
  }),
}));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => { throw new Error("no supabase"); },
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => undefined }));

type Pool = { poolAddress: string; tvl: number | null; poolValue: number | null; vaultBalance: number; stakeKind?: string; deployedValue?: number | null };

async function getPools(v22: boolean): Promise<Pool[]> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  vi.stubEnv("NEXT_PUBLIC_STAKE_PROGRAM_ID", STAKE);
  vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", v22 ? "1" : "");
  vi.stubEnv(
    "NEXT_PUBLIC_V22_MARKETS_JSON",
    JSON.stringify(MARKETS.map((m) => ({ slab: m.slab, symbol: m.symbol, name: m.symbol, mainnet_ca: ANY_KEY, dex_pool_address: ANY_KEY, lp_portfolio_address: ANY_KEY }))),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { GET } = await import("@/app/api/stake/pools/route");
  return ((await (await GET()).json()) as { pools: Pool[] }).pools;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("#3611 /api/stake/pools: a first-loss pool whose value can't be read has tvl null, never the vault alone", () => {
  it("the InsuranceUnits read fails (RPC error): tvl null (dash), not the $500 vault balance", async () => {
    rpc.units = "throw";
    const pools = await getPools(true);
    const fl = pools.find((p) => p.poolAddress === FIRST_LOSS_POOL)!;
    expect(fl.stakeKind).toBe("first-loss");
    expect(fl.tvl).toBeNull();
    expect(fl.poolValue).toBeNull();
    expect(fl.deployedValue).toBeNull();
    expect(fl.vaultBalance).toBe(500); // the vault number itself is still reported, as the vault balance
  });

  it("the InsuranceUnits account is missing: tvl null", async () => {
    rpc.units = "missing";
    const fl = (await getPools(true)).find((p) => p.poolAddress === FIRST_LOSS_POOL)!;
    expect(fl.tvl).toBeNull();
  });

  it("units readable: tvl is the pool's full value (vault-resident + deployed), equal to poolValue", async () => {
    rpc.units = "ok";
    const fl = (await getPools(true)).find((p) => p.poolAddress === FIRST_LOSS_POOL)!;
    expect(fl.tvl).not.toBeNull();
    expect(fl.deployedValue).toBe(300); // 60% of the 500 fund's units
    expect(fl.tvl).toBe(fl.poolValue);
  });

  it("fee-only pools keep their vault TVL whatever the units read does", async () => {
    rpc.units = "throw";
    const others = (await getPools(true)).filter((p) => p.poolAddress !== FIRST_LOSS_POOL);
    expect(others.length).toBe(4);
    for (const p of others) {
      expect(p.stakeKind).toBe("fee-only");
      expect(p.tvl).toBe(500);
    }
  });
});
