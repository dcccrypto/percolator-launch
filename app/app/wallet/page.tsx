"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useCallback } from "react";
import { usePrivy, type LinkedAccountWithMetadata } from "@privy-io/react-auth";
import { useFundWallet, useWallets } from "@privy-io/react-auth/solana";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowButton } from "@/components/ui/GlowButton";
import { CopyableAddress } from "@/components/ui/CopyableAddress";
import { InfoBanner } from "@/components/ui/InfoBanner";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import {
  usePreferredWallet,
  resolveActiveWallet,
} from "@/hooks/usePreferredWallet";
import { getConfig } from "@/lib/config";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { WalletDebugPanel } from "@/components/wallet/WalletDebugPanel";

type WalletLinkedAccount = Extract<LinkedAccountWithMetadata, { type: "wallet" }>;

function isEmbeddedSolanaWallet(account: LinkedAccountWithMetadata): account is WalletLinkedAccount {
  return (
    account.type === "wallet" &&
    account.walletClientType === "privy" &&
    account.chainType === "solana"
  );
}

export default function WalletPage() {
  useEffect(() => {
    document.title = "Wallet — Percolator";
  }, []);

  const privyAvailable = usePrivyAvailable();

  if (!privyAvailable) {
    return (
      <WalletLayout>
        <InfoBanner variant="warning">Wallet features unavailable — Privy is not configured.</InfoBanner>
        <GlassCard className="mt-6 text-center">
          <p className="text-[13px] text-[var(--text-secondary)]">
            Connecting a wallet is disabled in this environment. Set <span className="text-[var(--text)]">NEXT_PUBLIC_PRIVY_APP_ID</span> to enable wallet management.
          </p>
        </GlassCard>
      </WalletLayout>
    );
  }

  return <WalletPageInner />;
}

