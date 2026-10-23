"use client";

import { FC, useCallback, useMemo, useState, useRef, useEffect, useSyncExternalStore } from "react";
import { useToast } from "@/hooks/useToast";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";
import { copyAddress } from "@/lib/copy-address";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { useWalletAdapterAvailable } from "@/hooks/useWalletAdapterAvailable";
import { ConnectButtonPlaceholder } from "./ConnectButtonPlaceholder";
import { ConnectButtonPrivyInner } from "./ConnectButtonPrivyInner";

/**
 * Wallet connect button — backs Privy (primary) or wallet-adapter (fallback).
 *
 * Resolution:
 *   1. Privy  — shown when NEXT_PUBLIC_PRIVY_APP_ID is configured.
 *   2. Wallet-adapter — shown when Privy is absent; any Phantom/Solflare/Backpack
 *      browser extension is auto-detected and connectable without a Privy account.
 *   3. Disabled "Connect" — neither provider is available (read-only build mode).
 */
export const ConnectButton: FC = () => {
  const privyAvailable = usePrivyAvailable();
  const adapterAvailable = useWalletAdapterAvailable();

  if (privyAvailable) {
    return <ConnectButtonPrivyInner />;
  }

  if (adapterAvailable) {
    return <ConnectButtonAdapterGate />;
  }

  // Neither Privy nor wallet-adapter — read-only mode
  return (
    <button
      disabled
      className="min-h-10 rounded-sm border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-muted)] opacity-50"
      aria-label="Wallet unavailable"
    >
      Connect
    </button>
  );
};

const noopSubscribe = () => () => {};

/** The wallets the fallback picker always offers: connect when present, install link when not. */
const SUPPORTED_WALLETS = [
  { name: "Phantom", installUrl: "https://phantom.com/download" },
  { name: "Solflare", installUrl: "https://solflare.com/download" },
  { name: "Backpack", installUrl: "https://backpack.app/download" },
] as const;

/**
 * Pages are server-rendered, but which wallets this browser has (and whether a remembered one
 * auto-connects, so the button shows an address) is only known in the browser, and the
 * server pass has no wallet-adapter provider at all. So the server pass and the hydration pass both
 * render an invisible placeholder of the button's size, and the real one takes over right after
 * hydration (useSyncExternalStore: server snapshot false, client snapshot true, no mismatch).
 */
const ConnectButtonAdapterGate: FC = () => {
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  if (!hydrated) return <ConnectButtonPlaceholder />;
  return <ConnectButtonAdapterInner />;
};

/**
 * Wallet-adapter backed connect button (no Privy).
 * Detects installed Wallet Standard extensions (Phantom, Solflare, Backpack, etc.)
 * and presents a minimal selection dropdown, with install links for the supported
 * wallets this browser does not have.
 */
