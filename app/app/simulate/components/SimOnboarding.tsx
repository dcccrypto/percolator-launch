"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

/* ── Constants ───────────────────────────────────────────── */

const DISMISS_KEY = "percolator_sim_onboarding_dismissed";

// Read simUSDC mint from config (single source of truth)
import simMarkets from "@/config/sim-markets.json";
function getSimMint(): string {
  return simMarkets.simUSDC?.mint ?? process.env.NEXT_PUBLIC_SIM_USDC_MINT ?? "";
}

/* ── Checkmark animation ─────────────────────────────────── */
function CheckAnim() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-[dash_0.4s_ease_forwards] text-[var(--long)]"
      style={{
        strokeDasharray: 24,
        strokeDashoffset: 0,
      }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* ── Progress bar ────────────────────────────────────────── */
function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-0.5 rounded-full bg-[var(--accent)] transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-[var(--text-dim)]">
        {done}/{total}
      </span>
    </div>
  );
}

/* ── Step card ───────────────────────────────────────────── */
interface StepCardProps {
  id: number;
  icon: string;
  title: string;
  description: string;
  done: boolean;
  active: boolean;
  action?: React.ReactNode;
  justCompleted?: boolean;
}

function StepCard({
  id,
  icon,
  title,
  description,
  done,
  active,
  action,
  justCompleted,
}: StepCardProps) {
  return (
    <div
      className={[
        "relative overflow-hidden rounded-none border p-3 transition-all duration-300",
        done
          ? "border-[var(--long)]/30 bg-[var(--long)]/[0.04]"
          : active
          ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.04] shadow-[0_0_16px_var(--accent)]/5"
          : "border-white/5 bg-white/[0.01] opacity-40",
      ].join(" ")}
    >
      {/* Completion flash overlay */}
      {justCompleted && (
        <div className="absolute inset-0 animate-ping rounded-none bg-[var(--long)]/10 duration-300" />
      )}

      {/* Step badge */}
      <div className="mb-2 flex items-center gap-2">
        <div
          className={[
            "flex h-5 w-5 items-center justify-center rounded-none border text-[9px] font-bold transition-all duration-300",
            done
              ? "border-[var(--long)]/40 bg-[var(--long)]/10 text-[var(--long)]"
              : active
              ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
              : "border-white/10 text-[var(--text-dim)]",
          ].join(" ")}
        >
          {done ? <CheckAnim /> : id}
        </div>
        <span className="text-base leading-none">{icon}</span>
      </div>

      {/* Title */}
      <p
        className={[
          "mb-1 text-[11px] font-semibold transition-colors",
          done
            ? "text-[var(--long)]"
            : active
            ? "text-[var(--text)]"
            : "text-[var(--text-dim)]",
        ].join(" ")}
      >
        {title}
      </p>

      {/* Description */}
      <p className="mb-2 text-[10px] leading-relaxed text-[var(--text-secondary)]">
        {description}
      </p>

      {/* Action slot */}
      {active && !done && action}
    </div>
  );
}

/* ── Main component ─────────────────────────────────────── */

interface Props {
  hasBalance: boolean;
  hasTraded: boolean;
  onDismiss?: () => void;
}

