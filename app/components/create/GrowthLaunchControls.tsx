"use client";

/**
 * Devnet v2.1 (growth-v19): the wizard's "Dynamic leverage" block. Rendered only when the v2.1 flag
 * is on and the launch is the P3 single-asset shape. Pure controlled component: the wizard owns the
 * state and turns it into `CreateMarketParams.growth` with lib/v21/growth-launch.ts.
 */
import { type FC } from "react";
import {
  DEFAULT_FUNDING_PCT_PER_HOUR,
  defaultGrowthLaunch,
  fundingPctPerHour,
  growthMaxTradingFeeBps,
  growthTierX100,
  minJuniorAtoms,
  rGapRange,
  validateGrowthLaunch,
} from "@/lib/v21/growth-launch";
import { V21_COPY } from "@/lib/v21/copy";

export interface GrowthLaunchState {
  on: boolean;
  /** x100; undefined = default. */
  lLaunchX100?: number;
  /** bps; undefined = the lowest honest value. */
  rGapBps?: number;
}

export interface GrowthLaunchControlsProps {
  value: GrowthLaunchState;
  onChange: (next: GrowthLaunchState) => void;
  engineImrBps: number;
  maintenanceMarginBps: number;
  maxPriceMoveBpsPerSlot: number;
  baseFeeBps: number;
  juniorAtoms: bigint;
  collateralDecimals: number;
  collateralSymbol: string;
}

const x = (x100: number): string => (x100 % 100 === 0 ? String(x100 / 100) : (x100 / 100).toFixed(1));
const pct = (bps: number): string => (bps / 100).toFixed(2).replace(/\.?0+$/, "");

export const GrowthLaunchControls: FC<GrowthLaunchControlsProps> = (p) => {
  const tier = growthTierX100(p.engineImrBps);
  const range = rGapRange({ maxPriceMoveBpsPerSlot: p.maxPriceMoveBpsPerSlot, maintenanceMarginBps: p.maintenanceMarginBps });
  const defaults = defaultGrowthLaunch({
    engineImrBps: p.engineImrBps,
    maintenanceMarginBps: p.maintenanceMarginBps,
    maxPriceMoveBpsPerSlot: p.maxPriceMoveBpsPerSlot,
    baseFeeBps: p.baseFeeBps,
    lLaunchX100: p.value.lLaunchX100,
    rGapBps: p.value.rGapBps,
  });
  const issue = p.value.on
    ? validateGrowthLaunch({
        engineImrBps: p.engineImrBps,
        maintenanceMarginBps: p.maintenanceMarginBps,
        maxPriceMoveBpsPerSlot: p.maxPriceMoveBpsPerSlot,
        baseFeeBps: p.baseFeeBps,
        lLaunchX100: p.value.lLaunchX100,
        rGapBps: p.value.rGapBps,
        juniorAtoms: p.juniorAtoms,
        collateralDecimals: p.collateralDecimals,
        singleAsset: true,
      })
    : null;
  // Whole and half steps from 1x to the tier (a creator picks a round number, not 5.17x).
  const options: number[] = [];
  for (let l = 100; l <= tier; l += 50) options.push(l);
  if (options[options.length - 1] !== tier && tier >= 100) options.push(tier);

  return (
    <section aria-label={V21_COPY.wizard.title} data-testid="growth-launch" className="mt-6 border border-[var(--border)] p-4">
      <label className="flex items-start gap-3 text-[12px] text-[var(--text)]">
        <input
          type="checkbox"
          data-testid="growth-launch-toggle"
          checked={p.value.on}
          onChange={(e) => p.onChange({ ...p.value, on: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">{V21_COPY.wizard.title}</span>
          <span className="mt-1 block text-[11px] text-[var(--text-secondary)]" data-testid="growth-launch-adjusts">{V21_COPY.wizard.adjusts}</span>
        </span>
      </label>

      {p.value.on && (
        <div className="mt-4 space-y-4">
          <p className="text-[11px] leading-snug text-[var(--text-secondary)]">{V21_COPY.wizard.explain}</p>

          <div>
            <label htmlFor="growth-l-launch" className="block text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
              {V21_COPY.wizard.launchLeverage}
            </label>
            <select
              id="growth-l-launch"
              data-testid="growth-l-launch"
              value={defaults.lLaunchX100}
              onChange={(e) => p.onChange({ ...p.value, lLaunchX100: Number(e.target.value) })}
              className="mt-1 border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[12px]"
            >
              {options.map((l) => (
                <option key={l} value={l}>{x(l)}x</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-[var(--text-dim)]">{V21_COPY.wizard.launchLeverageHint("1", x(tier))}</p>
          </div>

          <div>
            <label htmlFor="growth-r-gap" className="block text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
              {V21_COPY.wizard.riskGap}
            </label>
            <input
              id="growth-r-gap"
              data-testid="growth-r-gap"
              type="number"
              inputMode="numeric"
              min={range.min / 100}
              max={range.max / 100}
              step={0.1}
              value={defaults.rGapBps / 100}
              onChange={(e) => p.onChange({ ...p.value, rGapBps: Math.round(Number(e.target.value) * 100) })}
              className="mt-1 w-28 border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[12px]"
            />
            <span className="ml-2 text-[11px] text-[var(--text-secondary)]">%</span>
            <p className="mt-1 text-[10px] text-[var(--text-dim)]">
              {range.feasible ? V21_COPY.wizard.riskGapHint(pct(range.min), pct(range.max)) : V21_COPY.wizard.issue["r-gap-out-of-range"]}
            </p>
          </div>

          <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]" data-testid="growth-launch-facts">
            <li>{V21_COPY.wizard.fundingHint(`${fundingPctPerHour(defaults.maxAbsFundingE9PerSlot).toFixed(2)}%`)}</li>
            <li>{V21_COPY.wizard.fee(`${(Number(growthMaxTradingFeeBps(p.baseFeeBps)) / 100).toFixed(2)}%`)}</li>
            <li>{V21_COPY.wizard.junior(`${Number(minJuniorAtoms(p.collateralDecimals)) / 10 ** p.collateralDecimals} ${p.collateralSymbol}`)}</li>
            <li>{V21_COPY.wizard.singleAsset}</li>
          </ul>

          {issue && <p role="alert" data-testid="growth-launch-issue" className="text-[11px] text-[var(--short)]">{V21_COPY.wizard.issue[issue]}</p>}
        </div>
      )}
    </section>
  );
};

export { DEFAULT_FUNDING_PCT_PER_HOUR };
