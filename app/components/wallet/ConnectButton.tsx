"use client";

import { FC, useCallback, useMemo, useState, useRef, useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";

/**
 * Privy-backed wallet connect button — replaces WalletMultiButton.
 * Shows truncated address when connected, opens Privy modal when not.
 * Gracefully degrades when Privy is not available (no app ID).
 */
export const ConnectButton: FC = () => {
  const privyAvailable = usePrivyAvailable();

  if (!privyAvailable) {
    return (
      <button
        disabled
        className="rounded-sm px-4 py-1.5 text-[13px] font-medium text-[var(--text-muted)] border border-[var(--border)] opacity-50"
        aria-label="Wallet unavailable"
      >
        Connect
      </button>
    );
  }

  return <ConnectButtonInner />;
};

/**
 * Inner component that uses Privy hooks. Only rendered when PrivyProvider is mounted.
 */
const ConnectButtonInner: FC = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeWallet = useMemo(() => {
    if (!wallets.length) return null;
    // Prefer external wallets over Privy embedded
    return wallets.find((w) => !w.standardWallet?.name?.toLowerCase().includes("privy")) || wallets[0];
  }, [wallets]);

  const displayAddress = useMemo(() => {
    if (!activeWallet) return "";
    const addr = activeWallet.address;
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }, [activeWallet]);

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

  const handleClick = useCallback(() => {
    if (!authenticated) {
      login();
    } else {
      setMenuOpen((v) => !v);
    }
  }, [authenticated, login]);

  if (!ready) {
    return (
      <button
        disabled
        className="rounded-sm px-4 py-1.5 text-[13px] font-medium text-[var(--text-muted)] border border-[var(--border)] opacity-50"
      >
        Loading…
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={handleClick}
        className={[
          "rounded-sm px-4 py-1.5 text-[13px] font-medium transition-all duration-200 border",
          authenticated
            ? "text-[var(--accent)] border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] hover:bg-[var(--accent)]/[0.12]"
            : "text-white border-[var(--accent)] bg-[var(--accent)]/20 hover:bg-[var(--accent)]/30",
        ].join(" ")}
        aria-label={authenticated ? `Wallet: ${displayAddress}` : "Connect wallet"}
      >
        {authenticated ? displayAddress : "Connect"}
      </button>

      {menuOpen && authenticated && (
        <div className="absolute right-0 top-full mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg)] p-1 shadow-lg z-50">
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)] font-mono truncate">
            {activeWallet?.address}
          </div>
          <div className="h-px bg-[var(--border)] my-1" />
          <button
            onClick={() => {
              navigator.clipboard.writeText(activeWallet?.address ?? "");
              setMenuOpen(false);
            }}
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] rounded-sm transition-colors"
          >
            Copy address
          </button>
          <button
            onClick={() => {
              logout();
              setMenuOpen(false);
            }}
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--error)] hover:bg-[var(--error)]/[0.06] rounded-sm transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
};
