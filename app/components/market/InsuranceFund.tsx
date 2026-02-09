"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { formatTokenAmount } from "@/lib/format";

export const InsuranceFund: FC = () => {
  const { insuranceFund, loading } = useEngineState();

  if (loading || !insuranceFund) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.05] p-6">
        <p className="text-[#3D4563]">{loading ? "Loading..." : "Market not loaded"}</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6">
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-emerald-400">Insurance Fund</h3>
      <p className="text-3xl font-bold text-white">{formatTokenAmount(insuranceFund.balance)}</p>
      <p className="mt-1 text-sm text-[#3D4563]">Fee Revenue: {formatTokenAmount(insuranceFund.feeRevenue)}</p>
    </div>
  );
};
