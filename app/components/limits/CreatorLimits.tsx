"use client";

/**
 * Creator surfaces for the limits (plan §2 "Creator"):
 *   - WizardTranchePanel: the wizard's liquidity amount becomes the JUNIOR
 *     (first-loss) tranche under P3; shows the requirement and the caps that
 *     capital projects to (P1 LP exposure cap = junior × k; the most Earn
 *     capital the 10% protocol floor allows = junior / floor).
 *   - CreatorTranchePanel: my-markets drawer — "Your creator stake" for its owner (value, what
 *     it protects, the minimum, withdrawable now with its reason; UX WP-9), creator fees, caps.
 * Flag-gated (P3 for tranche rows, P1 for caps). Pure math in lib/limits.
 */
import { type FC, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useJuniorTranche } from "@/hooks/useJuniorTranche";
import { parseHumanAmount } from "@/lib/parseAmount";
import { useMarketLimits, type MarketLimits } from "@/hooks/useMarketLimits";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useInsuranceLP } from "@/hooks/useInsuranceLP";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { limitsFlags, p3WizardEnabled } from "@/lib/limits/flags";
import { DEFAULT_JUNIOR_FLOOR_BPS, juniorFloorAtoms, maxWizardFloorBps, validateP3Wizard } from "@/lib/limits/p3-wizard";
import { backingSeedPerDomain } from "@/lib/market-params";
import { COPY } from "@/lib/limits/copy";
import { defaultLpExposureKBps, lpEquityInitRaw, lpExposureCapQ, maxTradeSizePerSide, nonnegEquity, effectiveLpExposureKBps } from "@/lib/limits/risk-limits";
import { projectCreatorCaps } from "@/lib/limits/vault-tranche";
import { CREATOR_STAKE_PANEL_COPY, clampStakeWithdraw, creatorStakeState, stakeReasonFromRefusal, type CreatorStakeState, type StakeReason } from "@/lib/limits/creator-stake";
import { useResolvedExit } from "@/hooks/useResolvedExit";
import { resolvedPayoutEta } from "@/lib/limits/resolved-eta";
import { juniorResolvedReleasableAtoms } from "@/lib/limits/junior-resolved-release";
import { earnViewFromLimits } from "@/lib/limits/earn";
import { useVaultLpValuation } from "@/hooks/useVaultLpValuation";
import type { VaultLpValue } from "@/lib/limits/vault-tranche";
import { formatTokenAmount } from "@/lib/format";
import { LimitsNotice, LimitsRow } from "./LimitsRow";
import { fmtQ } from "./OrderTicketLimits";
import { CREATOR_STAKE_COPY } from "@/lib/wizard-copy";