export function SimOnboarding({ hasBalance: hasBalanceProp, hasTraded }: Props) {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();

  const [dismissed, setDismissed] = useState(false);
  const [reopened, setReopened] = useState(false);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetDone, setFaucetDone] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number>(0);
  const [simUsdcBalance, setSimUsdcBalance] = useState<number>(0);
  const [justCompleted, setJustCompleted] = useState<number | null>(null);

  // Check localStorage dismissal on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(DISMISS_KEY);
      if (stored === "true") setDismissed(true);
    }
  }, []);

  // Poll SOL balance
  const pollSolBalance = useCallback(async () => {
    if (!publicKey || !connection) return;
    try {
      const lamports = await connection.getBalance(publicKey);
      setSolBalance(lamports / LAMPORTS_PER_SOL);
    } catch {
      // ignore
    }
  }, [publicKey, connection]);

  // Poll simUSDC ATA balance
  const pollSimUsdcBalance = useCallback(async () => {
    const mintStr = getSimMint();
    if (!publicKey || !connection || !mintStr) return;
    try {
      const mintPk = new PublicKey(mintStr);
      const ata = await getAssociatedTokenAddress(mintPk, publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      setSimUsdcBalance(Number(info.value.uiAmount ?? 0));
    } catch {
      setSimUsdcBalance(0);
    }
  }, [publicKey, connection]);

  // Recheck balances when wallet connects / every 8s
  useEffect(() => {
    if (!connected) return;
    pollSolBalance();
    pollSimUsdcBalance();
    const t = setInterval(() => {
      pollSolBalance();
      pollSimUsdcBalance();
    }, 8_000);
    return () => clearInterval(t);
  }, [connected, pollSolBalance, pollSimUsdcBalance]);

  // Track which steps just completed for animation
  const prevDoneRef = useRef<boolean[]>([]);
  const stepDone = [
    connected,
    solBalance > 0.01,
    simUsdcBalance > 0 || faucetDone || hasBalanceProp,
    hasTraded,
  ];
  useEffect(() => {
    const prev = prevDoneRef.current;
    stepDone.forEach((done, i) => {
      if (done && !prev[i]) {
        setJustCompleted(i + 1);
        setTimeout(() => setJustCompleted(null), 1000);
      }
    });
    prevDoneRef.current = [...stepDone];
  });

  const handleDismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      localStorage.setItem(DISMISS_KEY, "true");
    }
  };

  const handleReopen = () => {
    setDismissed(false);
    setReopened(true);
    if (typeof window !== "undefined") {
      localStorage.removeItem(DISMISS_KEY);
    }
  };

  const handleGetSimUSDC = async () => {
    if (!publicKey) return;
    setFaucetLoading(true);
    setFaucetError(null);
    try {
      const res = await fetch("/api/simulate/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Faucet request failed");
      }
      setFaucetDone(true);
      // re-poll balance
      setTimeout(pollSimUsdcBalance, 3_000);
    } catch (e) {
      setFaucetError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setFaucetLoading(false);
    }
  };

  // Don't render if fully done and not forcibly reopened
  const allDone = stepDone.every(Boolean);
  if (allDone && !reopened) return null;

  const currentStepIdx = stepDone.findIndex((d) => !d);
  const currentStep = currentStepIdx === -1 ? 5 : currentStepIdx + 1;
  const doneCount = stepDone.filter(Boolean).length;

  // Show "?" reopen button only if dismissed
  if (dismissed && !reopened) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={handleReopen}
          className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/40 bg-[var(--bg)] text-[var(--accent)] shadow-lg transition-all hover:border-[var(--accent)] hover:shadow-[0_0_12px_var(--accent)]/30"
          title="Show getting-started guide"
        >
          ?
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-4">
      <div className="relative border border-[var(--accent)]/20 bg-[var(--bg-elevated)] p-4">
        {/* Dismiss */}
        <button
          onClick={handleDismiss}
          className="absolute right-3 top-3 text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
          title="Dismiss"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="mb-3 flex items-center justify-between pr-6">
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--accent)]/70">
            // GET STARTED
          </div>
          <div className="hidden sm:block w-48">
            <ProgressBar done={doneCount} total={4} />
          </div>
        </div>

        {/* Mobile progress bar */}
        <div className="mb-3 block sm:hidden">
          <ProgressBar done={doneCount} total={4} />
        </div>

        {/* Step cards */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* Step 1: Connect */}
          <StepCard
            id={1}
            icon="🔗"
            title="Connect Wallet"
            description="Use any Solana wallet. Phantom or Backpack recommended."
            done={stepDone[0]}
            active={currentStep === 1}
            justCompleted={justCompleted === 1}
            action={
              <button
                onClick={() => setVisible(true)}
                className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12]"
              >
                Connect Wallet
              </button>
            }
          />

          {/* Step 2: SOL */}
          <StepCard
            id={2}
            icon="⚡"
            title="Get Devnet SOL"
            description="You need ~0.01 devnet SOL for transaction fees."
            done={stepDone[1]}
            active={currentStep === 2}
            justCompleted={justCompleted === 2}
            action={
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full border border-white/10 px-2 py-1.5 text-center text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--accent)]"
              >
                Solana Faucet →
              </a>
            }
          />

          {/* Step 3: simUSDC */}
          <StepCard
            id={3}
            icon="💵"
            title="Get simUSDC"
            description="Claim free simulated USDC — no real money at risk."
            done={stepDone[2]}
            active={currentStep === 3}
            justCompleted={justCompleted === 3}
            action={
              <>
                <button
                  onClick={handleGetSimUSDC}
                  disabled={faucetLoading || !connected}
                  className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12] disabled:opacity-50"
                >
                  {faucetLoading
                    ? "Claiming…"
                    : faucetDone
                    ? "Claimed ✓"
                    : "Claim simUSDC"}
                </button>
                {faucetError && (
                  <p className="mt-1 text-[9px] text-[var(--short)]">
                    {faucetError}
                  </p>
                )}
              </>
            }
          />

          {/* Step 4: Trade */}
          <StepCard
            id={4}
            icon="🚀"
            title="Start Trading"
            description="Open a position — explore funding, liquidations & the insurance fund."
            done={stepDone[3]}
            active={currentStep === 4}
            justCompleted={justCompleted === 4}
          />
        </div>
      </div>
    </div>
  );
}
