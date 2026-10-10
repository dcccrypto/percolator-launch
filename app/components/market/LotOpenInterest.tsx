"use client";

/** Open interest of a market in TOKENS. The engine's OI is in lots: convert through lib/v22/lot.ts; "--" while the market's lot exponent is unknown. */
import type { FC } from "react";
import { formatTokenAmount } from "@/lib/format";
import { useMarketLotExp } from "@/hooks/useMarketLotExp";
import { qToTokenQ } from "@/lib/v22/lot";

export const LotOpenInterest: FC<{ slab: string; oiQ: bigint; decimals: number }> = ({ slab, oiQ, decimals }) => {
  const lotExp = useMarketLotExp(slab);
  return <>{lotExp === null ? "--" : formatTokenAmount(qToTokenQ(oiQ, lotExp), decimals)}</>;
};
