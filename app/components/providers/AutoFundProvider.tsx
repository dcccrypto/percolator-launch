/**
 * PERC-356: Auto-fund provider
 *
 * Renders nothing visible — just triggers the auto-fund hook when a wallet
 * connects on devnet. Shows a toast notification when funding completes.
 */

"use client";

import { FC, useEffect } from "react";
import { useAutoFund } from "@/hooks/useAutoFund";

export const AutoFundProvider: FC = () => {
  const { result } = useAutoFund();

  useEffect(() => {
    if (!result?.funded) return;
    const parts: string[] = [];
    if (result.sol_airdropped) parts.push(`${result.sol_amount} SOL`);
    if (result.usdc_minted) parts.push(`${result.usdc_amount} USDC`);
    if (parts.length > 0) {
      console.log(`[AutoFund] ✅ Funded: ${parts.join(" + ")}`);
    }
  }, [result]);

  return null; // Renders nothing
};
