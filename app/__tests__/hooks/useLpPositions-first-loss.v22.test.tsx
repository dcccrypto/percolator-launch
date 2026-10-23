/**
 * Portfolio valuation of a v2.2 FIRST-LOSS stake (#3611 follow-up). useLpPositions valued every stake as
 * LP share × the pool vault's balance, ignoring the insurance a first-loss pool has deployed into the market
 * (InsuranceUnits), so the portfolio showed first-loss stakes vault-only. It must use the /stake page's value:
 * `stakePoolValueView(pool, units, liveFree)` (lib/v22/stake-pool-value.ts), and no number (null, a dash) when
 * that value can't be read. Flag off, nothing changes.
 *
 * Real v5 pool bytes (fixtures/v22-stake-pools-2026-10-11.json): SOL (CcRu…) is first-loss, total LP supply 1000.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/v22-stake-pools-2026-10-11.json";
import { ACCOUNT_KIND, INSURANCE_UNITS_FIELD_OFF_V22, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, decodeStakePoolV5 } from "@/lib/v22/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { stakePoolValueView } from "@/lib/v22/stake-pool-value";
import { put128, syntheticMarket } from "../lib/v22/_stamp";

const wallet = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const mocks = vi.hoisted(() => ({ connection: {} as Record<string, unknown> }));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: mocks.connection }),
  useWalletCompat: () => ({ publicKey: wallet }),
}));
const REAL_ATA = "5gVwohxiXx3MBfQZUWK2xtsGq2sTMphG3SGxT61MEimW";
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: () => new PublicKey(REAL_ATA),
  unpackAccount: (_k: PublicKey, info: { data: Buffer }) => ({ amount: info.data.readBigUInt64LE(64) }),
  unpackMint: (_k: PublicKey, info: { data: Buffer }) => ({ decimals: info.data[44] }),
}));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => {} }));
// jsdom's realm-separated Uint8Array breaks the on-curve check inside findProgramAddressSync (__tests__/setup.ts), so the
// units PDA is a fixed key here; the hook must derive it from the pool's wrapper program + slab (asserted below).
const derived = vi.hoisted(() => ({ args: [] as string[][] }));
vi.mock("@/lib/v22/sdk", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/sdk")>()),
  deriveInsuranceUnitsV22: (program: PublicKey, market: PublicKey) => {
    derived.args.push([program.toBase58(), market.toBase58()]);
    return [new PublicKey("SysvarS1otHashes111111111111111111111111111"), 255];
  },
}));

import { useLpPositions } from "@/hooks/useLpPositions";

const FIRST_LOSS_POOL = "CcRu14fpgk14xUytK88Cg49ehGygZNbQG2LpXuc27kAJ";
const poolBytes = new Uint8Array(Buffer.from(fixture.pools.find((p) => p.pubkey === FIRST_LOSS_POOL)!.b64, "base64"));
const solPool = decodeStakePoolV5(poolBytes);
const UNITS_KEY = "SysvarS1otHashes111111111111111111111111111";
const SLAB = solPool.slab.toBase58();
const lpMint = new PublicKey("DHUcriBp5UGBVqCKaUgq6zfZga4Y7ZtHrMb7QNYJBueU");
const vault = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const collateral = new PublicKey("SysvarRent111111111111111111111111111111111");
const LP = 400n; // of the pool's 1000
const VAULT_ATOMS = 500_000_000n;

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
/** A v2.2 market whose live free insurance for asset 0 is `liveFree` (long-domain budget; vault and insurance above it). */
function marketBytes(liveFree: bigint): Buffer {
  const L = LAYOUT_V22;
  const d = syntheticMarket(L, 1, { insurance: 10n ** 12n });
  put128(d, L.marketGroupOff + L.group.vault, 10n ** 12n);
  put128(d, L.marketGroupOff + L.marketGroupLen + L.wrapperSlotLen + L.engineSlot.insuranceDomainBudgetLong, liveFree);
  return Buffer.from(d);
}
const UNITS = unitsBytes(600n, 1_000n, 500_000_000n);
function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  data.set(mint.toBytes(), 0);
  data.set(owner.toBytes(), 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data, rentEpoch: 0 };
}
function mintAccount(decimals: number) {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data, rentEpoch: 0 };
}
const acct = (data: Buffer | Uint8Array) => ({ executable: false, owner: PublicKey.default, lamports: 1, data: Buffer.from(data), rentEpoch: 0 });

