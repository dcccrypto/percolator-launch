"use client";

import { FC, useCallback, useMemo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { usePrivy, type LinkedAccountWithMetadata } from "@privy-io/react-auth";
import { useFundWallet, useWallets } from "@privy-io/react-auth/solana";
import { getConfig } from "@/lib/config";
import { usePreferredWallet, resolveActiveWallet } from "@/hooks/usePreferredWallet";
import { buildSolflareBrowseUrl } from "@/lib/solflare";

/**
 * Privy-backed connect button. Split into its own module (loaded via
 * next/dynamic from ConnectButton) so `@privy-io/react-auth` — and its
 * transitive WalletConnect/Coinbase/viem graph — is NOT pulled into the shared
 * client bundle by every page that renders a ConnectButton. Only fetched, as a
 * separate async chunk, when Privy is actually the active wallet provider.
 * Ported verbatim from the former inline `ConnectButtonPrivyInner`.
 */
export const ConnectButtonPrivyInner: FC = () => {
  const { ready, authenticated, login, logout, exportWallet, user } = usePrivy();
  const { wallets } = useWallets();
  const { fundWallet } = useFundWallet();
  const { preferredAddress } = usePreferredWallet();
  const searchParams = useSearchParams();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeWallet = useMemo(() => {
    return resolveActiveWallet(wallets, preferredAddress);
  }, [wallets, preferredAddress]);

  const displayAddress = useMemo(() => {
    if (!activeWallet) return "";
    const addr = activeWallet.address;
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }, [activeWallet]);

  const network = useMemo(() => getConfig().network, []);

  const embeddedWallet = useMemo(() => {
    return user?.linkedAccounts?.find(isEmbeddedSolanaWallet);
  }, [user]);

  const canExport = !!exportWallet && !!embeddedWallet && ready && authenticated;
  const canFund = !!fundWallet && !!activeWallet && network === "mainnet";

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
      login({ loginMethods: ["wallet", "email"], walletChainType: "solana-only" });
      return;
    }
    setMenuOpen((v) => !v);
  }, [authenticated, login]);

  const debugFlag = searchParams?.get("walletDebug") ?? "";
  const showDebug = DEBUG_ENABLED.has(debugFlag.toLowerCase());
  const solflareBrowseUrl =
    showDebug && typeof window !== "undefined"
      ? buildSolflareBrowseUrl(window.location.href, window.location.origin)
      : "";

  if (!ready) {
    return (
      <button
        disabled
        className="min-h-10 rounded-sm border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text-muted)] opacity-50"
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
          "min-h-10 max-w-[10rem] truncate rounded-sm border px-4 text-[13px] font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
          authenticated
            ? "text-[var(--accent)] border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] hover:bg-[var(--accent)]/[0.12]"
            : "text-[var(--text)] border-[var(--accent)] bg-[var(--accent)]/20 hover:bg-[var(--accent)]/30",
        ].join(" ")}
        aria-label={authenticated ? `Wallet: ${displayAddress}` : "Connect wallet"}
      >
        {authenticated ? displayAddress : "Connect"}
      </button>

      {!authenticated && showDebug && solflareBrowseUrl ? (
        <a
          href={solflareBrowseUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
        >
          Open in Solflare
        </a>
      ) : null}

      {menuOpen && authenticated && (
        <div className="absolute right-0 top-full mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg)] p-1 shadow-lg z-50">
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)] font-mono truncate">
            {activeWallet?.address}
          </div>
          <div className="h-px bg-[var(--border)] my-1" />
          <Link
            href="/wallet"
            onClick={() => setMenuOpen(false)}
            className="block w-full px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] rounded-sm transition-colors"
          >
            Manage Wallet
          </Link>
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
            onClick={async () => {
              if (!canFund || !activeWallet) return;
              await fundWallet({ address: activeWallet.address });
              setMenuOpen(false);
            }}
            disabled={!canFund}
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] rounded-sm transition-colors disabled:opacity-40"
          >
            Add funds
          </button>
          <button
            onClick={async () => {
              if (!canExport) return;
              await exportWallet({ address: embeddedWallet?.address });
              setMenuOpen(false);
            }}
            disabled={!canExport}
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] rounded-sm transition-colors disabled:opacity-40"
          >
            Export key
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

      {menuOpen && !authenticated && null}
    </div>
  );
};

// ── Privy helpers ───────────────────────────────────────────────────────────

type WalletLinkedAccount = Extract<LinkedAccountWithMetadata, { type: "wallet" }>;

const DEBUG_ENABLED = new Set(["1", "true", "yes"]);

function isEmbeddedSolanaWallet(account: LinkedAccountWithMetadata): account is WalletLinkedAccount {
  return (
    account.type === "wallet" &&
    account.walletClientType === "privy" &&
    account.chainType === "solana"
  );
}

export default ConnectButtonPrivyInner;
