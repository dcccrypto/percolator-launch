"use client";

import { FC, useCallback, useMemo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { useWalletAdapterAvailable } from "@/hooks/useWalletAdapterAvailable";

/**
 * Privy-backed button is loaded on demand — its @privy-io/react-auth import (and
 * the transitive WalletConnect/Coinbase/viem graph) is a separate async chunk,
 * fetched only when Privy is the active provider, never in the shared bundle.
 */
const ConnectButtonPrivyInner = dynamic(
  () => import("./ConnectButtonPrivyInner").then((m) => m.ConnectButtonPrivyInner),
  {
    ssr: false,
    loading: () => (
      <button
        disabled
        className="min-h-10 rounded-sm border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-muted)] opacity-50"
        aria-label="Loading wallet"
      >
        Connect
      </button>
    ),
  },
);

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
    return <ConnectButtonAdapterInner />;
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

/**
 * Wallet-adapter backed connect button (no Privy).
 * Detects installed Wallet Standard extensions (Phantom, Solflare, Backpack, etc.)
 * and presents a minimal selection dropdown. Degrades gracefully to an
 * "Install Phantom" link when no extension is detected.
 */
const ConnectButtonAdapterInner: FC = () => {
  const { wallets, wallet, select, connect, disconnect, connected, publicKey, connecting } =
    useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
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

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleConnect = useCallback(
    async (walletName: string) => {
      // Type-cast: WalletName is a branded string; we know the value is valid.
      select(walletName as Parameters<typeof select>[0]);
      // connect() is async; wallet-adapter triggers it after select settles
      setMenuOpen(false);
      // Small tick to let select() propagate before connect()
      await Promise.resolve();
      try {
        await connect();
      } catch {
        // Wallet rejected or not installed — user can retry
      }
    },
    [select, connect],
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
          className="min-h-10 max-w-[10rem] truncate rounded-sm border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] px-4 text-[13px] font-medium text-[var(--accent)] transition-all duration-200 hover:bg-[var(--accent)]/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label={`Wallet: ${displayAddress}`}
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
                void navigator.clipboard.writeText(publicKey.toBase58());
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

  // Not connected — show wallet picker if extensions are available
  if (readyWallets.length === 0) {
    return (
      <a
        href="https://phantom.app"
        target="_blank"
        rel="noreferrer"
        className="min-h-10 inline-flex items-center rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20 px-4 text-[13px] font-medium text-[var(--text)] transition-all hover:bg-[var(--accent)]/30"
      >
        Install Phantom
      </a>
    );
  }

  if (readyWallets.length === 1) {
    return (
      <button
        onClick={() => void handleConnect(readyWallets[0].adapter.name)}
        className="min-h-10 rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20 px-4 text-[13px] font-medium text-[var(--text)] transition-all hover:bg-[var(--accent)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Connect {readyWallets[0].adapter.name}
      </button>
    );
  }

  // Multiple wallets available — picker dropdown
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen((v) => !v)}
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
        </div>
      )}
    </div>
  );
};
