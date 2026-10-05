"use client";

import { bpsPct } from "@/lib/format";
import { FC, useMemo } from "react";
import { RotaryDial } from "./RotaryDial";
import { HoldToLaunch } from "./HoldToLaunch";
import { MAX_LEVERAGE_X, MIN_LEVERAGE_X } from "@/lib/market-params";
import { LP_EXPOSURE_DEFAULT_BPS } from "@/lib/matcher-params";
import { FeeBreakdown } from "@/components/FeeBreakdown";
import { WizardTranchePanel } from "@/components/limits/CreatorLimits";
import { PositionLimit } from "./PositionLimit";

/**
 * GH#2621: this dial used to floor initial margin at the OLD
 * MIN_SAFE_INITIAL_MARGIN_BPS (1500 bps / 6.67x) and cap the dial at 6.5x,
 * telling creators the 6.5x ceiling was "the protocol's 15% margin floor".
 * That floor was removed 2026-07-27 (see useCreateMarket.ts's
 * MIN_SAFE_INITIAL_MARGIN_BPS comment and market-params.ts's
 * MAX_PRICE_MOVE_BY_MARGIN table): it came from a bisection that mis-blamed
 * leverage for a failure actually caused by an incompatible price-move
 * budget. Every layer below the dial — deriveMarketParams,
 * flooredInitialMarginBps, createMarketValidation.ts's own floor
 * (Math.ceil(10_000 / MAX_LEVERAGE_X) = 1000 bps) and the deployed program's
 * handle_init_market (which assigns initial_margin_bps straight to config,
 * unbounded) — already supports MAX_LEVERAGE_X (10x). The dial was the only
 * thing still enforcing the dead floor.
 *
 * Bounds now come from the same single source (market-params.ts) everything
 * else already uses, so a future change to MAX_LEVERAGE_X moves the dial and
 * the pipeline together instead of drifting apart again.
 */
export const MAX_LEVERAGE = MAX_LEVERAGE_X;
export const MIN_LEVERAGE = MIN_LEVERAGE_X;

export const leverageToMarginBps = (lev: number): number =>
  Math.round(10_000 / lev);
/**
 * Clamped to the dial's own range on purpose. RotaryDial does NOT clamp its
 * incoming `value` prop (only `commit` clamps), so an out-of-range value paints
 * the needle past the end of the arc: a stored 0 bps would read "10000x".
 * CreateMarketWizard restores wizard state from localStorage with a bare spread
 * and does not sanitise initialMarginBps. Non-finite first: Math.max(MIN, NaN)
 * is NaN, so a clamp alone does not close it; fall back to the conservative end.
 * (Contributed by @0x-SquidSol in #2625.)
 */
export const marginBpsToLeverage = (bps: number): number => {
  if (!Number.isFinite(bps) || bps <= 0) return MIN_LEVERAGE;
  return Math.min(MAX_LEVERAGE, Math.max(MIN_LEVERAGE, Math.round((10_000 / bps) * 2) / 2));
};

/**
 * Insurance seed floor. Insurance is written ONCE at market creation and is
 * the layer that absorbs losses before the LP — a market seeded at 0 can never
 * be repaired (see the permanently blocklisted H9ey1RBn… / 4hJ9hUot…, retired
 * for exactly this). The dial therefore cannot be turned below this.
 */
const MIN_INSURANCE = 100;

export interface StepControlRoomProps {
  symbol: string;
  /** Auto-detected, not user-set — shown as a pre-flight readout. */
  oracleLabel: string;
  startPrice: string;
  /** Slab is always max capacity in v17 — there is no tier to pick. */
  slabBytes: number;
  rentSol: number | null;

  initialMarginBps: number;
  /** Displayed as a fixed readout — NOT creator-settable. One rate for every
   *  market, so a creator cannot undercut the fees that keep theirs solvent.
   *  Deliberately has no setter in this contract; see step-control-room-contract.test.tsx. */
  tradingFeeBps: number;
  lpCollateral: string;
  insuranceAmount: string;
  collateralSymbol: string;
  /** What the launch takes from the wallet: LP + insurance + both backing-domain seeds, the wizard's
   *  own totalTokensRequired (the number its launch gate enforces), in display units. */
  seedTotal: number;
  /** The two backing-domain seeds inside seedTotal (2 x backingSeedPerDomain(LP)). */
  seedBacking: number;

  onMarginBpsChange: (bps: number) => void;
  onLpCollateralChange: (v: string) => void;
  onInsuranceChange: (v: string) => void;
  /** P3 wizard: junior floor bps + setter (the panel renders only when the P3 wizard is on). */
  juniorFloorBps?: number;
  onJuniorFloorChange?: (bps: number) => void;
  /** Largest one-sided LP position, bps of the liquidity (lib/matcher-params.ts); default 1x. */
  lpExposureBps?: number;
  onLpExposureChange?: (bps: number) => void;
  /** P3 launch: the protocol pins the limit, so it is shown read-only. */
  p3?: boolean;
  /** #2954: false when the wizard cannot register this token's market (no supported pool). Default true. */
  registrable?: boolean;
  /** Why it is not registrable (wizard's notRegistrableReason); shown as visible text. */
  notRegistrableReason?: string | null;

