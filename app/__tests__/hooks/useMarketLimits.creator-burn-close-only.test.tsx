// @vitest-environment jsdom
/**
 * Regression: after Burn Admin Key, asset_admin is zero but the creator still
 * owns the market's matcher-LP portfolio. SameOwnerTrade (Custom 67) therefore
 * still applies on-chain through LP ownership.
 *
 * Before this fix, with limits flags OFF, useMarketLimits carried asset_admin
 * but dropped the LP identity needed after an admin burn. That could make the
 * creator ticket look tradeable even though the wrapper remained close-only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { deriveTicketLimits } from "@/lib/limits/ticket";

const CREATOR = new Uint8Array(32).fill(0x9c);
const OTHER_WALLET = new Uint8Array(32).fill(0x42);
const ZERO_ADMIN = new Uint8Array(32);

const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const PROGRAM = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
/** The ticket passes the connected wallet; resolution runs only with one. */
const WALLET = new PublicKey(CREATOR).toBase58();

const mocks = vi.hoisted(() => {
  const getMultipleAccountsInfo = vi.fn();

  return {
    resolveLpAccounts: vi.fn(),
    resolveMarketLp: vi.fn(),
    getMultipleAccountsInfo,
    assetAdminBytes: new Uint8Array(32),
    connection: {
      getMultipleAccountsInfo,
    },
  };
});

vi.mock("@/lib/limits/flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/limits/flags")>();
  return {
    ...actual,
    limitsFlags: () => ({
      p1: false,
      p2: false,
      p2FeeCharged: false,
      p3: false,
    }),
  };
});

vi.mock("@/lib/limits/lp-discovery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/limits/lp-discovery")>();

  return {
    ...actual,
    resolveLpAccounts: mocks.resolveLpAccounts,
  };
});

vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: mocks.resolveMarketLp,
}));

vi.mock("@/lib/pollWhenVisible", () => ({
  pollWhenVisible: () => () => undefined,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: mocks.connection,
  }),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    raw: new Uint8Array(2048),
    programId: new PublicKey(PROGRAM),

    // Burn Admin Key writes the zero pubkey into asset_admin.
    assetProfile: {
      assetAdmin: {
        toBytes: () => mocks.assetAdminBytes,
      },
    },
  }),
}));

vi.mock("@/lib/limits/decode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/limits/decode")>();

  return {
    ...actual,

    // What the matcher-LP portfolio would decode to if the hook preserved
    // LP identity while limits flags are OFF.
    decodePortfolioRisk: () =>
      ({
        owner: CREATOR,
        capital: 1_000_000n,
        pnl: 0n,
        feeCredits: 0n,
        activeBitmap: 0n,
        staleState: 0,
        bStaleState: 0,
        cert: {},
      }) as any,

    signedPositionForAsset: () => 0n,
    decodePortfolioLegs: () => [],
  };
});

beforeEach(async () => {
  (await import("@/hooks/useMarketLimits")).__resetSameOwnerLpCache();
});

function ticketFor(
  limits: ReturnType<
    typeof import("@/hooks/useMarketLimits")["useMarketLimits"]
  >,
  takerOwner: Uint8Array,
) {
  return deriveTicketLimits({
    limits,
    direction: "long",
    sizeQ: 1_000_000n,
    takerPosQ: 0n,
    takerOwner,
    leverage: 1,
    limitPriceE6: 0n,
  });
}

describe("creator close-only after Burn Admin Key", () => {
  it("remains close-only from LP ownership when asset_admin is zero and flags are OFF", async () => {
    mocks.resolveMarketLp.mockResolvedValue({
      owner: new PublicKey(CREATOR),
    });

    mocks.getMultipleAccountsInfo.mockResolvedValue([
      { data: new Uint8Array(512) },
    ]);

    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { result } = renderHook(() =>
      useMarketLimits(SLAB, 0, WALLET),
    );

    // Establish the post-burn condition first.
    expect(Array.from(result.current.assetAdmin ?? [])).toEqual(
      Array.from(ZERO_ADMIN),
    );

    // On-chain SameOwnerTrade still applies because this wallet owns the LP.
    // The frontend must therefore remain close-only as well.
    await waitFor(() => {
      const ticket = ticketFor(result.current, CREATOR);

      expect(ticket.sameOwner).toBe(true);
      expect(ticket.sameOwnerCloseOnly).toBe(true);
      expect(ticket.issues.map((x) => x.kind)).toContain(
        "same-owner",
      );
    });
  });

  it("negative control: an unrelated wallet is not marked same-owner", async () => {
    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { result } = renderHook(() =>
      useMarketLimits(SLAB, 0, WALLET),
    );

    await waitFor(() => {
      expect(result.current.sameOwnerPending).toBe(false);
      expect(result.current.sameOwnerLpOwner).not.toBeNull();
    });

    const ticket = ticketFor(result.current, OTHER_WALLET);

    expect(ticket.sameOwner).toBe(false);
    expect(ticket.sameOwnerCloseOnly).toBe(false);
  });
});

