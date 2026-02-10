"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { formatTokenAmount } from "@/lib/format";

export const InsuranceFund: FC = () => {
  const { insuranceFund, loading } = useEngineState();

  if (loading || !insuranceFund) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
        <p className="text-[var(--text-muted)]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-[var(--accent)]/20 bg-[var(--accent)]/5 p-6">
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-[var(--accent)]">Insurance Fund</h3>
      <p className="text-3xl font-bold text-white">{formatTokenAmount(insuranceFund.balance)}</p>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">Fee Revenue: {formatTokenAmount(insuranceFund.feeRevenue)}</p>
    </div>
  );
};
