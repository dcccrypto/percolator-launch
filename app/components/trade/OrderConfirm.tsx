"use client";

import { FC } from "react";

interface OrderConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  direction: "long" | "short";
  size: string;
  loading: boolean;
}

export const OrderConfirm: FC<OrderConfirmProps> = ({
  open,
  onClose,
  onConfirm,
  direction,
  size,
  loading,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-xl">
        <h3 className="mb-4 text-lg font-medium text-[var(--text)]">
          Confirm {direction === "long" ? "Long" : "Short"} Order
        </h3>
        <div className="mb-6 space-y-2 text-sm text-[var(--text-secondary)]">
          <p>
            Direction:{" "}
            <span
              className={
                direction === "long" ? "text-[var(--long)]" : "text-[var(--short)]"
              }
            >
              {direction.toUpperCase()}
            </span>
          </p>
          <p>
            Size: <span className="text-[var(--text)]">{size}</span>
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-sm border border-[var(--border)] py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)]/[0.04]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`flex-1 rounded-sm py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              direction === "long"
                ? "bg-[var(--long)] hover:bg-[var(--long)]/80"
                : "bg-[var(--short)] hover:bg-[var(--short)]/80"
            }`}
          >
            {loading ? "Sending..." : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
};