const rpc = vi.hoisted(() => ({ units: "ok" as "ok" | "missing" | "throw", market: null as Buffer | null }));
let calls: string[][] = [];
/** The API row: first-loss with the units-inclusive TVL, or (flag off) no stakeKind and the vault TVL. */
let apiRow: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  derived.args = [];
  rpc.units = "ok";
  rpc.market = null;
  const accounts = new Map<string, unknown>([
    [lpMint.toBase58(), mintAccount(0)],
    [collateral.toBase58(), mintAccount(6)],
    [REAL_ATA, tokenAccount(lpMint, wallet, LP)],
    [FIRST_LOSS_POOL, acct(poolBytes)],
    [vault.toBase58(), tokenAccount(collateral, new PublicKey(FIRST_LOSS_POOL), VAULT_ATOMS)],
  ]);
  mocks.connection.getSlot = vi.fn(async () => 1);
  mocks.connection.getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => {
    const ks = keys.map((k) => k.toBase58());
    calls.push(ks);
    if (ks.includes(UNITS_KEY) && rpc.units === "throw") throw new Error("429 Too Many Requests");
    return ks.map((k) => {
      if (k === UNITS_KEY) return rpc.units === "ok" ? acct(UNITS) : null;
      if (k === SLAB) return rpc.market ? acct(rpc.market) : null;
      return accounts.get(k) ?? null;
    });
  });
  apiRow = {
    poolAddress: FIRST_LOSS_POOL, slabAddress: SLAB, collateralMint: collateral.toBase58(),
    lpMint: lpMint.toBase58(), vault: vault.toBase58(), name: "SOL", symbol: "SOL", logoUrl: null,
    tvl: 500, tvlRaw: VAULT_ATOMS.toString(), totalLpSupply: 1000, cooldownSlots: 0, apr: null, poolMode: 0,
    stakeKind: "first-loss",
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/markets")
    ? ({ ok: true, json: async () => ({ markets: [] }) })
    : ({ ok: true, json: async () => ({ pools: [apiRow] }) })));
});
afterEach(() => {
  __setDevnetV22ForTest(null);
  vi.unstubAllGlobals();
});

async function read() {
  const { result } = renderHook(() => useLpPositions());
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await new Promise((r) => setTimeout(r, 30));
  expect(result.current.error).toBeNull();
  expect(result.current.positions).toHaveLength(1);
  return result.current;
}
const share = (total: bigint | null) => Number((LP * total!) / 1000n) / 1e6;
const VAULT_ONLY = Number((LP * VAULT_ATOMS) / 1000n) / 1e6; // 200

describe("useLpPositions: a v2.2 first-loss stake is valued like /stake (vault + deployed insurance)", () => {
  it("units readable: the stake is its share of the pool's full value, not of the vault alone", async () => {
    __setDevnetV22ForTest(true);
    const s = await read();
    const total = stakePoolValueView(poolBytes, UNITS, null)!.totalAtoms;
    expect(total).not.toBeNull();
    expect(total).not.toBe(VAULT_ATOMS);
    expect(s.positions[0].redeemable).toBeCloseTo(share(total), 6);
    expect(s.positions[0].redeemable).not.toBeCloseTo(VAULT_ONLY, 3);
    expect(s.totalRedeemable).toBeCloseTo(share(total), 6);
  });

  it("clamps the stale units snapshot to the market's live free insurance, as the page does", async () => {
    __setDevnetV22ForTest(true);
    rpc.market = marketBytes(250_000_000n);
    const s = await read();
    const clamped = stakePoolValueView(poolBytes, UNITS, 250_000_000n)!.totalAtoms;
    expect(clamped).toBeLessThan(stakePoolValueView(poolBytes, UNITS, null)!.totalAtoms!);
    expect(s.positions[0].redeemable).toBeCloseTo(share(clamped), 6);
  });

  it("units read fails: the stake has no value (null, a dash) and the total is unknown, never the vault-only figure", async () => {
    __setDevnetV22ForTest(true);
    rpc.units = "throw";
    apiRow.tvl = null; // the API couldn't read the units either (#3611)
    const s = await read();
    expect(s.positions[0].redeemable).toBeNull();
    expect(s.positions[0].redeemableRaw).toBeNull();
    expect(s.totalRedeemable).toBeNull();
  });

  it("units account missing: null too", async () => {
    __setDevnetV22ForTest(true);
    rpc.units = "missing";
    apiRow.tvl = null;
    const s = await read();
    expect(s.positions[0].redeemable).toBeNull();
    expect(s.totalRedeemable).toBeNull();
  });

  it("RPC load: one extra batched read (units + market) per refresh, only for held first-loss stakes", async () => {
    __setDevnetV22ForTest(true);
    await read();
    const extra = calls.filter((ks) => ks.includes(UNITS_KEY));
    expect(extra).toHaveLength(1);
    expect([...extra[0]].sort()).toEqual([UNITS_KEY, SLAB].sort());
    expect(derived.args).toContainEqual([solPool.percolatorProgram.toBase58(), SLAB]);
  });

  it("flag off: unchanged (vault-share value, no units or market read)", async () => {
    __setDevnetV22ForTest(false);
    delete apiRow.stakeKind;
    const s = await read();
    expect(s.positions[0].redeemable).toBeCloseTo(VAULT_ONLY, 6);
    expect(s.positions[0].redeemableRaw).toBe((LP * VAULT_ATOMS) / 1000n);
    expect(s.totalRedeemable).toBeCloseTo(VAULT_ONLY, 6);
    expect(calls.some((ks) => ks.includes(UNITS_KEY) || ks.includes(SLAB))).toBe(false);
  });
});
