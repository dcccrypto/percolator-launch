/**
 * Regression: "left the site overnight — header still shows my wallet, every
 * Connect button elsewhere does nothing".
 *
 * Mechanism (verified against @privy-io/react-auth 3.41.0 dist):
 *  - Privy restores the SESSION from its refresh token, so `authenticated`
 *    is true after reload.
 *  - The external Solana wallet is restored only by a silent
 *    `standard:connect({ silent: true })` whose errors are swallowed; a locked
 *    extension leaves `useWallets().wallets` empty.
 *  - `useWalletCompat().connected` is `authenticated && !!activeWallet` →
 *    false, so OrderTicket / Faucet render a Connect CTA wired to
 *    `usePrivyLogin()`, which used to be Privy's raw `login()`.
 *  - `login()` with a logged-in user only `console.warn`s "Attempted to log
 *    in, but user is already logged in" and returns → dead click.
 *
 * These tests drive the REAL PrivyProviderClient bridge with Privy mocked in
 * exactly that state.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
}));

const {
  mockUsePrivy,
  mockUseWallets,
  mockLogin,
  mockConnectWallet,
  connectWalletCallbacks,
} = vi.hoisted(() => ({
  mockUsePrivy: vi.fn(),
  mockUseWallets: vi.fn(),
  mockLogin: vi.fn(),
  mockConnectWallet: vi.fn(),
  connectWalletCallbacks: { current: null as any },
}));

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: any) => <>{children}</>,
  usePrivy: () => mockUsePrivy(),
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({ login: mockLogin }),
  useConnectWallet: (callbacks: any) => {
    connectWalletCallbacks.current = callbacks;
    return { connectWallet: mockConnectWallet };
  },
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useWallets: () => mockUseWallets(),
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import PrivyProviderClient from "@/components/providers/PrivyProviderClient";
import { usePrivyLogin } from "@/hooks/usePrivySafe";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { PreferredWalletContext } from "@/hooks/usePreferredWallet";

/** Stand-in for OrderTicket's / Faucet's Privy-mode Connect CTA — the exact
 *  wiring they use: `onClick={() => usePrivyLogin()()}` shown when
 *  `!useWalletCompat().connected`. */
function ConnectCta() {
  const api = useContext(WalletApiContext);
  const connect = usePrivyLogin();
  if (api.connected) return <span>connected</span>;
  return <button onClick={() => connect()}>Connect Wallet</button>;
}

const STALE_SESSION = {
  ready: true,
  authenticated: true,
  logout: vi.fn(),
  // The linked account the header renders from — still present.
  user: { wallet: { address: "PHANTOM_LINKED_ADDRESS" }, linkedAccounts: [] },
};

function renderBridge(setPreferredAddress = vi.fn()) {
  render(
    <PreferredWalletContext.Provider
      value={{ preferredAddress: "PHANTOM_LINKED_ADDRESS", setPreferredAddress }}
    >
      <PrivyProviderClient appId="test">
        <ConnectCta />
      </PrivyProviderClient>
    </PreferredWalletContext.Provider>,
  );
  return { setPreferredAddress };
}

describe("PrivyLoginBridge — stale Privy session (authenticated, no wallet)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectWalletCallbacks.current = null;
    mockUseWallets.mockReturnValue({ ready: true, wallets: [] });
  });

  it("the Connect CTA is shown (connected=false) and its click opens connectWallet, not the no-op login", () => {
    mockUsePrivy.mockReturnValue(STALE_SESSION);
    renderBridge();

    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(mockConnectWallet).toHaveBeenCalledTimes(1);
    expect(mockConnectWallet).toHaveBeenCalledWith({ walletChainType: "solana-only" });
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("with no session the same CTA still opens the Privy login modal", () => {
    mockUsePrivy.mockReturnValue({ ...STALE_SESSION, authenticated: false, user: null });
    renderBridge();

    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockConnectWallet).not.toHaveBeenCalled();
  });

  it("binds the reconnected Solana wallet as the active signer (#2620 semantics)", () => {
    mockUsePrivy.mockReturnValue(STALE_SESSION);
    const { setPreferredAddress } = renderBridge();

    expect(connectWalletCallbacks.current?.onSuccess).toBeTypeOf("function");
    act(() => {
      connectWalletCallbacks.current.onSuccess({
        wallet: { type: "solana", address: "PHANTOM_RECONNECTED_ADDRESS" },
      });
    });

    expect(setPreferredAddress).toHaveBeenCalledTimes(1);
    expect(setPreferredAddress).toHaveBeenCalledWith("PHANTOM_RECONNECTED_ADDRESS");
  });

  it("ignores a non-Solana wallet connection (never binds an EVM address as signer)", () => {
    mockUsePrivy.mockReturnValue(STALE_SESSION);
    const { setPreferredAddress } = renderBridge();

    act(() => {
      connectWalletCallbacks.current.onSuccess({
        wallet: { type: "ethereum", address: "0xabc" },
      });
    });

    expect(setPreferredAddress).not.toHaveBeenCalled();
  });

  it("once a wallet is connected the WalletApi reports connected and no CTA renders", () => {
    mockUsePrivy.mockReturnValue(STALE_SESSION);
    mockUseWallets.mockReturnValue({
      ready: true,
      wallets: [{ address: "11111111111111111111111111111111", standardWallet: { name: "Phantom" } }],
    });
    let api: WalletApi | undefined;
    function Capture() {
      api = useContext(WalletApiContext);
      return null;
    }
    render(
      <PrivyProviderClient appId="test">
        <Capture />
        <ConnectCta />
      </PrivyProviderClient>,
    );

    expect(api?.connected).toBe(true);
    expect(screen.queryByRole("button", { name: "Connect Wallet" })).toBeNull();
  });
});
