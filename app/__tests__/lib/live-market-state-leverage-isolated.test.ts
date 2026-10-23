/**
 * #2690 / #2691 (0x-SquidSol): the leverage read is isolated. If the risk-params parse throws, the
 * market must stay listed (isComplete, price intact) with maxLeverage null (registry keeps its DB
 * column), not be hidden by the outer catch setting isComplete=false.
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

vi.mock("@/lib/v17-engine-config", () => ({
  parseV17RiskParams: vi.fn(() => {
    throw new Error("risk-params decode failed");
  }),
}));

import { readLiveMarketStates } from "@/lib/live-market-state";
import { modeFixtures } from "../helpers/v22-fixtures";

const KEY = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";

describe("readLiveMarketStates: a failed leverage parse never hides a market", () => {
  it("keeps the market complete and priced, with maxLeverage null", async () => {
    const connection = { getMultipleAccountsInfo: vi.fn(async () => [{ data: Buffer.from(modeFixtures().market) }]) } as unknown as Connection;
    const out = await readLiveMarketStates([KEY], connection);
    const s = out.get(KEY);
    expect(s?.isComplete).toBe(true);
    expect(s?.markPriceUsd).toBe(150);
    expect(s?.maxLeverage).toBeNull();
  });
});
