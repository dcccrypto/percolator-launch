/**
 * Behavioural guard for #2678/#2679: readLiveMarketStates must derive
 * maxLeverage from the slab's REAL engine-config initial_margin_bps (the bytes
 * it already fetched), and leave it null (so the registry keeps the DB column)
 * when that region can't be read.
 *
 * Layout: V16ConfigAccount starts at V17_MARKET_GROUP_OFF + 32 = 624;
 * initial_margin_bps is the u64 at +62 (u16 max_portfolio_assets, u32
 * max_market_slots, 2x u128 min_nonzero reqs, 3x u64 h_min/h_max/mm_bps) —
 * matches V16ConfigAccount in the deployed engine (percolator@35ddd692
 * src/v16.rs) and the live devnet decode (SOL 666, JUP 1000, COLLECT 1538).
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

vi.mock("@percolatorct/sdk", () => ({
  deriveStakePool: vi.fn(() => [new PublicKey("So11111111111111111111111111111111111111112")]),
  isV17Account: vi.fn(() => true),
  parseWrapperConfigV17: vi.fn(() => ({
    markEwmaE6: 150_000_000n,
    marketauth: new PublicKey("So11111111111111111111111111111111111111112"),
    tradeFeeBps: 30n,
  })),
  parseMarketGroupV17OI: vi.fn(() => {
    throw new Error("not under test");
  }),
  V17_HEADER_LEN: 16,
  V17_MARKET_GROUP_OFF: 592,
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet" }) }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: vi.fn() }));
vi.mock("@/lib/health", () => ({ sanitizeOnChainValue: (v: bigint) => v, isSentinelValue: () => false }));

import { readLiveMarketStates } from "@/lib/live-market-state";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { modeFixtures } from "../helpers/v22-fixtures";

const IMR_OFF = 592 + 32 + 62;

function slabWithImr(bps: number | null, len = 4096): Buffer {
  // A slab of the ACTIVE mode: zeros flag off (the v2.1 reader never checked more), the captured v2.2 VERSION-19 one-slot market flag on (the
  // VERSION-keyed reader refuses anything else). initial_margin_bps sits in the group config, which does not move.
  // A SHORT slab (the engine-config region cut off) is the captured market truncated, so it still carries the wrapper header.
  const b = isDevnetV22Enabled() ? Buffer.from(modeFixtures().market).subarray(0, len) : Buffer.alloc(len);
  if (bps != null) b.writeBigUInt64LE(BigInt(bps), IMR_OFF);
  return b;
}

const KEYS = [
  "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr",
  "HvCDVSx5gStg1WAxBAaXwpouLyTvAHCyBPHJHh3RfVJg",
  "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ",
  "BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY",
  "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE",
];

function conn(datas: Buffer[]): Connection {
  return {
    getMultipleAccountsInfo: vi.fn(async () => datas.map((data) => ({ data }))),
  } as unknown as Connection;
}

describe("readLiveMarketStates — maxLeverage from on-chain initial_margin_bps", () => {
  it("derives each market's cap from its own bps (live devnet values)", async () => {
    const out = await readLiveMarketStates(
      KEYS,
      conn([slabWithImr(666), slabWithImr(1000), slabWithImr(1538), slabWithImr(2222), slabWithImr(2000)]),
    );
    expect(KEYS.map((k) => out.get(k)?.maxLeverage)).toEqual([15, 10, 6.5, 4.5, 5]);
  });

  it("is null (registry keeps DB column) when the engine-config region is short or zero", async () => {
    const out = await readLiveMarketStates(KEYS.slice(0, 2), conn([slabWithImr(null, 600), slabWithImr(0)]));
    expect(out.get(KEYS[0])?.maxLeverage).toBeNull();
    expect(out.get(KEYS[1])?.maxLeverage).toBeNull();
  });
});