describe("root-cause control", () => {
  it("still enforces close-only after admin burn when the LP owner is available", () => {
    const postBurnLimitsWithLpOwner = {
      state: "off",
      flags: {
        p1: false,
        p2: false,
        p2FeeCharged: false,
        p3: false,
      },
      engine: null,
      riskLimits: null,
      bandBps: null,
      vaultLp: null,

      // Burn Admin Key does not remove creator ownership of the matcher LP.
      lp: {
        owner: CREATOR,
      },

      matcher: null,
      vaultState: null,
      registryShares: null,

      // Burn Admin Key writes the zero pubkey here.
      assetAdmin: ZERO_ADMIN,
    } as any;

    const ticket = ticketFor(
      postBurnLimitsWithLpOwner,
      CREATOR,
    );

    expect(ticket.sameOwner).toBe(true);
    expect(ticket.sameOwnerCloseOnly).toBe(true);
    expect(ticket.issues.map((x) => x.kind)).toContain(
      "same-owner",
    );

    // Close-only does not mean frozen: a valid partial reduction remains
    // permitted while an opening / position-increasing order is blocked.
    const reduction = deriveTicketLimits({
      limits: postBurnLimitsWithLpOwner,
      direction: "short",
      sizeQ: 1_000n,
      takerPosQ: 5_000n,
      takerOwner: CREATOR,
      leverage: 1,
      limitPriceE6: 0n,
    });

    expect(reduction.sameOwnerCloseOnly).toBe(true);
    expect(reduction.sameOwner).toBe(false);
    expect(reduction.issues.map((x) => x.kind)).not.toContain(
      "same-owner",
    );
  });
});

describe("user-facing ticket impact", () => {
  it("post-burn creator must see a blocked Close-only CTA, not an actionable Long CTA", async () => {
    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { deriveTicketState } =
      await import("@/lib/limits/ticket-state");

    const { result } = renderHook(() =>
      useMarketLimits(SLAB, 0, WALLET),
    );

    await waitFor(() => {
      expect(result.current.sameOwnerPending).toBe(false);
      expect(
        ticketFor(result.current, CREATOR).sameOwner,
      ).toBe(true);
    });

    const limitsTicket = ticketFor(
      result.current,
      CREATOR,
    );

    const state = deriveTicketState({
      direction: "long",
      baseSymbol: "SOL",
      leverageLabel: "1",
      marketRetired: false,
      marketResolved: false,
      marketPaused: false,
      adlReduceOnly: false,
      engineStale: false,
      waitingForPrice: false,
      sidePaused: {
        long: false,
        short: false,
      },
      openingPaused: false,
      lpDepleted: false,
      lpIsVault: false,
      sameOwner: limitsTicket.sameOwner,
      exceedsBalance: false,
      shortfallLabel: "0 USDC",
      feeOverMax: false,
      feeSuggested: null,
    });

    expect(state).toMatchObject({
      row: "same-owner",
      buttonLabel: "Close-only for this wallet",
      blocks: true,
    });
  });
});


describe("same-owner LP resolution gating", () => {
  it("does not resolve the canonical LP while asset_admin is still non-zero", async () => {
    mocks.assetAdminBytes = CREATOR;
    mocks.resolveMarketLp.mockClear();

    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { result } = renderHook(() =>
      useMarketLimits(SLAB, 0, WALLET),
    );

    await waitFor(() => {
      expect(result.current.sameOwnerPending).toBe(false);
    });

    expect(mocks.resolveMarketLp).not.toHaveBeenCalled();

    // Existing asset_admin identity is still enough for SameOwnerTrade.
    const ticket = ticketFor(result.current, CREATOR);

    expect(ticket.sameOwner).toBe(true);
    expect(ticket.sameOwnerCloseOnly).toBe(true);

    mocks.assetAdminBytes = ZERO_ADMIN;
  });
});


describe("same-owner resolution recovery", () => {
  it("retries in the background after a failed resolution, without blocking", async () => {
    vi.useFakeTimers();

    try {
      mocks.assetAdminBytes = ZERO_ADMIN;
      mocks.resolveMarketLp.mockReset();
      mocks.resolveMarketLp.mockResolvedValue(null);

      const { useMarketLimits } =
        await import("@/hooks/useMarketLimits");

      const { result } = renderHook(() =>
        useMarketLimits(SLAB, 0, WALLET),
      );

      // Initial resolution attempt settles: no longer pending (fails open).
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(1);
      expect(result.current.sameOwnerPending).toBe(false);
      expect(result.current.sameOwnerUnresolved).toBe(true);

      // RPC recovers before the first background retry (2 s).
      mocks.resolveMarketLp.mockResolvedValue({
        owner: new PublicKey(CREATOR),
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(mocks.resolveMarketLp).toHaveBeenCalledTimes(2);
      expect(result.current.sameOwnerPending).toBe(false);
      expect(result.current.sameOwnerUnresolved).toBe(false);
      expect(result.current.sameOwnerLpOwner).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