function WalletPageInner() {
  const { ready, authenticated, login, logout, connectWallet, exportWallet, user } = usePrivy();
  const { wallets } = useWallets();
  const { fundWallet } = useFundWallet();
  const { preferredAddress, setPreferredAddress } = usePreferredWallet();

  const network = useMemo(() => getConfig().network, []);

  const activeWallet = useMemo(() => {
    return resolveActiveWallet(wallets, preferredAddress);
  }, [wallets, preferredAddress]);

  const embeddedWallet = useMemo(() => {
    return user?.linkedAccounts?.find(isEmbeddedSolanaWallet);
  }, [user]);

  const canExport = !!exportWallet && !!embeddedWallet && ready && authenticated;
  const canFund = !!fundWallet && !!activeWallet && network === "mainnet";

  const handleConnect = useCallback(() => {
    if (connectWallet) {
      connectWallet({ walletChainType: "solana-only" });
    } else {
      login();
    }
  }, [connectWallet, login]);

  if (!ready) {
    return (
      <WalletLayout>
        <GlassCard className="mt-6 flex min-h-[160px] items-center justify-center">
          <p className="text-[13px] text-[var(--text-secondary)]">Loading wallet state…</p>
        </GlassCard>
      </WalletLayout>
    );
  }

  if (!authenticated) {
    return (
      <WalletLayout>
        <GlassCard className="mt-6 text-center">
          <p className="text-[13px] text-[var(--text-secondary)]">Connect your wallet to manage keys and funding.</p>
          <div className="mt-5 flex justify-center">
            <ConnectButton />
          </div>
        </GlassCard>
      </WalletLayout>
    );
  }

  return (
    <WalletLayout>
      <ScrollReveal stagger={0.08}>
        <div className="grid gap-4 lg:grid-cols-2">
          <GlassCard glow accent>
            <div className="flex items-start justify-between gap-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                  Active Wallet
                </p>
                <h2 className="mt-2 text-lg font-semibold text-white">
                  {activeWallet?.standardWallet?.name ?? "Connected Wallet"}
                </h2>
                <div className="mt-3">
                  {activeWallet?.address ? (
                    <CopyableAddress address={activeWallet.address} className="text-[12px]" />
                  ) : (
                    <span className="text-[12px] text-[var(--text-muted)]">No wallet connected</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2 text-right text-[11px] text-[var(--text-secondary)]">
                <span className="rounded-sm border border-[var(--border)] px-2 py-1 uppercase tracking-[0.2em] text-[9px]">
                  {network}
                </span>
                {embeddedWallet?.address && activeWallet?.address === embeddedWallet.address && (
                  <span className="rounded-sm border border-[var(--accent)]/30 px-2 py-1 text-[9px] uppercase tracking-[0.2em] text-[var(--accent)]">
                    embedded
                  </span>
                )}
              </div>
            </div>
          </GlassCard>

          <GlassCard>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
              Quick Actions
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <GlowButton onClick={handleConnect} variant="secondary" size="sm">
                Connect another wallet
              </GlowButton>
              <GlowButton
                onClick={async () => {
                  if (!canFund || !activeWallet) return;
                  await fundWallet({ address: activeWallet.address });
                }}
                disabled={!canFund}
                size="sm"
              >
                Add funds
              </GlowButton>
              <GlowButton
                onClick={async () => {
                  if (!canExport) return;
                  await exportWallet({ address: embeddedWallet?.address });
                }}
                disabled={!canExport}
                variant="secondary"
                size="sm"
              >
                Export key
              </GlowButton>
              <GlowButton onClick={() => logout()} variant="ghost" size="sm">
                Disconnect
              </GlowButton>
            </div>
            {!canFund && (
              <p className="mt-3 text-[11px] text-[var(--text-muted)]">
                Add funds is available on mainnet. Devnet users can grab test SOL from the faucet.
              </p>
            )}
          </GlassCard>

          <GlassCard className="lg:col-span-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                Linked Wallets
              </p>
              {wallets.length > 1 && (
                <p className="text-[10px] text-[var(--text-muted)]">
                  Click a wallet to set it as active
                </p>
              )}
            </div>
            {wallets.length === 0 ? (
              <p className="mt-4 text-[13px] text-[var(--text-secondary)]">No linked wallets yet.</p>
            ) : (
              <div className="mt-4 grid gap-2 md:grid-cols-2">
                {wallets.map((wallet) => {
                  const isEmbedded = embeddedWallet?.address === wallet.address;
                  const isActive = activeWallet?.address === wallet.address;
                  return (
                    <button
                      key={wallet.address}
                      type="button"
                      onClick={() => setPreferredAddress(wallet.address)}
                      className={[
                        "flex items-center justify-between rounded-sm border px-4 py-3 text-left transition-all duration-200",
                        isActive
                          ? "border-[var(--accent)] bg-[var(--accent)]/[0.08] ring-1 ring-[var(--accent)]/30"
                          : "border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/[0.03]",
                        wallets.length > 1 ? "cursor-pointer" : "",
                      ].join(" ")}
                    >
                      <div>
                        <p className="text-[12px] font-medium text-white">
                          {wallet.standardWallet?.name ?? (isEmbedded ? "Privy Embedded" : "External Wallet")}
                        </p>
                        <CopyableAddress address={wallet.address} className="text-[11px] text-[var(--text-secondary)]" />
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {isActive && (
                          <span className="rounded-sm border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                            active
                          </span>
                        )}
                        {isEmbedded && (
                          <span className="rounded-sm border border-[var(--accent)]/30 px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] text-[var(--accent)]">
                            embedded
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </GlassCard>

          <GlassCard>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
              Funding
            </p>
            <p className="mt-3 text-[13px] text-[var(--text-secondary)]">
              Top up your wallet balance without leaving the app.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <GlowButton
                onClick={async () => {
                  if (!canFund || !activeWallet) return;
                  await fundWallet({ address: activeWallet.address });
                }}
                disabled={!canFund}
                size="sm"
              >
                Add funds
              </GlowButton>
              {network === "devnet" && (
                <Link href="/devnet-mint">
                  <GlowButton variant="secondary" size="sm">
                    Open faucet
                  </GlowButton>
                </Link>
              )}
            </div>
            {network === "devnet" && (
              <p className="mt-3 text-[11px] text-[var(--text-muted)]">
                On devnet, use the faucet to mint test SOL.
              </p>
            )}
          </GlassCard>

          <GlassCard>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
              Security
            </p>
            <p className="mt-3 text-[13px] text-[var(--text-secondary)]">
              Export your embedded wallet key to back it up securely.
            </p>
            <div className="mt-4">
              <GlowButton
                onClick={async () => {
                  if (!canExport) return;
                  await exportWallet({ address: embeddedWallet?.address });
                }}
                disabled={!canExport}
                size="sm"
              >
                Export key
              </GlowButton>
            </div>
            {!canExport && (
              <p className="mt-3 text-[11px] text-[var(--text-muted)]">
                Key export is available for embedded wallets once you are connected.
              </p>
            )}
          </GlassCard>
        </div>
      </ScrollReveal>
    </WalletLayout>
  );
}

function WalletLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <div className="relative mx-auto max-w-5xl px-4 py-10">
        <ScrollReveal>
          <div className="mb-8">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // wallet
            </div>
            <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              Wallet Command
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              Manage connected wallets, export keys, and fund your balance.
            </p>
          </div>
        </ScrollReveal>
        {children}
        <Suspense fallback={null}>
          <WalletDebugPanel />
        </Suspense>
      </div>
    </div>
  );
}
