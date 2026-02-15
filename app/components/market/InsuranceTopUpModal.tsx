"use client";

import { FC, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface InsuranceTopUpModalProps {
  slabAddress: string;
  currentBalance: string; // U128 as string
  onClose: () => void;
}

function formatUsdAmount(amountE6: string | bigint): string {
  const num = typeof amountE6 === "string" ? BigInt(amountE6) : amountE6;
  const usd = Number(num) / 1e6;
  return usd.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export const InsuranceTopUpModal: FC<InsuranceTopUpModalProps> = ({
  slabAddress,
  currentBalance,
  onClose,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const modal = modalRef.current;
    if (!overlay || !modal) return;

    if (prefersReduced) {
      overlay.style.opacity = "1";
      modal.style.opacity = "1";
      modal.style.transform = "scale(1)";
    } else {
      gsap.fromTo(
        overlay,
        { opacity: 0 },
        { opacity: 1, duration: 0.2, ease: "power2.out" }
      );
      gsap.fromTo(
        modal,
        { opacity: 0, scale: 0.95 },
        { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out" }
      );
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose, prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !loading) onClose();
  };

  const handleSubmit = async () => {
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0) {
      setError("Please enter a valid amount");
      return;
    }

    if (mockMode) {
      // Mock success
      setLoading(true);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      setTxSignature("mock-signature-abc123def456");
      setSuccess(true);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Call API to build and send transaction
      const res = await fetch("/api/insurance/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slabAddress,
          amountUsd: amountNum,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to top up insurance");
      }

      const data = await res.json();
      setTxSignature(data.signature);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const currentBalanceUsd = formatUsdAmount(currentBalance);
  const newBalanceUsd =
    amount && parseFloat(amount) > 0
      ? (parseFloat(currentBalanceUsd.replace(/,/g, "")) + parseFloat(amount)).toLocaleString()
      : currentBalanceUsd;

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div
        ref={modalRef}
        className="w-full max-w-md overflow-hidden rounded-none border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)]/50 bg-[var(--bg)] px-4 py-3">
          <h2
            className="text-lg font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Top Up Insurance Fund
          </h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="flex h-8 w-8 items-center justify-center rounded-none text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)] disabled:opacity-50"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {!success ? (
            <>
              {/* Info Banner */}
              <div className="mb-4 rounded-none border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/5 p-3">
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  Anyone can contribute to the insurance fund. Your
                  contribution helps protect all LPs and makes the market
                  safer for everyone.
                </p>
              </div>

              {/* Amount Input */}
              <div className="mb-4">
                <label
                  htmlFor="amount"
                  className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]"
                >
                  Amount (USDC)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                    $
                  </span>
                  <input
                    id="amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={loading}
                    className="w-full rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] py-2 pl-7 pr-3 text-[var(--text)] placeholder-[var(--text-dim)] transition-colors focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
                    style={{ fontFamily: "var(--font-mono)" }}
                    min="0"
                    step="0.01"
                  />
                </div>
                <div className="mt-1 flex gap-1">
                  {[100, 500, 1000, 5000].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => setAmount(preset.toString())}
                      disabled={loading}
                      className="flex-1 rounded-none border border-[var(--border)]/50 py-1 text-[9px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Balance Preview */}
              <div className="mb-4 rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-3">
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                      Current Balance
                    </span>
                    <span
                      className="text-[var(--text-secondary)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      ${currentBalanceUsd}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                      Your Contribution
                    </span>
                    <span
                      className="text-[var(--accent)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      +${amount || "0"}
                    </span>
                  </div>
                  <div className="border-t border-[var(--border)]/30 pt-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">
                        New Balance
                      </span>
                      <span
                        className="text-base font-bold text-[var(--long)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        ${newBalanceUsd}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="mb-4 rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 p-3">
                  <p className="text-[11px] text-[var(--short)]">{error}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  disabled={loading}
                  className="flex-1 rounded-none border border-[var(--border)]/50 py-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={loading || !amount || parseFloat(amount) <= 0}
                  className="flex-1 rounded-none bg-[var(--accent)] py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? "Processing..." : "Sign & Send Transaction"}
                </button>
              </div>
            </>
          ) : (
            // Success State
            <div className="text-center">
              <div className="mb-4 flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--long)]/10">
                  <span className="inline-block w-8 h-8 rounded-full bg-[var(--long)]" />
                </div>
              </div>
              <h3 className="mb-2 text-lg font-bold text-[var(--text)]">
                Top-Up Successful!
              </h3>
              <p className="mb-4 text-sm text-[var(--text-secondary)]">
                You contributed <strong>${amount}</strong> to the insurance
                fund. Thank you for making Percolator safer!
              </p>
              {txSignature && (
                <div className="mb-4 rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-3">
                  <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                    Transaction
                  </div>
                  <div
                    className="mt-1 break-all text-xs text-[var(--accent)]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {txSignature}
                  </div>
                </div>
              )}
              <button
                onClick={onClose}
                className="w-full rounded-none border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : null;
};
