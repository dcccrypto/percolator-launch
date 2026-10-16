"use client";

import {
  Component,
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PrivyAvailableContext, PrivyLoginContext, PrivySessionHeadersContext } from "@/hooks/usePrivySafe";
import { PRIVY_NOT_READY, PrivyBridgeContext, type PrivyBridgeValue } from "@/hooks/usePrivyBridge";
import { READ_ONLY_WALLET_API, WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import type { PrivyBridgeSnapshot } from "./PrivyProviderClient";

/**
 * Catches a PrivyProvider crash (invalid app id, network, SDK failure) and tells the host, which then
 * runs the app without wallet capability (read-only) instead of leaving it unusable.
 */
class PrivyErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn("[WalletProvider] Privy initialization failed, running in read-only mode:", error.message);
    this.props.onError();
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Loaded lazily and only after hydration: the Privy SDK is never evaluated on the server. */
const loadPrivyProviderClient = () => import("./PrivyProviderClient");
const LazyPrivyProviderClient = lazy(loadPrivyProviderClient);

/**
 * Memoized so a publish (which re-renders the host) never re-renders the Privy tree: the bridge
 * publishes from an effect, and re-rendering it on its own publish could loop whenever a Privy hook
 * hands back a fresh object per render.
 */
const PrivySibling = memo(function PrivySibling({
  appId,
  onPublish,
}: {
  appId: string;
  onPublish: (snapshot: PrivyBridgeSnapshot) => void;
}) {
  return <LazyPrivyProviderClient appId={appId} onPublish={onPublish} />;
});

/** While Privy loads, wallet-dependent UI shows its pending state (connecting) rather than "connect". */
const PENDING_WALLET_API: WalletApi = { ...READ_ONLY_WALLET_API, connecting: true };

/** A connect() asked for before Privy was up is replayed once it is, for this long. */
const PENDING_CONNECT_TTL_MS = 15_000;

/**
 * Privy path of WalletProvider.
 *
 * The app (`children`) is rendered here, OUTSIDE PrivyProvider, in the same tree position on the
 * server and on the client. PrivyProvider's internal tree shifts the React useId of every
 * descendant, which is why the app used to be client-rendered whole under a Privy app id (the
 * server HTML body was empty). Now PrivyProvider is mounted client-side as a SIBLING after hydration
 * and renders only a bridge component; the bridge publishes Privy's state and actions into our own
 * contexts (hooks/usePrivyBridge.ts, WalletApiContext, PrivyLoginContext, PrivySessionHeadersContext).
 * Privy's modals portal out of the tree, so they work from the sibling.
 *
 * The server and the hydration pass render exactly `{children}` plus an empty second slot; the
 * contexts hold stable "not ready" values until the bridge reports in.
 */
export function PrivyBridgeHost({ appId, children }: { appId: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<PrivyBridgeSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Start the chunk download and mount the sibling right after hydration.
  useEffect(() => {
    void loadPrivyProviderClient();
    setMounted(true);
  }, []);

  const onPublish = useCallback((next: PrivyBridgeSnapshot) => setSnapshot(next), []);
  const onError = useCallback(() => {
    setFailed(true);
    setSnapshot(null);
  }, []);

  // connect(): stable identity; replays a click made before Privy was up.
  const snapshotRef = useRef<PrivyBridgeSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const pendingConnectAt = useRef<number | null>(null);
  const connect = useCallback(() => {
    const s = snapshotRef.current;
    if (s?.privy.ready) {
      s.connect();
      return;
    }
    pendingConnectAt.current = Date.now();
  }, []);
  useEffect(() => {
    const at = pendingConnectAt.current;
    if (at === null || !snapshot?.privy.ready) return;
    // A restored session needs its wallets resolved before we know whether a prompt is wanted.
    if (snapshot.privy.authenticated && !snapshot.privy.walletsReady) return;
    pendingConnectAt.current = null;
    if (Date.now() - at > PENDING_CONNECT_TTL_MS) return;
    if (snapshot.privy.authenticated && snapshot.walletApi.connected) return;
    snapshot.connect();
  }, [snapshot]);

  const sessionHeaders = useCallback(async () => {
    const s = snapshotRef.current;
    return s ? s.sessionHeaders() : null;
  }, []);

  const walletApi = snapshot?.walletApi ?? (failed ? READ_ONLY_WALLET_API : PENDING_WALLET_API);
  const privy: PrivyBridgeValue = snapshot?.privy ?? PRIVY_NOT_READY;
  const available = !failed;
  const loginAction = useMemo(() => (failed ? null : connect), [failed, connect]);
  const sessionAction = useMemo(() => (failed ? null : sessionHeaders), [failed, sessionHeaders]);

  return (
    <PrivyAvailableContext.Provider value={available}>
      <PrivyLoginContext.Provider value={loginAction}>
        <PrivySessionHeadersContext.Provider value={sessionAction}>
          <WalletApiContext.Provider value={walletApi}>
            <PrivyBridgeContext.Provider value={privy}>
              {children}
              {mounted && !failed ? (
                <PrivyErrorBoundary onError={onError}>
                  <Suspense fallback={null}>
                    <PrivySibling appId={appId} onPublish={onPublish} />
                  </Suspense>
                </PrivyErrorBoundary>
              ) : null}
            </PrivyBridgeContext.Provider>
          </WalletApiContext.Provider>
        </PrivySessionHeadersContext.Provider>
      </PrivyLoginContext.Provider>
    </PrivyAvailableContext.Provider>
  );
}
