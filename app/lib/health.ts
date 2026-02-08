import type { EngineState } from "@percolator/core";

export type HealthLevel = "healthy" | "caution" | "warning" | "empty";

export interface MarketHealth {
  level: HealthLevel;
  label: string;
  insuranceRatio: number;
  capitalRatio: number;
}

export function computeMarketHealth(engine: EngineState): MarketHealth {
  const oi = engine.totalOpenInterest;
  const capital = engine.cTot;
  const insurance = engine.insuranceFund.balance;

  if (capital === 0n || insurance === 0n) {
    return { level: "empty", label: "Empty", insuranceRatio: 0, capitalRatio: 0 };
  }

  if (oi === 0n) {
    return { level: "healthy", label: "Healthy", insuranceRatio: Infinity, capitalRatio: Infinity };
  }

  const insuranceRatio = Number(insurance * 10000n / oi) / 10000;
  const capitalRatio = Number(capital * 10000n / oi) / 10000;

  if (insuranceRatio < 0.02 || capitalRatio < 0.5) {
    return { level: "warning", label: "Low Liquidity", insuranceRatio, capitalRatio };
  }

  if (insuranceRatio < 0.05 || capitalRatio < 0.8) {
    return { level: "caution", label: "Caution", insuranceRatio, capitalRatio };
  }

  return { level: "healthy", label: "Healthy", insuranceRatio, capitalRatio };
}
