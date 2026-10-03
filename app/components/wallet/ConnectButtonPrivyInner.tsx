"use client";

import { FC, useCallback, useMemo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLogin, usePrivy, type LinkedAccountWithMetadata } from "@privy-io/react-auth";
import { useFundWallet, useWallets } from "@privy-io/react-auth/solana";
import { getConfig } from "@/lib/config";
import { usePreferredWallet, resolveActiveWallet } from "@/hooks/usePreferredWallet";
import { buildSolflareBrowseUrl } from "@/lib/solflare";
import { usePrivyLogin } from "@/hooks/usePrivySafe";
import { useSignInLoopRecovery } from "@/hooks/useSignInLoopRecovery";
import { resetPrivyConnection } from "@/lib/privy-reset";
import { isReconnectFallbackEligible, useWalletNeedsReconnect } from "@/hooks/useWalletNeedsReconnect";

/**
 * Privy-backed connect button. Split into its own module (loaded via
 * next/dynamic from ConnectButton) so `@privy-io/react-auth` — and its
 * transitive WalletConnect/Coinbase/viem graph — is NOT pulled into the shared
 * client bundle by every page that renders a ConnectButton. Only fetched, as a
 * separate async chunk, when Privy is actually the active wallet provider.
 * Ported verbatim from the former inline `ConnectButtonPrivyInner`.
 */
export const ConnectButtonPrivyInner: FC = () => {
  const { ready, authenticated, logout, exportWallet, user } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { fundWallet } = useFundWallet();
  const { preferredAddress, setPreferredAddress } = usePreferredWallet();
  const searchParams = useSearchParams();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeWallet = useMemo(() => {
    return resolveActiveWallet(wallets, preferredAddress);
  }, [wallets, preferredAddress]);

  // PrivyLoginBridge's action: connectWallet() while a Privy session exists.
  const reconnectWallet = usePrivyLogin();

  // Session restored but no wallet that can sign (e.g. extension locked
  // overnight). Before this the button kept rendering the linked address from
  // `user.wallet`, so the header looked connected while every other Connect
  // CTA saw `connected === false`.
  const needsReconnect = useWalletNeedsReconnect({
    privyReady: ready,
    authenticated,
    walletsReady: walletsReady === true,
    hasActiveWallet: !!activeWallet,
    fallbackEligible: isReconnectFallbackEligible(user?.linkedAccounts),
  });

  // "Connect loops": the session the user just signed in with is dropped again right away.
  const { needsReset, noteConnectAttempt, noteUserLogout } = useSignInLoopRecovery({
    ready,
    authenticated,
  });

  const { login } = useLogin({
    onComplete: ({ loginAccount }) => {
      // `loginAccount` is the account actually used for this login flow.
      // Bind that wallet explicitly instead of relying on linked-wallet order
      // or `user.wallet`, which may still point at a previously-linked wallet.
      if (loginAccount?.type === "wallet" && loginAccount.chainType === "solana") {
        setPreferredAddress(loginAccount.address);
      }
    },
  });

  const displayAddress = useMemo(() => {
    // activeWallet can be transiently null right after Privy authenticates (the
    // `wallets` array hasn't populated / preferredAddress hasn't matched yet).
    // Fall back to the user's primary/linked wallet so the button never renders
    // as an empty accent-colored block. See line ~98.
    const addr =
      activeWallet?.address ??
      user?.wallet?.address ??
      user?.linkedAccounts?.find(
        (a): a is WalletLinkedAccount => a.type === "wallet",
      )?.address;
    if (!addr) return "";
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }, [activeWallet, user]);

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
      noteConnectAttempt();
      login({ loginMethods: ["wallet", "email"], walletChainType: "solana-only" });
      return;
    }
    setMenuOpen((v) => !v);
  }, [authenticated, login, noteConnectAttempt]);

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

  if (needsReconnect) {
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={() => reconnectWallet()}
          data-testid="wallet-connect"
          data-state="reconnect"
          className="min-h-10 rounded-sm border border-[var(--warning)]/50 bg-[var(--warning)]/10 px-4 text-[13px] font-medium text-[var(--text)] transition-all duration-200 hover:bg-[var(--warning)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
          aria-label="Reconnect wallet"
          title={displayAddress ? `Reconnect ${displayAddress}` : undefined}
        >
          Reconnect wallet
        </button>
        <button
          onClick={() => {
            setPreferredAddress(null);
            noteUserLogout();
            logout();
          }}
          className="min-h-10 rounded-sm border border-[var(--border)] px-2 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label="Disconnect"
          title="Disconnect"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        data-testid="wallet-connect"
        data-state={authenticated ? "connected" : "disconnected"}
        onClick={handleClick}
        className={[
          "min-h-10 max-w-[10rem] truncate rounded-sm border px-4 text-[13px] font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
          authenticated
            ? "text-[var(--accent)] border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] hover:bg-[var(--accent)]/[0.12]"
            : "text-[var(--text)] border-[var(--accent)] bg-[var(--accent)]/20 hover:bg-[var(--accent)]/30",
        ].join(" ")}
        aria-label={authenticated ? `Wallet: ${displayAddress || "connected"}` : "Connect wallet"}
      >
        {authenticated ? (displayAddress || "Wallet") : "Connect"}
      </button>

      {!authenticated && needsReset ? (
        <button
          type="button"
          data-testid="wallet-reset"
          onClick={() => {
            setPreferredAddress(null);
            noteUserLogout();
            void resetPrivyConnection(logout);
          }}
          title="Clears the saved wallet sign-in from this browser and reloads. You will then connect again."
          className="absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-sm border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[11px] text-[var(--text-secondary)] underline hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Reset wallet connection
        </button>
      ) : null}

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
          {/* Privy funding is mainnet-only (canFund), so on devnet "Add funds" was always disabled and
              the menu had no way to test funds. Same link as the wallet-adapter menu. */}
          {network === "mainnet" ? (
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
          ) : (
            <Link
              href="/faucet"
              onClick={() => setMenuOpen(false)}
              className="block w-full px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] rounded-sm transition-colors"
            >
              Get test funds
            </Link>
          )}
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
              setPreferredAddress(null);
              noteUserLogout();
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
