/**
 * The Privy bridge: PrivyProvider is a lazy SIBLING of the app (never around it), and its hooks'
 * values reach the app through our own contexts. These tests drive the real PrivyBridgeHost and the
 * real bridge over a stateful fake of the Privy SDK.
 */
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() }));

// A tiny external store standing in for Privy's internal state, so the fake hooks re-render the way
// the real ones do when Privy's state changes.
const sdk = vi.hoisted(() => {
  type State = {
    ready: boolean;
    authenticated: boolean;
    walletsReady: boolean;
    wallets: Array<{ address: string; standardWallet: { name: string } }>;
    identityToken: string | null;
    throwOnRender: boolean;
  };
  const initial = (): State => ({
    ready: false,
    authenticated: false,
    walletsReady: false,
    wallets: [],
    identityToken: null,
    throwOnRender: false,
  });
  let state = initial();
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<State>) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    reset() {
      state = initial();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    login: vi.fn(),
    connectWallet: vi.fn(),
    logout: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => "ACCESS"),
    providerMounts: vi.fn(),
  };
});

function useSdkState() {
  return useSyncExternalStore(sdk.subscribe, sdk.get, sdk.get);
}

vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => {
    if (sdk.get().throwOnRender) throw new Error("Invalid app id");
    sdk.providerMounts();
    return <div data-testid="privy-provider">{children}</div>;
  },
  usePrivy: () => {
    const s = useSdkState();
    // Fresh function identities on every render, as Privy hands out.
    return {
      ready: s.ready,
      authenticated: s.authenticated,
      user: s.authenticated ? { id: "u1", linkedAccounts: [] } : null,
      logout: (...a: unknown[]) => (sdk.logout as (...x: unknown[]) => unknown)(...a),
      exportWallet: vi.fn(),
      getAccessToken: () => sdk.getAccessToken(),
    };
  },
  useIdentityToken: () => ({ identityToken: useSdkState().identityToken }),
  useLogin: () => ({ login: (...a: unknown[]) => (sdk.login as (...x: unknown[]) => unknown)(...a) }),
  useConnectWallet: () => ({
    connectWallet: (...a: unknown[]) => (sdk.connectWallet as (...x: unknown[]) => unknown)(...a),
  }),
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useFundWallet: () => ({ fundWallet: vi.fn() }),
  useWallets: () => {
    const s = useSdkState();
    return { ready: s.walletsReady, wallets: s.wallets };
  },
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import { PrivyBridgeHost } from "@/components/providers/PrivyBridgeHost";
import { PrivyAvailableContext, usePrivyLogin, usePrivySessionHeaders } from "@/hooks/usePrivySafe";
import { PRIVY_NOT_READY, usePrivyBridge, type PrivyBridgeValue } from "@/hooks/usePrivyBridge";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { useAsyncUtilTimeout } from "../helpers/async-budget";

// Scoped waitFor budget for this suite only (see helpers/async-budget.ts).
useAsyncUtilTimeout();

const WALLET = { address: "11111111111111111111111111111111", standardWallet: { name: "Phantom" } };

/** Records every value the bridge hands out, per render. */
function Probe({ log }: { log: { privy: PrivyBridgeValue[]; api: WalletApi[]; available: boolean[] } }) {
  const privy = usePrivyBridge();
  const api = useContext(WalletApiContext);
  const available = useContext(PrivyAvailableContext);
  log.privy.push(privy);
  log.api.push(api);
  log.available.push(available);
  return <span data-testid="probe">{privy.ready ? (privy.authenticated ? "authed" : "ready") : "not-ready"}</span>;
}
const newLog = () => ({ privy: [] as PrivyBridgeValue[], api: [] as WalletApi[], available: [] as boolean[] });

beforeEach(() => {
  sdk.reset();
  vi.clearAllMocks();
});