  onLaunch: () => void;
  launchDisabled?: boolean;
  launchDisabledReason?: string;
  instantLaunch?: boolean;
  onBack: () => void;
}

const Readout: FC<{ k: string; v: string; tone?: "good" | "warn" | "plain"; dimmed?: boolean }> = ({ k, v, tone = "plain", dimmed = false }) => (
  <div
    data-dimmed={String(dimmed)}
    className={`flex items-baseline justify-between border-b border-[var(--border-subtle)] py-[7px] last:border-b-0 ${dimmed ? "opacity-50" : ""}`}
  >
    <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">{k}</span>
    <span
      className={`text-[11px] ${tone === "good" ? "text-[var(--long)]" : tone === "warn" ? "text-[var(--warning)]" : "text-[var(--text)]"}`}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {v}
    </span>
  </div>
);

/**
 * Step 2 — the Control Room.
 *
 * Four machined dials for the only four things a creator actually chooses
 * (leverage, liquidity, insurance); everything else — trading fee, price feed, slab
 * size, start price — is auto-resolved and shown as a read-only pre-flight
 * panel, because there is nothing to decide there. Launching is a press-and-hold
 * gesture rather than a click: it is irreversible and costs rent.
 */
export const StepControlRoom: FC<StepControlRoomProps> = ({
  symbol,
  oracleLabel,
  startPrice,
  slabBytes,
  rentSol,
  initialMarginBps,
  tradingFeeBps,
  lpCollateral,
  insuranceAmount,
  collateralSymbol,
  seedTotal,
  seedBacking,
  onMarginBpsChange,
  onLpCollateralChange,
  onInsuranceChange,
  juniorFloorBps,
  onJuniorFloorChange,
  lpExposureBps,
  onLpExposureChange,
  p3,
  registrable = true,
  notRegistrableReason,
  onLaunch,
  launchDisabled,
  launchDisabledReason,
  instantLaunch,
  onBack,
}) => {
  const leverage = marginBpsToLeverage(initialMarginBps);
  const lp = Number(lpCollateral) || 0;
  const ins = Number(insuranceAmount) || 0;

  const liqCaption = useMemo(
    () => `liq at ${(100 / leverage).toFixed(1)}% move`,
    [leverage],
  );

  return (
    <div className="space-y-5">
      {/* ── instrument cluster ─────────────────────────────────────────── */}
      <div
        data-testid="control-dials"
        data-dimmed={String(!registrable)}
        className={`rounded-[4px] border border-[var(--border)] bg-[var(--panel-bg)] p-5 ${registrable ? "" : "opacity-50"}`}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            Market controls
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">click, then scroll · arrow keys · −/+</div>
        </div>

        {/* ONE control per row below `sm`, centered on the card. The old
            `grid-cols-2` packed two dials into ~142px columns at 375px, but a
            dial's own step row is 36+6+74+6+36 = 158px wide — so each control
            overflowed its column, the −/+ buttons collided with the neighbour's
            and the right-hand `+` was clipped off the card entirely. A single
            full-width track gives every dial the whole card to sit in, and
            `justify-items-center` centres the control rather than stretching it.
            `sm:grid-cols-3` keeps the instrument-cluster layout from 640px up,
            where (568 − 2×16) ÷ 3 ≈ 178px comfortably fits 158px. */}
        <div className="grid grid-cols-1 justify-items-center gap-x-4 gap-y-6 sm:grid-cols-3">
          <RotaryDial
            label="Leverage"
            value={leverage}
            min={MIN_LEVERAGE}
            max={MAX_LEVERAGE}
            // GH#2621: kept at 0.5 deliberately rather than tightening it now that
            // the range extends to 10x. marginBpsToLeverage() already snaps to
            // halves for display, so a finer step here would desync what the dial
            // shows from what a resumed/reloaded market reads back as. 17 steps
            // across 2x-10x is a coarser proportion per step than the old 2x-6.5x
            // range, but every step is still an exact, round-trippable leverage —
            // narrowing it is a separate design call, not part of this fix.
            step={0.5}
            format={(v) => `${v}×`}
            caption={liqCaption}
            onChange={(v) => onMarginBpsChange(leverageToMarginBps(v))}
          />
          <RotaryDial
            label="Liquidity"
            value={lp}
            min={100}
            max={10_000}
            step={100}
            format={(v) => v.toLocaleString()}
            caption={collateralSymbol}
            onChange={(v) => onLpCollateralChange(String(v))}
          />
          <RotaryDial
            label="Insurance"
            value={ins}
            min={MIN_INSURANCE}
            max={1_000}
            step={25}
            format={(v) => v.toLocaleString()}
            caption={collateralSymbol}
            onChange={(v) => onInsuranceChange(String(v))}
          />
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <span className="text-[var(--text-secondary)]">Leverage</span> sets how far price can move
          before a position liquidates. <span className="text-[var(--text-secondary)]">Liquidity</span> is
          what traders trade against — deeper means less slippage. Max leverage is{" "}
          {MAX_LEVERAGE}×, set by how much price-move headroom the protocol can guarantee at
          that margin.
        </p>
        <PositionLimit
          liquidity={lp}
          exposureBps={lpExposureBps ?? LP_EXPOSURE_DEFAULT_BPS}
          onChange={onLpExposureChange}
          collateralSymbol={collateralSymbol}
          fixedByProtocol={p3}
        />
        {/* P3 (flag-gated): the liquidity above is the creator's junior, first-loss tranche. */}
        <WizardTranchePanel
          juniorUnits={lp}
          initialMarginBps={initialMarginBps}
          decimals={6}
          collateralSymbol={collateralSymbol}
          floorBps={juniorFloorBps}
          onFloorChange={onJuniorFloorChange}
        />
      </div>

      {/* ── pre-flight (auto-resolved, nothing to decide) ───────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[4px] border border-[var(--border)] bg-[var(--panel-bg)] p-4">
          <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            Pre-flight
          </div>
          <Readout k="Market" v={symbol} />
          <Readout
            k="Price feed"
            v={registrable ? oracleLabel : "No supported pool"}
            tone={registrable ? "good" : "warn"}
          />
          <Readout k="Start price" v={startPrice} />
          <Readout k="Market size" v={`${slabBytes.toLocaleString()} B · max capacity`} />
          {/* #2954: the cost estimate is dimmed when this market cannot be registered. */}
          <Readout k="Market rent" v={rentSol === null ? "—" : `${rentSol.toFixed(3)} SOL`} dimmed={!registrable} />
          {/* GH#2622: set expectations UP FRONT, before launch — not only after
              a creator gets stuck (RecoverSolBanner's gated RECLAIM handles that
              case). Rent is reclaimable only if setup stops before any deposit
              or account is created; completing the market commits it
              permanently (marketauth rotates to a keyless PDA — see the
              CloseSlab admin-signer requirement in useCloseMarket.ts). */}
          {/* --text-muted, NOT --text-dim: globals.css measures dim at 2.55:1
              against --bg (fails WCAG AA); muted clears it at 4.62:1. See the
              identical note in LaunchProgress.tsx's BatchFallbackNote. */}
          <p className="pt-1 text-[9px] leading-relaxed text-[var(--text-muted)]">
            Reclaimable only if you stop before any deposit is made — completing the
            market commits this rent permanently.
          </p>
          {/* NOT "same on every market": the fee is derived from the token's
              liquidity tier in useQuickLaunch (20 / 10 / 5 bps) and that value
              is what reaches the chain, so this line used to render e.g.
              "20 bps · same on every market" and contradict itself. The
              creator cannot change it either — FeeSlider is never rendered and
              setTradingFeeBps has no consumers — so "set by liquidity" is the
              honest description of both facts. See #2563. */}
          <Readout k="Trading fee" v={`${bpsPct(tradingFeeBps)} · set by token liquidity`} />
          {/* A creator is never told they earn a share of this anywhere. #2565. */}
          <div className="col-span-full pt-1">
            <FeeBreakdown highlight="creator" feeBps={tradingFeeBps} />
          </div>
          {/* LP + insurance alone understated it ~3x: both backing domains are seeded at 100% of LP. */}
          <Readout k="You seed" v={`${seedTotal.toLocaleString()} ${collateralSymbol}`} dimmed={!registrable} />
          <Readout k="Incl. counterparty backing" v={`${seedBacking.toLocaleString()} ${collateralSymbol}`} dimmed={!registrable} />
          <Readout k="Approvals" v="1" />
        </div>

        <div className="flex flex-col items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--panel-bg)] p-4">
          <HoldToLaunch
            onLaunch={onLaunch}
            disabled={launchDisabled}
            disabledReason={launchDisabledReason}
            instant={instantLaunch}
          />
          {/* Skip when HoldToLaunch already shows this exact text (one status region, not two). */}
          {!registrable && !(launchDisabled && launchDisabledReason === (notRegistrableReason ?? "This token cannot be priced")) && (
            <p data-testid="not-registrable-reason" role="status" className="mt-3 text-center text-[11px] leading-relaxed text-[var(--warning)]">
              {notRegistrableReason ?? "This token cannot be priced"}
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onBack}
        data-testid="wizard-back"
        className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        ← Back to token
      </button>
    </div>
  );
};