export const WizardTranchePanel: FC<{
  juniorUnits: number;
  initialMarginBps: number;
  decimals: number;
  collateralSymbol: string;
  /** P3 wizard: junior floor (bps of the senior claim) and its setter. */
  floorBps?: number;
  onFloorChange?: (bps: number) => void;
}> = ({ juniorUnits, initialMarginBps, decimals, collateralSymbol, floorBps, onFloorChange }) => {
  if (!p3WizardEnabled()) return null;
  const j = BigInt(Math.max(0, Math.floor(juniorUnits * 10 ** decimals)));
  const k = defaultLpExposureKBps(BigInt(initialMarginBps));
  const floor = floorBps ?? DEFAULT_JUNIOR_FLOOR_BPS;
  // The vault LP is bound right after the Earn seed (both domains = 2 x backingSeedPerDomain),
  // so the senior claim at InitVaultLp is that seed's NAV.
  const seedNav = 2n * backingSeedPerDomain(j);
  const maxFloor = maxWizardFloorBps(j, seedNav);
  const issue = validateP3Wizard({ juniorFloorBps: floor, juniorAtoms: j, seedNavAtoms: seedNav });
  const caps = projectCreatorCaps(j, k, floor);
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  return (
    // UX WP-7 (§4.6): "Your creator stake" in plain words; the protocol detail sits in Details.
    <div data-testid="limits-wizard-tranche" data-floor-bps={String(floor)} className="mt-4 border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-1.5">
      <div className="flex items-baseline justify-between" data-testid="limits-wizard-junior-amount">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">{CREATOR_STAKE_COPY.title}</p>
        <p className="font-mono text-[13px] tabular-nums text-[var(--text)]">{fmt(j)}</p>
      </div>
      <p className="text-[12px] leading-snug text-[var(--text-secondary)]">{CREATOR_STAKE_COPY.explain}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="uppercase tracking-[0.08em] text-[var(--text-secondary)]">{CREATOR_STAKE_COPY.floorLabel}</span>
        <span className="flex gap-1" role="radiogroup" aria-label={CREATOR_STAKE_COPY.floorLabel}>
          {WIZARD_FLOOR_CHOICES_BPS.map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={b === floor}
              data-testid="limits-wizard-junior-floor"
              data-value={String(b)}
              disabled={!onFloorChange || b > maxFloor}
              onClick={() => onFloorChange?.(b)}
              className={`border px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                b === floor ? "border-[var(--accent)]/60 text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)]"
              }`}
            >
              {b / 100}%
            </button>
          ))}
        </span>
        <span className="text-[var(--text-secondary)]">{CREATOR_STAKE_COPY.floorSuffix}</span>
      </div>
      <p className="text-[11px] text-[var(--text-secondary)]">{CREATOR_STAKE_COPY.floorHint}</p>
      <p data-testid="limits-wizard-pinned-matcher" className="text-[11px] text-[var(--text-secondary)]" title={CREATOR_STAKE_COPY.limitsTooltip}>
        {CREATOR_STAKE_COPY.limits} <span aria-hidden="true">ⓘ</span>
      </p>
      {issue && (
        <p data-testid="limits-wizard-junior-issue" data-issue={issue} className="text-[11px] text-[var(--warning)]">
          {issue === "junior-zero"
            ? CREATOR_STAKE_COPY.issueEmpty
            : issue === "junior-below-floor"
              ? CREATOR_STAKE_COPY.issueMin(fmt(juniorFloorAtoms(seedNav, floor)).replace(` ${collateralSymbol}`, ""), String(floor / 100))
              : COPY.p3Wizard.issue[issue]}
        </p>
      )}
      <details className="text-[11px] text-[var(--text-secondary)]">
        <summary className="cursor-pointer">Details</summary>
        <div className="mt-1 space-y-0.5">
          <LimitsRow label="Largest Earn deposits" tooltip={`Earn deposits are capped so your stake stays at least ${floor / 100}% of them.`} value={fmt(caps.maxSeniorAtoms)} />
          <LimitsRow label="Largest open exposure" value={fmt(caps.maxLpNotionalAtoms)} />
          <p className="pt-1 leading-snug">{COPY.p3Wizard.explain}</p>
        </div>
      </details>
    </div>
  );
};

/**
 * UX WP-9 (audit §3.10, JR-1): "Your creator stake" for the junior owner. Four rows, one reason
 * line when nothing can be withdrawn, Withdraw enabled exactly when `withdrawable > 0` with the
 * input capped at it ("Max"), top up (96). A refused 75 never opens the wallet (sendTx simulates
 * first) and shows the same reason line. Resolved: the terminal exit (102, 78 bundled when needed)
 * as "Withdraw {x}", or when it opens.
 */
