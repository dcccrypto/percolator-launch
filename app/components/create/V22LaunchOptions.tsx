"use client";

/**
 * Devnet v2.2: the wizard's "Price protection", "Holding fee" and "Capacity bond" toggles, plus the calm
 * facts under them. Rendered only when the v2.2 flag is on and the growth block is on (the options ride its
 * trailer). Pure controlled component: the wizard owns the state and runs `planLaunchV22` (lib/v22/launch-plan.ts).
 * Nothing here names a protocol field: no lot exponent, band width, kink or tag.
 */
import { type FC } from "react";
import { V22_COPY } from "@/lib/v22/copy";
import { holdingFeePctPerDay, lotTooltip, type LaunchPlanV22 } from "@/lib/v22/launch-plan";

export interface V22OptionsState {
  /** undefined = the default for the oracle mode (ON for memecoin presets). */
  protection?: boolean;
  holdingFee?: boolean;
  bond?: boolean;
}

export interface V22LaunchOptionsProps {
  value: V22OptionsState;
  onChange: (next: V22OptionsState) => void;
  plan: LaunchPlanV22;
  /** Base token symbol, for the quiet size tooltip. */
  symbol: string;
}

const Toggle: FC<{ id: string; title: string; hint: string; checked: boolean; onChange: (v: boolean) => void }> = ({ id, title, hint, checked, onChange }) => (
  <label className="flex items-start gap-3 text-[12px] text-[var(--text)]">
    <input type="checkbox" data-testid={id} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
    <span>
      <span className="font-medium">{title}</span>
      <span className="mt-1 block text-[11px] text-[var(--text-secondary)]">{hint}</span>
    </span>
  </label>
);

export const V22LaunchOptions: FC<V22LaunchOptionsProps> = ({ value, onChange, plan, symbol }) => {
  if (!plan.available) return null;
  const tip = lotTooltip(plan.lotExp, symbol);
  const issue = plan.issues[0];
  return (
    <section aria-label="Launch options" data-testid="v22-launch" className="mt-4 space-y-4 border border-[var(--border)] p-4">
      <Toggle
        id="v22-protection-toggle"
        title={V22_COPY.wizard.protectionTitle}
        hint={V22_COPY.wizard.protectionHint}
        checked={plan.protection}
        onChange={(protection) => onChange({ ...value, protection })}
      />
      <Toggle
        id="v22-holding-fee-toggle"
        title={V22_COPY.wizard.holdingFeeTitle}
        hint={plan.holdingFee && plan.rent ? `${V22_COPY.wizard.holdingFeeHint} Up to ${holdingFeePctPerDay(plan.rent)} per day on a full side.` : V22_COPY.wizard.holdingFeeHint}
        checked={plan.holdingFee}
        onChange={(holdingFee) => onChange({ ...value, holdingFee })}
      />
      <Toggle
        id="v22-bond-toggle"
        title={V22_COPY.wizard.bondTitle}
        hint={V22_COPY.wizard.bondHint}
        checked={plan.bond}
        onChange={(bond) => onChange({ ...value, bond })}
      />
      {plan.bond && (
        <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]" data-testid="v22-bond-facts">
          <li>{V22_COPY.bond.absorbs}</li>
          <li>{V22_COPY.bond.coupon}</li>
          <li>{V22_COPY.bond.exit}</li>
          <li>{V22_COPY.wizard.bondAtomic}</li>
        </ul>
      )}
      {plan.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]" data-testid="v22-notes">
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {tip && (
        <p className="text-[10px] text-[var(--text-dim)]" title={tip} data-testid="v22-lot-tip">
          {tip}
        </p>
      )}
      {issue && (
        <p role="alert" data-testid="v22-launch-issue" className="text-[11px] text-[var(--short)]">
          {issue.message}
        </p>
      )}
    </section>
  );
};
