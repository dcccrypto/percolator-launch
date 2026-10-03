// @vitest-environment jsdom
/**
 * Regression: after Burn Admin Key, asset_admin is zero but the creator still
 * owns the market's matcher-LP portfolio. SameOwnerTrade (Custom 67) therefore
 * still applies on-chain through LP ownership.
 *
 * With limits flags OFF, useMarketLimits currently carries asset_admin but
 * drops the LP view entirely. That can make the creator ticket look tradeable
 * after the admin burn even though the wrapper remains close-only.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { deriveTicketLimits } from "@/lib/limits/ticket";

const CREATOR = new Uint8Array(32).fill(0x9c);
const OTHER_WALLET = new Uint8Array(32).fill(0x42);
const ZERO_ADMIN = new Uint8Array(32);

const SLAB = "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr";
const PROGRAM = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";

const mocks = vi.hoisted(() => ({
  resolveLpAccounts: vi.fn(),
  getMultipleAccountsInfo: vi.fn(),
}));

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

vi.mock("@/lib/pollWhenVisible", () => ({
  pollWhenVisible: () => () => undefined,
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({
    connection: {
      getMultipleAccountsInfo: mocks.getMultipleAccountsInfo,
    },
  }),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    raw: new Uint8Array(2048),
    programId: new PublicKey(PROGRAM),

    // Burn Admin Key writes the zero pubkey into asset_admin.
    assetProfile: {
      assetAdmin: {
        toBytes: () => ZERO_ADMIN,
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
    mocks.resolveLpAccounts.mockResolvedValue({
      lpPortfolio: new PublicKey(
        "11111111111111111111111111111111",
      ),
      matcherCtx: null,
    });

    mocks.getMultipleAccountsInfo.mockResolvedValue([
      { data: new Uint8Array(512) },
    ]);

    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { result } = renderHook(() =>
      useMarketLimits(SLAB),
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
      useMarketLimits(SLAB),
    );

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
  });
});

describe("user-facing ticket impact", () => {
  it("post-burn creator must see a blocked Close-only CTA, not an actionable Long CTA", async () => {
    const { useMarketLimits } =
      await import("@/hooks/useMarketLimits");

    const { deriveTicketState } =
      await import("@/lib/limits/ticket-state");

    const { result } = renderHook(() =>
      useMarketLimits(SLAB),
    );

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