const ConnectButtonAdapterInner: FC = () => {
  const { wallets, wallet, select, connect, disconnect, connected, publicKey, connecting } =
    useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const { toast } = useToast();
  const setConnectError = useCallback((m: string | null) => {
    if (m) toast(m, "error");
  }, [toast]);
  const menuRef = useRef<HTMLDivElement>(null);

  const displayAddress = useMemo(() => {
    if (!publicKey) return "";
    const addr = publicKey.toBase58();
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }, [publicKey]);

  // Wallets that are installed or loadable in the current browser
  const readyWallets = useMemo(
    () =>
      wallets.filter(
        (w) =>
          w.readyState === WalletReadyState.Installed ||
          w.readyState === WalletReadyState.Loadable,
      ),
    [wallets],
  );

  // Close menu on outside click or Escape
  useMenuDismiss(menuOpen, setMenuOpen, menuRef);

  const handleConnect = useCallback(
    async (walletName: string) => {
      // Type-cast: WalletName is a branded string; we know the value is valid.
      select(walletName as Parameters<typeof select>[0]);
      // connect() is async; wallet-adapter triggers it after select settles
      setMenuOpen(false);
      // Small tick to let select() propagate before connect()
      await Promise.resolve();
      try {
        setConnectError(null);
        await connect();
      } catch (e) {
        // UX WP-10 (CN-1): never swallowed. A cancel is quiet; anything else gets one plain line.
        setConnectError(connectErrorLine(e, walletName));
      }
    },
    [select, connect, setConnectError],
  );

  if (connecting) {
    return (
      <button
        disabled
        className="min-h-10 rounded-sm border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-muted)] opacity-70"
      >
        Connecting...
      </button>
    );
  }

  if (connected && publicKey) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          data-testid="wallet-connect"
          data-state="connected"
          className="min-h-10 max-w-[10rem] truncate rounded-sm border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] px-4 text-[13px] font-medium text-[var(--accent)] transition-all duration-200 hover:bg-[var(--accent)]/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label={`Wallet: ${displayAddress}`}
          aria-expanded={menuOpen}
        >
          {displayAddress}
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg)] p-1 shadow-lg">
            <div className="truncate px-3 py-2 font-mono text-[11px] text-[var(--text-muted)]">
              {publicKey.toBase58()}
            </div>
            <div className="my-1 h-px bg-[var(--border)]" />
            <Link
              href="/faucet"
              onClick={() => setMenuOpen(false)}
              className="block w-full rounded-sm px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)]/[0.06]"
            >
              Get test funds
            </Link>
            <button
              onClick={() => {
                void copyAddress(publicKey.toBase58(), toast);
                setMenuOpen(false);
              }}
              className="w-full rounded-sm px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)]/[0.06]"
            >
              Copy address
            </button>
            <button
              onClick={() => {
                void disconnect();
                setMenuOpen(false);
              }}
              className="w-full rounded-sm px-3 py-1.5 text-left text-[13px] text-[var(--error)] transition-colors hover:bg-[var(--error)]/[0.06]"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  // Not connected: always the picker. With no extension the only ready wallet is the
  // always-Loadable Solflare adapter, and a lone "Connect Solflare" button left Phantom and
  // Backpack unreachable (v2.2 QA 2026-10-16). Supported wallets missing from this browser are
  // listed as install links.
  const missingWallets = SUPPORTED_WALLETS.filter(
    (s) => !readyWallets.some((w) => w.adapter.name === s.name),
  );
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        data-testid="wallet-connect"
        data-state="disconnected"
        aria-expanded={menuOpen}
        className="min-h-10 rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20 px-4 text-[13px] font-medium text-[var(--text)] transition-all hover:bg-[var(--accent)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Connect Wallet
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg)] p-1 shadow-lg">
          {readyWallets.map((w) => (
            <button
              key={w.adapter.name}
              onClick={() => void handleConnect(w.adapter.name)}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)]/[0.06]"
            >
              {w.adapter.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={w.adapter.icon} alt="" className="h-4 w-4 rounded-sm" />
              ) : null}
              {w.adapter.name}
            </button>
          ))}
          {readyWallets.length > 0 && missingWallets.length > 0 ? (
            <div className="my-1 h-px bg-[var(--border)]" />
          ) : null}
          {missingWallets.map((s) => (
            <a
              key={s.name}
              href={s.installUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
              className="block w-full rounded-sm px-3 py-2 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--accent)]/[0.06]"
            >
              Install {s.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * UX WP-10 (audit CN-1): one plain line for a failed connect (never swallowed). A cancel in the
 * wallet is quiet (null): the user just tries again.
 */
export function connectErrorLine(e: unknown, walletName: string): string | null {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/reject|cancel|declin|closed/i.test(msg)) return null;
  if (/not ?installed|not found|NotReady/i.test(msg)) return `${walletName} isn't installed in this browser. Install it, then connect again.`;
  if (/locked|unlock/i.test(msg)) return `Unlock ${walletName} and try again.`;
  return `Couldn't connect to ${walletName}. Try again.`;
}
