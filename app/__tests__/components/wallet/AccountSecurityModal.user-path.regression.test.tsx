/**
 * The user's path, header wallet menu -> "Account and Security", through
 * the REAL PrivyBridgeHost and the real bridge, over a fake Privy SDK whose hooks THROW outside
 * <PrivyProvider> (as useLinkAccount / getAccessToken do in @privy-io/react-auth 3.41.0). A component
 * in the app calling a Privy hook directly fails this test; reading the bridge passes.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

const sdk = vi.hoisted(() => {
  type State = {
    ready: boolean;
    authenticated: boolean;
    walletsReady: boolean;
    wallets: unknown[];
    twitter: null | { subject: string; username: string | null };
  };
  const initial = (): State => ({ ready: false, authenticated: false, walletsReady: false, wallets: [], twitter: null });
  let state = initial();
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(p: Partial<State>) {
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    reset() {
      state = initial();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    linkTwitter: vi.fn(async (): Promise<void> => {}),
    unlink: vi.fn(async (_o: { provider: string; subject: string }): Promise<unknown> => ({})),
    getAccessToken: vi.fn(async (): Promise<string | null> => "ACCESS"),
    logout: vi.fn(async () => {}),
  };
});

vi.mock("@privy-io/react-auth", async () => {
  const React = await import("react");
  const InPrivy = React.createContext(false);
  // THE point of this harness: like the real SDK, a Privy hook outside <PrivyProvider> fails.
  const inside = (hook: string) => {
    if (!React.useContext(InPrivy)) throw new Error(`${hook} called outside <PrivyProvider>`);
  };
  const useSdk = () => React.useSyncExternalStore(sdk.subscribe, sdk.get, sdk.get);
  return {
    PrivyProvider: ({ children }: { children: ReactNode }) => <InPrivy.Provider value={true}>{children}</InPrivy.Provider>,
    usePrivy: () => {
      inside("usePrivy");
      const s = useSdk();
      return {
        ready: s.ready,
        authenticated: s.authenticated,
        user: s.authenticated ? { id: "u1", email: { address: "me@x.io" }, twitter: s.twitter, linkedAccounts: [] } : null,
        logout: () => sdk.logout(),
        linkTwitter: () => sdk.linkTwitter(),
        unlinkOAuth: (o: { provider: string; subject: string }) => sdk.unlink(o),
        exportWallet: vi.fn(),
        getAccessToken: () => sdk.getAccessToken(),
      };
    },
    useIdentityToken: () => (inside("useIdentityToken"), { identityToken: null }),
    useLogin: () => (inside("useLogin"), { login: vi.fn() }),
    useConnectWallet: () => (inside("useConnectWallet"), { connectWallet: vi.fn() }),
  };
});
vi.mock("@privy-io/react-auth/solana", async () => {
  const React = await import("react");
  return {
    toSolanaWalletConnectors: () => [],
    useFundWallet: () => ({ fundWallet: vi.fn() }),
    useWallets: () => {
      const s = React.useSyncExternalStore(sdk.subscribe, sdk.get, sdk.get);
      return { ready: s.walletsReady, wallets: s.wallets };
    },
    useSignTransaction: () => ({ signTransaction: vi.fn() }),
    useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
    useSignMessage: () => ({ signMessage: vi.fn() }),
  };
});

import { PrivyBridgeHost } from "@/components/providers/PrivyBridgeHost";
import { ConnectButtonPrivyInner } from "@/components/wallet/ConnectButtonPrivyInner";

class Catch extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    return this.state.err ? <p data-testid="crash">{this.state.err.message}</p> : this.props.children;
  }
}
const WALLET = { address: "GXjpKbhkJMgJiooFAJAn2LpeByYLD8LsaBJszbqQtxfQ", standardWallet: { name: "Phantom" } };

async function openWindow() {
  render(
    <Catch>
      <PrivyBridgeHost appId="app">
        <ConnectButtonPrivyInner />
      </PrivyBridgeHost>
    </Catch>,
  );
  act(() => sdk.set({ ready: true, authenticated: true, walletsReady: true, wallets: [WALLET] }));
  fireEvent.click(await screen.findByRole("button", { name: /wallet:/i }));
  fireEvent.click(screen.getByText("Account and Security"));
  const crash = screen.queryByTestId("crash");
  if (crash) throw new Error("app crashed: " + crash.textContent);
  return within(screen.getByRole("dialog", { name: "Account and Security" }));
}

// The host lazy-loads PrivyProviderClient: load it once here, so no test pays for it inside its own timeout.
beforeAll(() => import("@/components/providers/PrivyProviderClient"), 30_000);

beforeEach(() => {
  sdk.reset();
  vi.clearAllMocks();
  sdk.getAccessToken.mockResolvedValue("ACCESS");
  sdk.unlink.mockResolvedValue({});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ref: "PERC7Q" }))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Account and Security from the header (the app renders outside PrivyProvider)", () => {
  it("opens, with the identity and the referral code read with the access token", async () => {
    const d = await openWindow();
    expect(d.getByText("me@x.io")).toBeTruthy();
    expect(d.getByText("GXjp...txfQ")).toBeTruthy();
    expect(await d.findByText("PERC7Q")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/playground/me", expect.objectContaining({ headers: { Authorization: "Bearer ACCESS" } }));
  });

  it("Connect X starts Privy's link flow; a failure before the redirect (a rejection) is shown", async () => {
    const d = await openWindow();
    expect(d.getByText("Not connected")).toBeTruthy();
    fireEvent.click(d.getByText("Connect X"));
    expect(sdk.linkTwitter).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(d.queryByRole("alert")).toBeNull();
    sdk.linkTwitter.mockRejectedValueOnce(new Error("oauth init refused"));
    fireEvent.click(d.getByText("Connect X"));
    expect((await d.findByRole("alert")).textContent).toBe("Couldn't connect X. Try again later.");
  });

  it("a linked X shows its handle; Disconnect unlinks by subject and the row updates from Privy's user", async () => {
    sdk.set({ twitter: { subject: "12345", username: "brian" } });
    const d = await openWindow();
    expect(d.getByText("@brian")).toBeTruthy();
    sdk.unlink.mockImplementation(async () => {
      sdk.set({ twitter: null });
      return {};
    });
    fireEvent.click(d.getByText("Disconnect"));
    await waitFor(() => expect(sdk.unlink).toHaveBeenCalledWith({ provider: "twitter", subject: "12345" }));
    expect(await d.findByText("Not connected")).toBeTruthy();
  });

  it("a failed unlink keeps the handle and says so", async () => {
    sdk.set({ twitter: { subject: "12345", username: "brian" } });
    const d = await openWindow();
    sdk.unlink.mockRejectedValue(new Error("nope"));
    fireEvent.click(d.getByText("Disconnect"));
    expect((await d.findByRole("alert")).textContent).toBe("Couldn't disconnect X. Try again later.");
    expect(d.getByText("@brian")).toBeTruthy();
  });

  it("no access token: no /me read, the waitlist link instead", async () => {
    sdk.getAccessToken.mockResolvedValue(null);
    const d = await openWindow();
    expect(await d.findByRole("link", { name: "waitlist page" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signing out with the window open closes it", async () => {
    await openWindow();
    act(() => sdk.set({ authenticated: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("before Privy is up the button is Loading... and the window cannot be opened", () => {
    render(
      <PrivyBridgeHost appId="app">
        <ConnectButtonPrivyInner />
      </PrivyBridgeHost>,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Account and Security")).toBeNull();
  });
});
