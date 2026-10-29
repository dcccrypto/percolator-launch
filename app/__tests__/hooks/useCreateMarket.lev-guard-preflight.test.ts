/**
 * D27: create() refuses a growth launch whose plan has no leverage-guard step on mainnet, BEFORE any signature or send (without the guard
 * every open on the new market fails Custom(132), and once the stake pool takes the market authority only the upgrade authority can add it).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const m = vi.hoisted(() => ({
  sendTx: vi.fn(async () => "sig"),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  config: {} as Record<string, unknown>,
  wallet: {} as Record<string, unknown>,
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getAccountInfo: async () => null, getBalance: async () => 10_000_000_000 } }),
  useWalletCompat: () => m.wallet,
}));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), sendTx: m.sendTx, signAllCompat: m.signAllCompat, broadcastSignedTx: m.broadcastSignedTx }));
vi.mock("@/lib/config", async (orig) => {
  const real = await orig<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => m.config };
});
vi.mock("@/lib/inFlightMarket", () => ({ saveInFlightMarket: vi.fn(), updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(), loadLastInFlightMarket: vi.fn(() => null) }));

import { useCreateMarket, type CreateMarketParams } from "@/hooks/useCreateMarket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { DEVNET_V22_PROGRAM_IDS } from "@/lib/program-ids";
import { LEV_GUARD_PLAN_MISSING } from "@/lib/v22/lev-guard";

const params = (): CreateMarketParams => ({
  mint: Keypair.generate().publicKey,
  initialPriceE6: 1_000_000n,
  lpCollateral: 1_000_000_000n,
  insuranceAmount: 100_000_000n,
  oracleFeed: "0".repeat(64),
  invert: false,
  tradingFeeBps: 30,
  initialMarginBps: 2_000,
  decimals: 6,
  symbol: "TST",
  name: "Test",
  oracleMode: "admin",
  p3: { juniorFloorBps: 2_000, juniorAtoms: 1_000_000_000n },
  growth: { lLaunchX100: 500, rGapBps: 400, maxAbsFundingE9PerSlot: 1_000n, maxTradingFeeBps: 630n },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", DEVNET_V22_PROGRAM_IDS.wrapper);
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  m.config = { programId: DEVNET_V22_PROGRAM_IDS.wrapper, matcherProgramId: DEVNET_V22_PROGRAM_IDS.matcher, programsBySlabTier: undefined };
  m.wallet = { publicKey: Keypair.generate().publicKey, connected: true, connecting: false, signTransaction: vi.fn(async (t) => t), signAllTransactions: vi.fn(async (t) => t), signMessage: vi.fn(), disconnect: vi.fn() };
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
  __setDevnetV21ForTest(null);
});

describe("create(): the leverage-guard pre-check", () => {
  it("mainnet + growth + the v2.2 switch off: refused before ANY signature or send", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => { await result.current.create(params()); });
    expect(m.sendTx).not.toHaveBeenCalled();
    expect(m.signAllCompat).not.toHaveBeenCalled();
    expect(m.broadcastSignedTx).not.toHaveBeenCalled();
    expect(result.current.state.error).toBe(LEV_GUARD_PLAN_MISSING);
  });

  it("negative control: devnet with the same params is not refused by it", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
    __setDevnetV22ForTest(false);
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => { await result.current.create(params()).catch(() => undefined); });
    expect(result.current.state.error ?? "").not.toBe(LEV_GUARD_PLAN_MISSING);
  });

  it("negative control: mainnet with the switch on plans the guard and is not refused by it", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "mainnet");
    __setDevnetV22ForTest(true);
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => { await result.current.create(params()).catch(() => undefined); });
    expect(result.current.state.error ?? "").not.toBe(LEV_GUARD_PLAN_MISSING);
  });
});