describe("PrivyBridgeHost", () => {
  it("renders the app immediately with a stable not-ready bridge, before Privy mounts", () => {
    const log = newLog();
    render(
      <PrivyBridgeHost appId="app">
        <Probe log={log} />
      </PrivyBridgeHost>,
    );
    // The very first render already has the children, on the not-ready values.
    expect(log.privy[0]).toBe(PRIVY_NOT_READY);
    expect(log.api[0].connecting).toBe(true);
    expect(log.api[0].connected).toBe(false);
    expect(log.available[0]).toBe(true);
    expect(screen.getByTestId("probe").textContent).toBe("not-ready");
  });

  it("not ready -> ready -> authenticated: consumers re-render with each transition", async () => {
    const log = newLog();
    render(
      <PrivyBridgeHost appId="app">
        <Probe log={log} />
      </PrivyBridgeHost>,
    );
    await waitFor(() => expect(sdk.providerMounts).toHaveBeenCalled());
    expect(screen.getByTestId("probe").textContent).toBe("not-ready"); // Privy up but not ready yet

    act(() => sdk.set({ ready: true, walletsReady: true }));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
    expect(log.api.at(-1)?.connecting).toBe(false);

    act(() => sdk.set({ authenticated: true, wallets: [WALLET] }));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("authed"));
    const last = log.privy.at(-1)!;
    expect(last.user).toEqual(expect.objectContaining({ id: "u1" }));
    expect(last.wallets).toEqual([WALLET]);
    expect(log.api.at(-1)?.connected).toBe(true);
    expect(log.api.at(-1)?.publicKey?.toBase58()).toBe(WALLET.address);
  });

  it("the wallet list updates reach consumers", async () => {
    const log = newLog();
    sdk.set({ ready: true, authenticated: true, walletsReady: true, wallets: [] });
    render(
      <PrivyBridgeHost appId="app">
        <Probe log={log} />
      </PrivyBridgeHost>,
    );
    await waitFor(() => expect(log.privy.at(-1)?.authenticated).toBe(true));
    expect(log.privy.at(-1)?.wallets).toEqual([]);
    act(() => sdk.set({ wallets: [WALLET] }));
    await waitFor(() => expect(log.privy.at(-1)?.wallets).toEqual([WALLET]));
  });

  it("the actions keep one identity across every Privy state change (effects and SWR keys depend on them)", async () => {
    const log = newLog();
    render(
      <PrivyBridgeHost appId="app">
        <Probe log={log} />
      </PrivyBridgeHost>,
    );
    act(() => sdk.set({ ready: true }));
    await waitFor(() => expect(log.privy.at(-1)?.ready).toBe(true));
    const first = log.privy.at(-1)!;
    act(() => sdk.set({ authenticated: true, walletsReady: true, wallets: [WALLET], identityToken: "ID" }));
    await waitFor(() => expect(log.privy.at(-1)?.identityToken).toBe("ID"));
    const later = log.privy.at(-1)!;
    expect(later).not.toBe(first);
    for (const k of ["logout", "exportWallet", "getAccessToken", "fundWallet", "login", "connectWallet"] as const) {
      expect(later[k]).toBe(first[k]);
    }
    // ...and they still call the LATEST Privy function.
    await later.getAccessToken();
    expect(sdk.getAccessToken).toHaveBeenCalled();
    await later.logout();
    expect(sdk.logout).toHaveBeenCalledTimes(1);
  });

  it("does not re-render consumers when nothing changed (no publish loop)", async () => {
    const log = newLog();
    render(
      <PrivyBridgeHost appId="app">
        <Probe log={log} />
      </PrivyBridgeHost>,
    );
    act(() => sdk.set({ ready: true }));
    await waitFor(() => expect(log.privy.at(-1)?.ready).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const n = log.privy.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(log.privy.length).toBe(n);
  });

  it("the app is never remounted when Privy comes up (hydrated server markup stays)", async () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();
    function Mount() {
      useEffect(() => {
        mounts();
        return unmounts;
      }, []);
      return null;
    }
    render(
      <PrivyBridgeHost appId="app">
        <Mount />
        <Probe log={newLog()} />
      </PrivyBridgeHost>,
    );
    act(() => sdk.set({ ready: true, authenticated: true, walletsReady: true, wallets: [WALLET] }));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("authed"));
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
  });

  it("the app is NOT inside PrivyProvider (it is a sibling)", async () => {
    render(
      <PrivyBridgeHost appId="app">
        <Probe log={newLog()} />
      </PrivyBridgeHost>,
    );
    await screen.findByTestId("privy-provider");
    expect(screen.getByTestId("privy-provider").contains(screen.getByTestId("probe"))).toBe(false);
  });

  describe("connect action", () => {
    function Cta() {
      const connect = usePrivyLogin();
      return <button onClick={() => connect()}>go</button>;
    }

    it("no session: login(); session without a wallet: connectWallet()", async () => {
      render(
        <PrivyBridgeHost appId="app">
          <Cta />
        </PrivyBridgeHost>,
      );
      act(() => sdk.set({ ready: true, walletsReady: true }));
      await waitFor(() => expect(sdk.providerMounts).toHaveBeenCalled());
      await act(async () => {});
      fireEvent.click(screen.getByText("go"));
      expect(sdk.login).toHaveBeenCalledTimes(1);
      expect(sdk.connectWallet).not.toHaveBeenCalled();

      act(() => sdk.set({ authenticated: true }));
      await act(async () => {});
      fireEvent.click(screen.getByText("go"));
      expect(sdk.connectWallet).toHaveBeenCalledWith({ walletChainType: "solana-only" });
      expect(sdk.login).toHaveBeenCalledTimes(1);
    });

    it("a click made before Privy is ready is replayed once it is (AutoSignIn after the waitlist hand-off)", async () => {
      render(
        <PrivyBridgeHost appId="app">
          <Cta />
        </PrivyBridgeHost>,
      );
      fireEvent.click(screen.getByText("go")); // Privy not even mounted yet
      expect(sdk.login).not.toHaveBeenCalled();
      act(() => sdk.set({ ready: true, walletsReady: true }));
      await waitFor(() => expect(sdk.login).toHaveBeenCalledTimes(1));
    });

    it("a replayed click does not prompt when the restored session turns out to be connected", async () => {
      render(
        <PrivyBridgeHost appId="app">
          <Cta />
        </PrivyBridgeHost>,
      );
      fireEvent.click(screen.getByText("go"));
      act(() => sdk.set({ ready: true, authenticated: true, walletsReady: true, wallets: [WALLET] }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(sdk.login).not.toHaveBeenCalled();
      expect(sdk.connectWallet).not.toHaveBeenCalled();
    });

    it("has one identity for the life of the page", async () => {
      const seen = new Set<() => void>();
      function Id() {
        seen.add(usePrivyLogin());
        return null;
      }
      // usePrivyLogin wraps the context action in its own callback keyed on it, so identity-stable
      // means a single value across Privy's transitions.
      render(
        <PrivyBridgeHost appId="app">
          <Id />
        </PrivyBridgeHost>,
      );
      act(() => sdk.set({ ready: true }));
      await act(async () => {});
      act(() => sdk.set({ authenticated: true }));
      await act(async () => {});
      expect(seen.size).toBe(1);
    });
  });

  it("session headers: null until Privy is up, then the Bearer token; one identity throughout", async () => {
    let getter: ReturnType<typeof usePrivySessionHeaders> = null;
    const identities = new Set<unknown>();
    function Headers() {
      getter = usePrivySessionHeaders();
      identities.add(getter);
      return null;
    }
    render(
      <PrivyBridgeHost appId="app">
        <Headers />
      </PrivyBridgeHost>,
    );
    expect(await getter!()).toBeNull();
    act(() => sdk.set({ ready: true, authenticated: true, identityToken: "ID" }));
    await waitFor(async () => expect(await getter!()).toEqual({ Authorization: "Bearer ACCESS", "x-privy-id-token": "ID" }));
    expect(identities.size).toBe(1);
  });

  describe("when Privy fails to initialise", () => {
    it("falls back to read-only without remounting the app, and warns", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      sdk.set({ throwOnRender: true });
      const mounts = vi.fn();
      function Mount() {
        useEffect(() => {
          mounts();
        }, []);
        return null;
      }
      const log = newLog();
      render(
        <PrivyBridgeHost appId="bad">
          <Mount />
          <Probe log={log} />
        </PrivyBridgeHost>,
      );
      await waitFor(() => expect(log.available.at(-1)).toBe(false));
      expect(log.api.at(-1)?.connecting).toBe(false);
      expect(log.api.at(-1)?.connected).toBe(false);
      expect(log.privy.at(-1)).toBe(PRIVY_NOT_READY);
      expect(screen.getByTestId("probe")).toBeTruthy();
      expect(mounts).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Privy initialization failed"), expect.any(String));
      warn.mockRestore();
      err.mockRestore();
    });
  });
});
