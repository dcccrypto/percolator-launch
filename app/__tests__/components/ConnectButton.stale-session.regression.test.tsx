/**
 * Regression: after an overnight idle the header still showed the wallet
 * address (rendered from Privy's `user.wallet`, which survives with the
 * session) while no Solana wallet was actually connected, so nothing could
 * sign and the rest of the site showed Connect. The header must show the real
 * state — "Reconnect wallet" — and its click must re-prompt the wallet.
 * See PrivyLoginBridge.stale-session.regression.test.tsx for the mechanism.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUsePrivy,
  mockUseWallets,
  mockLogout,
  mockSetPreferredAddress,
} = vi.hoisted(() => ({
  mockUsePrivy: vi.fn(),
  mockUseWallets: vi.fn(),
  mockLogout: vi.fn(),
  mockSetPreferredAddress: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/usePreferredWallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePreferredWallet")>();
  return {
    ...actual,
    usePreferredWallet: () => ({
      preferredAddress: "PHANTOM_LINKED_ADDRESS",
      setPreferredAddress: mockSetPreferredAddress,
    }),
  };
});
vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => mockUsePrivy(),
  useLogin: () => ({ login: vi.fn() }),
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => mockUseWallets(),
  useFundWallet: () => ({ fundWallet: vi.fn() }),
}));

import { ConnectButtonPrivyInner } from "@/components/wallet/ConnectButtonPrivyInner";
import { PrivyLoginContext } from "@/hooks/usePrivySafe";
import {
  RECONNECT_GRACE_MS,
  RECONNECT_FALLBACK_MS,
  isStaleWalletSession,
  isReconnectFallbackEligible,
} from "@/hooks/useWalletNeedsReconnect";

const STALE_SESSION = {
  ready: true,
  authenticated: true,
  logout: mockLogout,
  exportWallet: vi.fn(),
  user: {
    wallet: { address: "PHANTOM_LINKED_ADDRESS" },
    linkedAccounts: [
      { type: "wallet", chainType: "solana", walletClientType: "phantom", address: "PHANTOM_LINKED_ADDRESS" },
    ],
  },
};

const EMBEDDED_ACCOUNT = {
  type: "wallet",
  chainType: "solana",
  walletClientType: "privy",
  address: "EMBEDDED_ADDRESS",
};
const EMAIL_ACCOUNT = { type: "email", address: "a@b.co" };

const PHANTOM = { address: "PHANTOM_LINKED_ADDRESS", standardWallet: { name: "Phantom" } };

function renderHeader(reconnect = vi.fn()) {
  const utils = render(
    <PrivyLoginContext.Provider value={reconnect}>
      <ConnectButtonPrivyInner />
    </PrivyLoginContext.Provider>,
  );
  return { ...utils, reconnect };
}

function passGrace() {
  act(() => {
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
  });
}

describe("ConnectButtonPrivyInner — stale Privy session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUsePrivy.mockReturnValue(STALE_SESSION);
    mockUseWallets.mockReturnValue({ ready: true, wallets: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'Reconnect wallet' instead of the linked address, and clicking it re-prompts the wallet", () => {
    const { reconnect } = renderHeader();
    passGrace();

    expect(screen.queryByText("PHAN...RESS")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect wallet" }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("offers a one-click disconnect that clears the preferred wallet and logs out", () => {
    renderHeader();
    passGrace();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(mockSetPreferredAddress).toHaveBeenCalledWith(null);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("does not flash Reconnect during the grace window of a normal page load", () => {
    renderHeader();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    });
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
  });

  it("returns to the address as soon as the wallet reconnects", () => {
    const { rerender } = renderHeader();
    passGrace();
    expect(screen.getByRole("button", { name: "Reconnect wallet" })).toBeTruthy();

    mockUseWallets.mockReturnValue({ ready: true, wallets: [PHANTOM] });
    rerender(
      <PrivyLoginContext.Provider value={vi.fn()}>
        <ConnectButtonPrivyInner />
      </PrivyLoginContext.Provider>,
    );

    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
    expect(screen.getByText("PHAN...RESS")).toBeTruthy();
  });

  // ── negative controls: states that must NOT be called stale ──────────────

  it("a live wallet keeps the normal address button", () => {
    mockUseWallets.mockReturnValue({ ready: true, wallets: [PHANTOM] });
    renderHeader();
    passGrace();
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
    expect(screen.getByText("PHAN...RESS")).toBeTruthy();
  });

  it("while Privy is still restoring connectors (wallets not ready) it is not stale", () => {
    mockUseWallets.mockReturnValue({ ready: false, wallets: [] });
    renderHeader();
    passGrace();
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
  });

  // Live on the playground (2026-10-02): after an idle session the header kept the linked address
  // while every Connect gate said "connect". Privy never reported walletsReady, which was the only
  // thing holding the stale check back.
  it("wallets never report ready: Reconnect shows after the fallback, not the stale address", () => {
    mockUseWallets.mockReturnValue({ ready: false, wallets: [] });
    renderHeader();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_FALLBACK_MS - 1);
    });
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Reconnect wallet" })).toBeTruthy();
    expect(screen.queryByText("PHAN...RESS")).toBeNull();
  });

  it("CONTROL: a wallet that turns up during the fallback wait never shows Reconnect", () => {
    mockUseWallets.mockReturnValue({ ready: false, wallets: [] });
    const { rerender } = renderHeader();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_FALLBACK_MS - 1000);
    });
    mockUseWallets.mockReturnValue({ ready: false, wallets: [PHANTOM] });
    rerender(
      <PrivyLoginContext.Provider value={vi.fn()}>
        <ConnectButtonPrivyInner />
      </PrivyLoginContext.Provider>,
    );
    act(() => {
      vi.advanceTimersByTime(RECONNECT_FALLBACK_MS);
    });
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
    expect(screen.getByText("PHAN...RESS")).toBeTruthy();
  });

  // Review correction: the fallback is for external-wallet sessions only.
  it("NEGATIVE: embedded Privy wallet session never gets the fallback Reconnect, however long wallets lag", () => {
    mockUsePrivy.mockReturnValue({
      ...STALE_SESSION,
      user: { wallet: { address: "EMBEDDED_ADDRESS" }, linkedAccounts: [EMAIL_ACCOUNT, EMBEDDED_ACCOUNT] },
    });
    mockUseWallets.mockReturnValue({ ready: false, wallets: [] });
    renderHeader();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_FALLBACK_MS * 3);
    });
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
  });

  it("NEGATIVE: fresh AutoSignIn email session (embedded wallet still being created) is not stale", () => {
    mockUsePrivy.mockReturnValue({
      ...STALE_SESSION,
      user: { wallet: undefined, linkedAccounts: [EMAIL_ACCOUNT] },
    });
    mockUseWallets.mockReturnValue({ ready: false, wallets: [] });
    renderHeader();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_FALLBACK_MS * 3);
    });
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
  });

  it("CONTROL: the same lagging state WITH an external wallet linked does show Reconnect", () => {
    mockUseWallets.mockReturnValue({ ready: false, wallets: [] });
    renderHeader();
    act(() => {
      vi.advanceTimersByTime(RECONNECT_FALLBACK_MS);
    });
    expect(screen.getByRole("button", { name: "Reconnect wallet" })).toBeTruthy();
  });

  it("with no session it is the plain Connect button", () => {
    mockUsePrivy.mockReturnValue({ ...STALE_SESSION, authenticated: false, user: null });
    renderHeader();
    passGrace();
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});

describe("isReconnectFallbackEligible", () => {
  const ext = { type: "wallet", chainType: "solana", walletClientType: "solflare" };
  const emb = { type: "wallet", chainType: "solana", walletClientType: "privy" };
  it.each([
    [[ext], true],
    [[ext, { type: "email" }], true],
    [[ext, emb], false],
    [[emb], false],
    [[{ type: "email" }], false],
    [[{ ...ext, chainType: "ethereum" }], false],
    [[], false],
    [null, false],
    [undefined, false],
  ])("%j → %s", (accounts, expected) => {
    expect(isReconnectFallbackEligible(accounts as never)).toBe(expected);
  });
});

describe("isStaleWalletSession", () => {
  const base = { privyReady: true, authenticated: true, walletsReady: true, hasActiveWallet: false };
  it.each([
    [base, true],
    [{ ...base, hasActiveWallet: true }, false],
    [{ ...base, authenticated: false }, false],
    [{ ...base, walletsReady: false }, false],
    [{ ...base, privyReady: false }, false],
  ])("%o → %s", (signals, expected) => {
    expect(isStaleWalletSession(signals)).toBe(expected);
  });
});
