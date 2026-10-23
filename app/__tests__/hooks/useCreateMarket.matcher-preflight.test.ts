/**
 * AUD-FC-A1 (behaviour): create() checks the vault-LP matcher BEFORE any signature or send. A deployment whose configured matcher is not
 * the active wrapper's canonical one used to build five steps and die at the sixth ("not the protocol's canonical vault-LP matcher"),
 * leaving a half-built market. The wrapper here is the v2.2 fresh one (6kpg2wi7, canonical matcher AsHvEJ8z).
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const m = vi.hoisted(() => ({
  sendTx: vi.fn(async () => "sig"),
  signAllCompat: vi.fn(),
  broadcastSignedTx: vi.fn(),
  getAccountInfo: vi.fn(async () => null),
  config: {} as Record<string, unknown>,
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getAccountInfo: m.getAccountInfo, getBalance: async () => 10_000_000_000 } }),
  useWalletCompat: () => m.wallet,
}));
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), sendTx: m.sendTx, signAllCompat: m.signAllCompat, broadcastSignedTx: m.broadcastSignedTx }));
vi.mock("@/lib/config", async (orig) => {
  const real = await orig<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => m.config };
});
vi.mock("@/lib/inFlightMarket", () => ({ saveInFlightMarket: vi.fn(), updateInFlightStep: vi.fn(), clearInFlightMarket: vi.fn(), loadLastInFlightMarket: vi.fn(() => null) }));

import { useCreateMarket, type CreateMarketParams } from "@/hooks/useCreateMarket";
import { DEVNET_PROGRAM_IDS, DEVNET_V22_PROGRAM_IDS } from "@/lib/program-ids";

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
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_WRAPPER_PROGRAM_ID", DEVNET_V22_PROGRAM_IDS.wrapper);
  vi.stubEnv("NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE", "1");
  m.wallet = { publicKey: Keypair.generate().publicKey, connected: true, connecting: false, signTransaction: vi.fn(async (t) => t), signAllTransactions: vi.fn(async (t) => t), signMessage: vi.fn(), disconnect: vi.fn() };
});

describe("create(): the matcher pre-check", () => {
  it("a configured matcher that is not the wrapper's canonical one stops create() before ANY signature or send", async () => {
    m.config = { programId: DEVNET_V22_PROGRAM_IDS.wrapper, matcherProgramId: DEVNET_PROGRAM_IDS.matcher, programsBySlabTier: undefined };
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.create(params());
    });
    expect(m.sendTx).not.toHaveBeenCalled();
    expect(m.signAllCompat).not.toHaveBeenCalled();
    expect(m.broadcastSignedTx).not.toHaveBeenCalled();
    expect(result.current.state.error ?? "").toMatch(/canonical vault-LP matcher/);
  });

  it("negative control: with the canonical matcher of that wrapper the pre-check passes (no matcher refusal)", async () => {
    m.config = { programId: DEVNET_V22_PROGRAM_IDS.wrapper, matcherProgramId: DEVNET_V22_PROGRAM_IDS.matcher, programsBySlabTier: undefined };
    const { result } = renderHook(() => useCreateMarket());
    await act(async () => {
      await result.current.create(params()).catch(() => undefined);
    });
    expect(result.current.state.error ?? "").not.toMatch(/canonical vault-LP matcher/);
    void new PublicKey(DEVNET_V22_PROGRAM_IDS.matcher);
  });
});
