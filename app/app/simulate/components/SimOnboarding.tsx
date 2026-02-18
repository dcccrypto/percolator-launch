"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

interface Step {
  id: number;
  title: string;
  description: string;
  actionLabel?: string;
  action?: () => void | Promise<void>;
  checkDone?: () => boolean;
  linkHref?: string;
  linkLabel?: string;
  icon: string;
}

interface Props {
  hasBalance: boolean;
  hasTraded: boolean;
  onDismiss?: () => void;
}

export function SimOnboarding({ hasBalance, hasTraded, onDismiss }: Props) {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetDone, setFaucetDone] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Don't show if user has already traded
  if (hasTraded || dismissed) return null;

  const handleGetSimUSDC = async () => {
    if (!publicKey) return;
    setFaucetLoading(true);
    setFaucetError(null);
    try {
      const res = await fetch(`/api/faucet/simUSDC`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Faucet request failed");
      }
      setFaucetDone(true);
    } catch (e) {
      setFaucetError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setFaucetLoading(false);
    }
  };

  const steps: Step[] = [
    {
      id: 1,
      title: "Connect Wallet",
      description: "Use any Solana wallet. Phantom or Backpack recommended.",
      icon: "🔗",
      actionLabel: connected ? "Connected ✓" : "Connect Wallet",
      action: connected ? undefined : () => setVisible(true),
      checkDone: () => connected,
    },
    {
      id: 2,
      title: "Get Devnet SOL",
      description: "You need a tiny bit of devnet SOL for transaction fees (~0.01 SOL).",
      icon: "⚡",
      linkHref: "https://faucet.solana.com",
      linkLabel: "Go to Faucet →",
      checkDone: () => connected, // simple approximation
    },
    {
      id: 3,
      title: "Get simUSDC",
      description: "Claim free simulated USDC to start trading with no real money at risk.",
      icon: "💵",
      actionLabel: faucetDone || hasBalance ? "Claimed ✓" : faucetLoading ? "Claiming..." : "Claim simUSDC",
      action: faucetDone || hasBalance ? undefined : handleGetSimUSDC,
      checkDone: () => faucetDone || hasBalance,
    },
    {
      id: 4,
      title: "Start Trading",
      description: "Open a position! Explore how funding rates, liquidations, and the insurance fund work.",
      icon: "🚀",
      checkDone: () => hasTraded,
    },
  ];

  const currentStep = steps.findIndex((s) => !s.checkDone?.()) + 1;
  const allDone = steps.every((s) => s.checkDone?.());

  if (allDone) {
    return null;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-4">
      <div className="relative rounded-none border border-[var(--accent)]/20 bg-[var(--bg-elevated)] p-4">
        {/* Dismiss */}
        {onDismiss && (
          <button
            onClick={() => { setDismissed(true); onDismiss(); }}
            className="absolute right-3 top-3 text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}

        <div className="mb-3 flex items-center gap-2">
          <div className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">
            // GET STARTED
          </div>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {steps.map((step) => {
            const done = step.checkDone?.() ?? false;
            const active = step.id === currentStep;

            return (
              <div
                key={step.id}
                className={[
                  "relative rounded-none border p-3 transition-all duration-200",
                  done
                    ? "border-[var(--long)]/30 bg-[var(--long)]/5"
                    : active
                    ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.04]"
                    : "border-[var(--border)]/30 bg-[var(--bg)]/50 opacity-50",
                ].join(" ")}
              >
                {/* Step number + icon */}
                <div className="mb-2 flex items-center gap-1.5">
                  <div
                    className={[
                      "flex h-5 w-5 items-center justify-center rounded-none border text-[9px] font-bold",
                      done
                        ? "border-[var(--long)]/40 bg-[var(--long)]/10 text-[var(--long)]"
                        : active
                        ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--text-dim)]",
                    ].join(" ")}
                  >
                    {done ? "✓" : step.id}
                  </div>
                  <span className="text-sm">{step.icon}</span>
                </div>

                {/* Title */}
                <p
                  className={[
                    "mb-1 text-[11px] font-semibold",
                    done ? "text-[var(--long)]" : active ? "text-[var(--text)]" : "text-[var(--text-dim)]",
                  ].join(" ")}
                >
                  {step.title}
                </p>

                {/* Description */}
                <p className="mb-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
                  {step.description}
                </p>

                {/* Action */}
                {active && !done && (
                  <>
                    {step.action && (
                      <button
                        onClick={step.action}
                        disabled={faucetLoading}
                        className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12] disabled:opacity-50"
                      >
                        {step.actionLabel}
                      </button>
                    )}
                    {step.linkHref && (
                      <a
                        href={step.linkHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block w-full border border-[var(--border)] px-2 py-1.5 text-center text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--accent)]"
                      >
                        {step.linkLabel}
                      </a>
                    )}
                    {faucetError && (
                      <p className="mt-1 text-[9px] text-[var(--short)]">{faucetError}</p>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div className="mt-3 flex items-center gap-2">
          <div className="h-0.5 flex-1 rounded-full bg-[var(--border)]">
            <div
              className="h-0.5 rounded-full bg-[var(--accent)] transition-all duration-500"
              style={{ width: `${((currentStep - 1) / steps.length) * 100}%` }}
            />
          </div>
          <span className="text-[9px] font-medium text-[var(--text-dim)] uppercase tracking-[0.15em]">
            {currentStep - 1}/{steps.length} done
          </span>
        </div>
      </div>
    </div>
  );
}
