"use client";

import { FC } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { formatTokenAmount, formatUsd } from "@/lib/format";

export const PositionPanel: FC = () => {
  const userAccount = useUserAccount();
  const config = useMarketConfig();

  if (!userAccount) {
    return (
      <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-6">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-slate-500">Position</h3>
        <p className="text-sm text-slate-500">No active position</p>
      </div>
    );
  }

  const { account } = userAccount;
  const hasPosition = account.positionSize !== 0n;
  const isLong = account.positionSize > 0n;
  const absPosition = account.positionSize < 0n ? -account.positionSize : account.positionSize;
  const pnlColor = account.pnl === 0n ? "text-slate-500" : account.pnl > 0n ? "text-emerald-400" : "text-red-400";

  return (
    <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-6">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-slate-500">Position</h3>
      {!hasPosition ? (
        <p className="text-sm text-slate-500">No open position</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Direction</span>
            <span className={`text-sm font-medium ${isLong ? "text-emerald-400" : "text-red-400"}`}>
              {isLong ? "LONG" : "SHORT"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Size</span>
            <span className="text-sm text-white">{formatTokenAmount(absPosition)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Entry Price</span>
            <span className="text-sm text-white">{formatUsd(account.entryPrice)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Unrealized PnL</span>
            <span className={`text-sm font-medium ${pnlColor}`}>
              {account.pnl > 0n ? "+" : account.pnl < 0n ? "-" : ""}{formatTokenAmount(account.pnl < 0n ? -account.pnl : account.pnl)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
