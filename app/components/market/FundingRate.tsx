"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";

export const FundingRate: FC = () => {
  const { fundingRate, engine, loading } = useEngineState();

  if (loading || !engine) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.05] p-6">
        <p className="text-[#3D4563]">Loading...</p>
      </div>
    );
  }

  const bpsPerSlot = Number(fundingRate ?? 0n);
  const hourlyRate = bpsPerSlot * 2.5 * 3600;
  const annualizedRate = bpsPerSlot * 2.5 * 3600 * 24 * 365;
  const rateColor = bpsPerSlot === 0 ? "text-[#3D4563]" : bpsPerSlot > 0 ? "text-emerald-400" : "text-red-400";

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.05] p-6">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#3D4563]">Funding Rate</h3>
      <div className="space-y-2">
        <div>
          <p className="text-xs text-[#3D4563]">Per Slot</p>
          <p className={`text-sm font-medium ${rateColor}`}>{bpsPerSlot.toFixed(6)} bps</p>
        </div>
        <div>
          <p className="text-xs text-[#3D4563]">Hourly</p>
          <p className={`text-sm font-medium ${rateColor}`}>{hourlyRate.toFixed(4)} bps</p>
        </div>
        <div>
          <p className="text-xs text-[#3D4563]">Annualized</p>
          <p className={`text-lg font-bold ${rateColor}`}>{(annualizedRate / 100).toFixed(2)}%</p>
        </div>
      </div>
    </div>
  );
};
