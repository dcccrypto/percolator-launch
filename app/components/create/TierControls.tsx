"use client";

/**
 * Devnet v2.2: "Advanced: leverage tiers" in the launch wizard. A collapsed disclosure (closed by default) showing the protocol
 * defaults; open, the creator can edit each tier's pool-depth amount and max leverage. Validated live with the SDK's exact bounds
 * (lib/v22/tier-config.ts); each problem is shown beside its field. Max leverage never goes above the market's own maximum.
 * Only rendered for band (tiered) markets. Pure controlled component.
 */
import { useState, type FC } from "react";
import { V22_COPY } from "@/lib/v22/copy";
import {
  TEST_USDC,
  TIER_FLOORS_USD,
  amountLabel,
  tierDefaultsLine,
  tierLeverageOptions,
  validateTierEdit,
  type TierCollateral,
  type TierEdit,
} from "@/lib/v22/tier-config";
import { TIER_THRESHOLD_DEFAULT_USD, tierLeverage } from "@/lib/v22/sdk/records/growth-v19";

export interface TierControlsProps {
  value: TierEdit;
  onChange: (next: TierEdit) => void;
  /** The creator's launch leverage and the market's built-in maximum, x100. */
  lLaunchX100: number;
  lTierX100: number;
  /** The market's collateral (amounts are whole collateral tokens; "$" only on a 6-decimal USD-like token). Default: the test USDC. */
  collateral?: TierCollateral;
  /** Start open (tests / resuming a launch that failed on the tiers). */
  defaultOpen?: boolean;
}

const x = (x100: number): string => `${x100 % 100 === 0 ? x100 / 100 : (x100 / 100).toFixed(1)}x`;

export const TierControls: FC<TierControlsProps> = ({ value, onChange, lLaunchX100, lTierX100, collateral = TEST_USDC, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const result = validateTierEdit(value, lLaunchX100, lTierX100, collateral);
  const unit = amountLabel(1, collateral).startsWith("$") ? "$" : (collateral.symbol ?? "tokens");
  const options = tierLeverageOptions(lLaunchX100, lTierX100);
  const table = tierLeverage([0, 0, 0], lLaunchX100, lTierX100);
  const issuesFor = (field: "thresholds" | "leverage", tier: 1 | 2 | 3) => result.issues.filter((i) => i.field === field && i.tier === tier);
  const set = (field: "thresholds" | "leverage", k: number, v: string) =>
    onChange({ ...value, [field]: value[field].map((old, j) => (j === k ? v : old)) as unknown as TierEdit["thresholds"] });

  return (
    <div data-testid="tier-controls" className="border-t border-[var(--border)] pt-3">
      <button
        type="button"
        data-testid="tier-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-[12px] font-medium text-[var(--text)]"
      >
        {open ? "▾" : "▸"} {V22_COPY.tiers.title}
      </button>
      <p className="mt-1 text-[11px] text-[var(--text-secondary)]" data-testid="tier-defaults">{tierDefaultsLine(lLaunchX100, lTierX100, collateral)}</p>
      {open && (
        <div className="mt-3 space-y-3" data-testid="tier-editor">
          <p className="text-[11px] text-[var(--text-secondary)]" data-testid="tier-explain">{V22_COPY.tiers.explain(TIER_FLOORS_USD.map((f) => amountLabel(f, collateral)).join(", "))}</p>
          {([1, 2, 3] as const).map((t) => {
            const k = t - 1;
            const th = issuesFor("thresholds", t);
            const lv = issuesFor("leverage", t);
            return (
              <div key={t} className="grid grid-cols-2 gap-3" data-testid={`tier-row-${t}`}>
                <div>
                  <label htmlFor={`tier-th-${t}`} className="block text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">{V22_COPY.tiers.thresholdLabel(t, unit)}</label>
                  <input
                    id={`tier-th-${t}`}
                    data-testid={`tier-threshold-${t}`}
                    inputMode="numeric"
                    value={value.thresholds[k]}
                    placeholder={V22_COPY.tiers.thresholdPlaceholder(amountLabel(TIER_THRESHOLD_DEFAULT_USD[k] as number, collateral))}
                    aria-invalid={th.length > 0}
                    onChange={(e) => set("thresholds", k, e.target.value)}
                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[12px]"
                  />
                  <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">{V22_COPY.tiers.atLeast(amountLabel(TIER_FLOORS_USD[k] as number, collateral))}</p>
                  {th.map((i) => <p key={i.message} role="alert" data-testid={`tier-threshold-issue-${t}`} className="text-[11px] text-[var(--short)]">{i.message}</p>)}
                </div>
                <div>
                  <label htmlFor={`tier-lv-${t}`} className="block text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">{V22_COPY.tiers.leverageLabel(t)}</label>
                  <select
                    id={`tier-lv-${t}`}
                    data-testid={`tier-leverage-${t}`}
                    value={value.leverage[k]}
                    aria-invalid={lv.length > 0}
                    onChange={(e) => set("leverage", k, e.target.value)}
                    className="mt-1 w-full border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[12px]"
                  >
                    <option value="">{V22_COPY.tiers.defaultOption(x(table[t] as number))}</option>
                    {options.map((l) => <option key={l} value={String(l / 100)}>{x(l)}</option>)}
                  </select>
                  {lv.map((i) => <p key={i.message} role="alert" data-testid={`tier-leverage-issue-${t}`} className="text-[11px] text-[var(--short)]">{i.message}</p>)}
                </div>
              </div>
            );
          })}
          {result.issues.filter((i) => i.tier === undefined).map((i) => <p key={i.message} role="alert" data-testid="tier-issue" className="text-[11px] text-[var(--short)]">{i.message}</p>)}
        </div>
      )}
    </div>
  );
};
