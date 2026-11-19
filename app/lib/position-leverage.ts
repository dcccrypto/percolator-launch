/**
 * Effective (current) leverage of a position on its cross-margined portfolio.
 *
 *   leverage = position notional / portfolio equity
 *   notional = |size| x mark          (size is engine Q, POS_SCALE 1e6)
 *   equity   = capital + pnl          (collateral atoms)
 *
 * This is a LIVE figure, not entry leverage. Percolator stores no entry
 * leverage on chain (PortfolioV17 has capital / pnl / legs with basisPosQ +
 * ADL snapshots, and no entry price or leverage field — see
 * lib/userAccountScan.ts portfolioV17ToAccount). The order-ticket slider value
 * is only remembered in localStorage (lib/entry-price.ts getEntryLeverage), so
 * it is never presented as the position's leverage here.
 *
 * Because margin is cross-portfolio, the number moves with the mark price and
 * with the PnL / collateral changes of any other position sharing that margin.
 *
 * NOMINAL size, deliberately: ADL shrinks a leg's exposure without rewriting
 * its basis and the engine still charges margin on the basis, so the effective
 * (reduced) exposure would understate leverage — the unsafe direction for a
 * risk readout (same rule as lib/margin-health.ts).
 *
 * Collateral is treated as USD-pegged (the app's convention everywhere:
 * notional USD == collateral units), scaled by `collateralDecimals`.
 */
import { Q_SCALE } from "@/lib/q-usd";
import { isSentinelValue } from "@/lib/health";

export type PositionLeverage =
  | { kind: "ok"; leverage: number; notionalAtoms: bigint; equityAtoms: bigint }
  /** Equity <= 0: leverage is undefined (the account is at/under water). */
  | { kind: "no-equity"; equityAtoms: bigint }
  /** No open position. */
  | { kind: "flat" }
  /** Missing / invalid mark, capital or pnl (sentinel): do not guess. */
  | { kind: "unknown" };

const Q = BigInt(Q_SCALE);

export interface PositionLeverageInput {
  /** Signed engine Q size (basis_pos_q). */
  sizeQ: bigint | null | undefined;
  /** Mark price, e6. */
  markPriceE6: bigint | null | undefined;
  /** Portfolio capital, collateral atoms. */
  capital: bigint | null | undefined;
  /** Portfolio pnl, collateral atoms (signed). */
  pnl: bigint | null | undefined;
  collateralDecimals: number;
}

export function computePositionLeverage(input: PositionLeverageInput): PositionLeverage {
  const { sizeQ, markPriceE6, capital, pnl, collateralDecimals } = input;
  if (typeof sizeQ !== "bigint") return { kind: "unknown" };
  if (sizeQ === 0n) return { kind: "flat" };
  if (
    typeof markPriceE6 !== "bigint" || markPriceE6 <= 0n || isSentinelValue(markPriceE6) ||
    typeof capital !== "bigint" || isSentinelValue(capital) ||
    typeof pnl !== "bigint" || isSentinelValue(pnl < 0n ? -pnl : pnl) ||
    !Number.isInteger(collateralDecimals) || collateralDecimals < 0 || collateralDecimals > 30
  ) {
    return { kind: "unknown" };
  }
  const absQ = sizeQ < 0n ? -sizeQ : sizeQ;
  // Engine notional (percolator v16.rs trade_notional_floor): size_q * price_e6 / POS_SCALE, already
  // in collateral atoms. No decimals factor (same as margin-health.ts / SDK trading.ts).
  const notionalAtoms = (absQ * markPriceE6) / Q;
  const equityAtoms = capital + pnl;
  if (equityAtoms <= 0n) return { kind: "no-equity", equityAtoms };
  // 4dp fixed point in bigint, then to float (no Number overflow on big atoms).
  const scaled = (notionalAtoms * 10_000n) / equityAtoms;
  const leverage = Number(scaled) / 10_000;
  if (!Number.isFinite(leverage)) return { kind: "unknown" };
  return { kind: "ok", leverage, notionalAtoms, equityAtoms };
}

export const POSITION_LEVERAGE_LABEL = "Lev";

export const POSITION_LEVERAGE_TITLE =
  "Current effective leverage on this account's margin (cross): position notional divided by account equity " +
  "(capital + PnL). It is not the leverage you opened at — Percolator does not store entry leverage. " +
  "It changes with the mark price and with other positions sharing the same margin.";

export const POSITION_LEVERAGE_NO_EQUITY_TITLE =
  "Account equity (capital + PnL) is zero or negative, so leverage is undefined. The position is at or below its margin.";

/** Display pieces for a result: `text` is the value only (e.g. "4.2×"), "—" when not displayable. */
export function describePositionLeverage(r: PositionLeverage): { text: string; title: string; known: boolean } {
  switch (r.kind) {
    case "ok": {
      const v = r.leverage;
      const s = Number(v.toFixed(2)).toString(); // up to 2dp, trailing zeros trimmed
      return { text: `${s}×`, title: POSITION_LEVERAGE_TITLE, known: true };
    }
    case "no-equity":
      return { text: "—", title: POSITION_LEVERAGE_NO_EQUITY_TITLE, known: false };
    case "flat":
      return { text: "—", title: "No open position.", known: false };
    default:
      return { text: "—", title: "Leverage unavailable: mark price or account balance not known yet.", known: false };
  }
}
