// @vitest-environment jsdom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

import { v22BlankMarket, v22BlankPortfolio } from "../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";
import * as C from "@/lib/limits/constants";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";

const mocks = vi.hoisted(() => ({
  resolveLpAccounts: vi.fn(),
  getMultipleAccountsInfo: vi.fn(),
  raw: null as Uint8Array | null,
  tick: null as null | (() => void),
}));

vi.mock("@/lib/limits/lp-discovery", async (original) => {
  const actual =
    await original<typeof import("@/lib/limits/lp-discovery")>();

  const { PublicKey } = await import("@solana/web3.js");

  const vault = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );

  const registry = PublicKey.default;

  return {
    ...actual,
    resolveLpAccounts: mocks.resolveLpAccounts,
    deriveVaultLpStatePda: (
      _program: unknown,
      _market: unknown,
      seed: string,
    ) => seed === "vault_lp" ? vault : registry,
  };
});

vi.mock("@/lib/limits/decode", async (original) => {
  const actual =
    await original<typeof import("@/lib/limits/decode")>();

  return {
    ...actual,
    decodeMatcherCtx: () => ({
      kind: 1,
      tradingFeeBps: 25,
      inventoryBase: 0n,
    }),
  };
});

vi.mock("@/lib/program-upgrade-detect", async (original) => ({
  ...(await original<typeof import("@/lib/program-upgrade-detect")>()),
  matcherLpSyncLive: vi.fn(async () => true),
}));

vi.mock("@/lib/v21/flag", async (original) => ({
  ...(await original<typeof import("@/lib/v21/flag")>()),
  isDevnetV21Enabled: () => false,
}));

vi.mock("@/hooks/useClusterSlot", () => ({
  useClusterSlot: () => null,
}));

vi.mock("@/lib/pollWhenVisible", () => ({
  pollWhenVisible: (callback: () => void) => {
    mocks.tick = callback;
    return () => { mocks.tick = null; };
  },
}));

const connection = {
  getMultipleAccountsInfo: mocks.getMultipleAccountsInfo,
};

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection }),
}));

vi.mock("@/components/providers/SlabProvider", async () => {
  const { PublicKey } = await import("@solana/web3.js");

  const programId = new PublicKey(
    "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
  );

  return {
    useSlabState: () => ({
      raw: mocks.raw,
      programId,
      assetProfile: null,
    }),
  };
});

let market: PublicKey;
let lp: PublicKey;
let ctx: PublicKey;

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setLimitsFlagsForTest({
    p1: false,
    p2: false,
    p2FeeCharged: false,
    p3: true,
  });

  market = Keypair.generate().publicKey;
  lp = Keypair.generate().publicKey;
  ctx = Keypair.generate().publicKey;

  const data = v22BlankMarket();
  const base =
    marketOffsets(data).wrapperOff(0) +
    C.ASSET_VAULT_LP_OFF;

  data.set(lp.toBytes(), base + C.AV_VAULT_LP_PORTFOLIO);
  data[base + C.AV_FLAGS] = C.ASSET_VAULT_LP_FLAG_BOUND;

  mocks.raw = data;
  mocks.tick = null;
  mocks.resolveLpAccounts.mockReset();

  const portfolio = v22BlankPortfolio();

  mocks.getMultipleAccountsInfo.mockReset();
  mocks.getMultipleAccountsInfo.mockImplementation(
    async (keys: PublicKey[]) =>
      keys.map((key) => {
        if (key.equals(lp)) {
          return { data: portfolio };
        }
        if (key.equals(ctx)) {
          return {
            owner: Keypair.generate().publicKey,
            data: new Uint8Array(512),
          };
        }
        return null;
      }),
  );
});

afterEach(() => {
  __setDevnetV22ForTest(null);
  __setLimitsFlagsForTest(null);
});

describe("useMarketLimits matcher transition", () => {
  it("POSITIVE: exposes a verified active matcher", async () => {
    mocks.resolveLpAccounts.mockResolvedValue({
      lpPortfolio: lp,
      matcherCtx: ctx,
    });

    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { result, unmount } = renderHook(() =>
      useMarketLimits(market.toBase58()),
    );

    await waitFor(() => {
      expect(result.current.matcher).not.toBeNull();
      expect(result.current.matcherSyncLive).toBe(true);
    });

    unmount();
  });

  it("NEGATIVE: clears stale matcher after verified read-only vault fallback", async () => {
    mocks.resolveLpAccounts
      .mockResolvedValueOnce({
        lpPortfolio: lp,
        matcherCtx: ctx,
      })
      .mockResolvedValueOnce({
        lpPortfolio: lp,
        matcherCtx: null,
      });

    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { result, unmount } = renderHook(() =>
      useMarketLimits(market.toBase58()),
    );

    await waitFor(() => {
      expect(result.current.matcher).not.toBeNull();
      expect(result.current.matcherSyncLive).toBe(true);
    });

    expect(mocks.tick).not.toBeNull();

    await act(async () => {
      mocks.tick?.();
    });

    await waitFor(() =>
      expect(mocks.resolveLpAccounts).toHaveBeenCalledTimes(2),
    );

    await waitFor(() => {
      expect(result.current.matcher).toBeNull();
      expect(result.current.matcherSyncLive).toBe(false);
    });

    unmount();
  });
});