export const JuniorTrancheActionsView: FC<{
  stake: CreatorStakeState | null;
  decimals: number;
  collateralSymbol: string;
  busy: boolean;
  error: string | null;
  /** A 75 refusal came back from the simulation: show this reason line instead of the error. */
  refusedReason?: StakeReason | null;
  onDeposit: (atoms: bigint) => void;
  onWithdraw: (atoms: bigint) => void;
  /** RESOLVED market: the junior's terminal exit (102) takes only what is above the seniors' claim. */
  resolved?: { surplusAtoms: bigint | null; waitingUntil: string | null; onRelease: (atoms: bigint) => void } | null;
}> = ({ stake, decimals, collateralSymbol, busy, error, refusedReason = null, onDeposit, onWithdraw, resolved }) => {
  const [raw, setRaw] = useState("");
  const K = CREATOR_STAKE_PANEL_COPY;
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  let typed = 0n;
  try {
    typed = raw.trim() ? parseHumanAmount(raw, decimals) : 0n;
  } catch {
    typed = 0n;
  }
  const w = stake?.withdrawable ?? null;
  const reason = refusedReason ?? stake?.reason ?? null;
  const header = (
    <>
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">{K.title}</p>
      <p className="mb-1 text-[10px] text-[var(--text-secondary)]">{K.subtitle}</p>
    </>
  );
  if (resolved) {
    const s = resolved.surplusAtoms;
    const open = s !== null && s > 0n;
    return (
      <div data-testid="limits-junior-actions" data-mode="resolved" className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3">
        {header}
        <p data-testid="limits-junior-resolved-surplus" className="text-[11px] leading-relaxed text-[var(--text)]">
          {open ? K.resolvedAvailable(fmt(s)) : resolved.waitingUntil ? K.resolvedWaiting(resolved.waitingUntil) : K.resolvedAvailable(fmt(0n))}
        </p>
        {open && (
          <button
            type="button"
            data-testid="limits-junior-release-resolved"
            disabled={busy}
            onClick={() => resolved.onRelease(s)}
            className="mt-2 w-full border border-[var(--accent)]/50 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {K.resolvedWithdraw(fmt(s))}
          </button>
        )}
        {error && (
          <p data-testid="limits-junior-error" className="mt-2 text-[10px] text-[var(--short)]">
            {error}
          </p>
        )}
      </div>
    );
  }
  const amount = clampStakeWithdraw(typed, w);
  return (
    <div data-testid="limits-junior-actions" data-reason={reason ?? ""} className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3">
      {header}
      {stake && (
        <div className="mb-2 space-y-0.5">
          <LimitsRow label={K.stakeValue} testId="limits-junior-value" value={stake.stakeValue === null ? "Updating…" : fmt(stake.stakeValue)} />
          <LimitsRow label={K.protects} value={fmt(stake.protects)} />
          {stake.mustKeep !== null && <LimitsRow label={K.mustKeep} value={K.mustKeepValue(fmt(stake.mustKeep), stake.floorPct)} />}
          <LimitsRow label={K.withdrawable} testId="limits-junior-withdrawable" value={w === null ? "—" : fmt(w)} />
          {reason && (
            <p data-testid="limits-junior-reason" data-reason={reason} className="text-[10px] leading-snug text-[var(--text-secondary)]">
              {K.reasons[reason]}
            </p>
          )}
        </div>
      )}
      {stake?.exhausted && (
        <LimitsNotice tone="warning" testId="limits-creator-impaired">
          {/* The P3 §0.8 loss rule, one wording on every surface (p3-single-asset-loss-copy guard). */}
          {COPY.juniorExhausted}
        </LimitsNotice>
      )}
      <div className="flex items-center gap-2">
        <input
          data-testid="limits-junior-amount-input"
          inputMode="decimal"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={`Amount (${collateralSymbol})`}
          className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] text-[var(--text)]"
        />
        {w !== null && w > 0n && (
          <button
            type="button"
            data-testid="limits-junior-max"
            onClick={() => setRaw(formatTokenAmount(w, decimals).replace(/,/g, ""))}
            className="shrink-0 text-[10px] text-[var(--accent)] underline underline-offset-2"
          >
            {K.max(fmt(w))}
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="limits-junior-deposit"
          disabled={busy || typed <= 0n}
          onClick={() => onDeposit(typed)}
          className="border border-[var(--accent)]/50 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {K.topUp}
        </button>
        <button
          type="button"
          data-testid="limits-junior-withdraw"
          disabled={busy || w === null || w <= 0n || amount <= 0n}
          onClick={() => onWithdraw(amount)}
          className="border border-[var(--border)] py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {K.withdraw}
        </button>
      </div>
      {error && !refusedReason && (
        <p data-testid="limits-junior-error" className="mt-2 text-[10px] text-[var(--short)]">
          {error}
        </p>
      )}
    </div>
  );
};

function juniorResolvedSurplus(raw: Uint8Array | null | undefined, assetIndex: number, seniorClaim: bigint): bigint | null {
  // own + sibling domain = both domains of the vault's asset (same helper the sim bridge runs)
  return juniorResolvedReleasableAtoms(raw ?? null, assetIndex * 2, seniorClaim);
}

/** Floors the wizard offers (the program accepts 1000..=10000). */
export const WIZARD_FLOOR_CHOICES_BPS = [1_000, 2_000, 3_000, 5_000] as const;

/** Mounts the data hooks only when a limits flag is on (flag-off = zero extra RPC). */
export const CreatorTranchePanel: FC<{ slab: string; decimals: number; collateralSymbol: string }> = (p) => {
  const f = limitsFlags();
  if (!f.p1 && !f.p3) return null;
  return <CreatorTranchePanelLive {...p} />;
};

const CreatorTranchePanelLive: FC<{ slab: string; decimals: number; collateralSymbol: string }> = ({ slab, decimals, collateralSymbol: fallbackSymbol }) => {
  const limits = useMarketLimits(slab);
  const { state: lpState } = useInsuranceLP();
  const { assetProfile, raw: slabRaw, config: slabConfig } = useSlabState();
  // UX WP-9 (§3.10): the collateral symbol comes from the market's mint, not a literal.
  const collateralMeta = useTokenMeta(slabConfig?.collateralMint ?? null);
  const collateralSymbol = collateralMeta?.symbol ?? fallbackSymbol;
  const wallet = useWalletCompat();
  const junior = useJuniorTranche(slab);
  // UX WP-5 (§3.7): a stale LP certificate is valued by a simulated crank, never "Needs refresh".
  const lpValuation = useVaultLpValuation(slab, limits);
  const vs = limits.flags.p3 ? limits.vaultState : null;
  const isJuniorOwner = !!vs && !!wallet.publicKey && new PublicKey(vs.juniorOwner).equals(wallet.publicKey);
  const view = earnViewFromLimits(limits, lpState.backingNavAtoms, 0n, undefined, lpValuation.value);
  const stake =
    view && vs
      ? creatorStakeState({
          vaultValue: view.vaultValue,
          seniorClaimEff: view.seniorClaimEff,
          backingCover: view.backingCover,
          floorBps: vs.juniorFloorBps,
          lpFlat: limits.lp?.posQ === 0n,
          drawOutstandingAtoms: vs.seniorDrawOutstandingAtoms,
          impaired: view.impaired === true,
        })
      : null;
  const resolvedMode = limits.engine?.mode === 1 && !!vs;
  const exit = useResolvedExit(resolvedMode ? slab : null);
  const eta =
    resolvedMode && exit.plan && exit.plan.phase !== "ready" && exit.plan.phase !== "not-resolved" && exit.nowSlot !== null
      ? resolvedPayoutEta({ untilSlot: exit.plan.phase === "owner-window" ? exit.plan.untilSlot : null, nowSlot: exit.nowSlot, now: new Date() })
      : null;
  return (
    <>
      {isJuniorOwner && (
        <JuniorTrancheActionsView
          stake={stake}
          decimals={decimals}
          collateralSymbol={collateralSymbol}
          busy={junior.busy}
          error={junior.error}
          refusedReason={junior.refused75 && stake ? stakeReasonFromRefusal(stake) : null}
          onDeposit={(a) => void junior.deposit(a).catch(() => undefined)}
          onWithdraw={(a) => void junior.withdraw(a).catch(() => undefined)}
          resolved={
            resolvedMode && vs
              ? {
                  surplusAtoms: exit.plan && exit.plan.phase !== "ready" ? null : juniorResolvedSurplus(slabRaw, vs.assetIndex, vs.seniorClaimAtoms),
                  waitingUntil: eta ? `${eta.label}, ${eta.relative}` : null,
                  onRelease: (a) => void junior.releaseResolved(a).catch(() => undefined),
                }
              : null
          }
        />
      )}
      <CreatorTranchePanelView
      limits={limits}
      slab={slab}
      backingNavAtoms={lpState.backingNavAtoms}
      creatorFeesAtoms={assetProfile?.creatorFeeClaimableAtoms ?? null}
      decimals={decimals}
      collateralSymbol={collateralSymbol}
      simulatedLpValue={lpValuation.value}
      />
    </>
  );
};

export const CreatorTranchePanelView: FC<{
  limits: MarketLimits;
  slab: string;
  backingNavAtoms: bigint;
  creatorFeesAtoms: bigint | null;
  decimals: number;
  collateralSymbol: string;
  simulatedLpValue?: VaultLpValue | null;
}> = ({ limits, slab, backingNavAtoms, creatorFeesAtoms, decimals, collateralSymbol, simulatedLpValue = null }) => {
  if (limits.state === "off" || (!limits.flags.p3 && !limits.flags.p1)) return null;
  const fmt = (a: bigint) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`;
  const e = limits.engine;
  const lp = limits.lp;
  const vs = limits.flags.p3 ? limits.vaultState : null;
  // UX WP-9: the stake rows (value, protects, must keep, withdrawable + reason) live in "Your
  // creator stake" (JuniorTrancheActionsView); this card keeps the market's caps.
  void backingNavAtoms;
  void simulatedLpValue;
  void vs;
  const sides =
    limits.flags.p1 && e && limits.riskLimits
      ? maxTradeSizePerSide({
          priceE6: e.effectivePriceE6,
          initialMarginBps: e.initialMarginBps,
          oiEffLongQ: e.oiEffLongQ,
          oiEffShortQ: e.oiEffShortQ,
          limits: limits.riskLimits,
          lp,
          takerPosQ: 0n,
          matcher: limits.matcher ? { maxFillAbs: limits.matcher.maxFillAbs, maxInventoryAbs: limits.matcher.maxInventoryAbs, inventoryBase: limits.matcher.inventoryBase, lpRealQ: limits.lpRealQ, syncLive: limits.matcherSyncLive } : null,
        })
      : null;
  const capQ =
    limits.flags.p1 && e && lp && limits.riskLimits
      ? lpExposureCapQ(nonnegEquity(lpEquityInitRaw(lp.capital, lp.pnl, lp.feeCredits)), effectiveLpExposureKBps(limits.riskLimits.lpExposureKBps, e.initialMarginBps), e.effectivePriceE6)
      : null;

  return (
    <div data-testid="limits-creator-tranche" data-market={slab} data-state={limits.state} className="mb-4 space-y-0.5">
      <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Risk &amp; caps</p>
      {creatorFeesAtoms !== null && <LimitsRow label="Creator fees (claimable)" value={fmt(creatorFeesAtoms)} />}
      {capQ !== null && <LimitsRow label="Exposure cap" value={`${fmtQ(capQ)} units`} />}
      {sides && (
        <LimitsRow
          label="Max trade long / short"
          value={`${sides.long.halted ? "Paused" : fmtQ(sides.long.maxQ)} / ${sides.short.halted ? "Paused" : fmtQ(sides.short.maxQ)}`}
        />
      )}
    </div>
  );
};
