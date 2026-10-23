// @vitest-environment node
/**
 * Follow-up to #3611: the route valued a first-loss pool from the InsuranceUnits snapshot (`snapInsuranceFreeAtoms`),
 * which is refreshed only when the units account is touched, so after an insurance loss it is stale-high. The /stake
 * page clamps it to the market's live free-insurance reading (liveFreeInsuranceAtoms); the route now does the same,
 * from the market (slab) account it already reads for the orphan filter, so no extra RPC call.
 *
 * Original #3611 context: a first-loss pool's value is vault + the insurance it has deployed (read from the market's InsuranceUnits
 * account). When that read failed (RPC error) or the account was missing, GET /api/stake/pools still sent a TVL: the
 * vault balance alone, understated by the deployed share, and /stake valued stakes from it. lib/v22/stake-pool-value.ts's
 * rule is that such a pool gets NO number (a dash), never a guess: `tvl` is now null for it.
 *
 * Real v5 pool bytes (fixtures/v22-stake-pools-2026-10-11.json): SOL (CcRu…) is first-loss, the other four are fee-only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import fixture from "../fixtures/v22-stake-pools-2026-10-11.json";
import { put128, syntheticMarket } from "../lib/v22/_stamp";
import { stakePoolValueView } from "@/lib/v22/stake-pool-value";
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

/** A v2.2 market whose live free insurance for asset 0 is `liveFree` (long-domain budget; vault and insurance above it). */
function marketBytes(liveFree: bigint): Buffer {
  const L = LAYOUT_V22;
  const d = syntheticMarket(L, 1, { insurance: 10n ** 12n });
  put128(d, L.marketGroupOff + L.group.vault, 10n ** 12n);
  put128(d, L.marketGroupOff + L.marketGroupLen + L.wrapperSlotLen + L.engineSlot.insuranceDomainBudgetLong, liveFree);
  return Buffer.from(d);
}
const UNITS = unitsBytes(600n, 1_000n, 500_000_000n); // snapshot: 500M free, stakers own 60%
const SOL_SLAB = solPool.slab.toBase58();

const rpc = vi.hoisted(() => ({ liveFree: null as bigint | null, calls: 0 }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getProgramAccounts: async (pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) =>
      fixture.pools
        .map((p) => ({ pubkey: new PublicKey(p.pubkey), account: { data: Buffer.from(p.b64, "base64"), executable: false, lamports: 1, owner: pid } }))
        .filter((a) => a.account.data.length === (cfg.filters[0]?.dataSize ?? -1)),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      rpc.calls++;
      return keys.map((k) => {
        const s = k.toBase58();
        if (s === UNITS_KEY) return { data: UNITS, executable: false, lamports: 1, owner: PublicKey.default };
        if (s === SOL_SLAB && rpc.liveFree !== null) return { data: marketBytes(rpc.liveFree), executable: false, lamports: 1, owner: PublicKey.default };
        return { data: tokenAccount(VAULT_ATOMS), executable: false, lamports: 1, owner: PublicKey.default };
      });
    },
  }),
}));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => { throw new Error("no supabase"); },
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => undefined }));

type Pool = { poolAddress: string; tvl: number | null; poolValue: number | null; stakeKind?: string; deployedValue?: number | null; liquidValue?: number | null };

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
  rpc.liveFree = null;
  rpc.calls = 0;
});

const usd = (a: bigint | null) => (a === null ? null : Number(a) / 1e6);
const poolBytes = new Uint8Array(Buffer.from(fixture.pools.find((p) => p.pubkey === FIRST_LOSS_POOL)!.b64, "base64"));

describe("/api/stake/pools clamps a first-loss pool to the market's live free insurance, as /stake does", () => {
  it("after an insurance loss (live 250M < 500M snapshot): tvl and deployed use the live reading, not the stale-high snapshot", async () => {
    rpc.liveFree = 250_000_000n;
    const fl = (await getPools(true)).find((p) => p.poolAddress === FIRST_LOSS_POOL)!;
    const page = stakePoolValueView(poolBytes, UNITS, 250_000_000n)!; // what /stake shows
    const stale = stakePoolValueView(poolBytes, UNITS, null)!;
    expect(page.totalAtoms).toBeLessThan(stale.totalAtoms!);
    expect(fl.deployedValue).toBe(150); // 60% of the live 250M, not of the 500M snapshot
    expect(fl.tvl).toBe(usd(page.totalAtoms));
    expect(fl.poolValue).toBe(usd(page.totalAtoms));
  });

  it("live reading above the snapshot changes nothing (the clamp only lowers)", async () => {
    rpc.liveFree = 900_000_000n;
    const fl = (await getPools(true)).find((p) => p.poolAddress === FIRST_LOSS_POOL)!;
    expect(fl.deployedValue).toBe(300);
    expect(fl.tvl).toBe(usd(stakePoolValueView(poolBytes, UNITS, null)!.totalAtoms));
  });

  it("market not decodable as a v2.2 market: the snapshot, exactly as the page (liveFreeInsuranceAtoms null)", async () => {
    const fl = (await getPools(true)).find((p) => p.poolAddress === FIRST_LOSS_POOL)!;
    expect(fl.deployedValue).toBe(300);
  });

  it("no extra RPC call: the clamp reuses the slab read the route already makes", async () => {
    rpc.liveFree = 250_000_000n;
    await getPools(true);
    const withClamp = rpc.calls;
    rpc.liveFree = null; rpc.calls = 0;
    await getPools(true);
    expect(withClamp).toBe(rpc.calls);
  });

  it("flag off: the response does not depend on the market's insurance and carries no v2.2 fields", async () => {
    rpc.liveFree = 250_000_000n;
    const a = await getPools(false);
    rpc.liveFree = null;
    const b = await getPools(false);
    expect(a).toEqual(b);
    for (const p of a) expect(p.stakeKind).toBeUndefined();
  });
});
