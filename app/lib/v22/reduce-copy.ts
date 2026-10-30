/**
 * Plain lines for a REDUCE event (decodeWrapperEventV22, kind "reduce"): why a position was cut or closed without the trader's own order.
 * No engineering terms (banned-terms guard). The parser reads the event; where the app finds one (a tx's logs) it shows `reduceNoticeCopy`.
 */
import { REDUCE_REASON_V22 } from "./sdk/v22-fill-events";

export interface ReduceNotice {
  title: string;
  body: string;
}

const TITLE = "Position reduced";

export const REDUCE_NOTICE_COPY: Record<number, ReduceNotice> = {
  [REDUCE_REASON_V22.REBALANCE_REDUCE]: { title: TITLE, body: "Your position was reduced to keep this market balanced." },
  [REDUCE_REASON_V22.ADL_WIND_DOWN]: {
    title: TITLE,
    body: "A loss in this market could not be covered, so positions on the winning side were reduced at the market price.",
  },
  [REDUCE_REASON_V22.LIQUIDATION]: { title: "Position liquidated", body: "Your margin no longer covered this position, so it was reduced at the market price." },
  [REDUCE_REASON_V22.DUST_SWEEP]: { title: "Position closed", body: "A very small leftover position was closed." },
  [REDUCE_REASON_V22.EVICTION]: { title: "Position closed", body: "Your position was closed to free up room in this market." },
  [REDUCE_REASON_V22.FORCE_CLOSE_ABANDONED]: { title: "Position closed", body: "This market was abandoned, so your position was closed at its last price." },
  [REDUCE_REASON_V22.RESOLVED_CLOSE]: { title: "Position settled", body: "This market has resolved, so your position was settled at the final price." },
  [REDUCE_REASON_V22.LP_STOP]: {
    title: TITLE,
    body: "This market's liquidity hit its stop-loss, so positions on the winning side were cut at the market price. Each was cut by the same share, except a position that would be left below the market's minimum size, which was closed entirely.",
  },
};

/** The line for a parsed reduce `reason`, or null for a reason this app does not know. */
export function reduceNoticeCopy(reason: number): ReduceNotice | null {
  return REDUCE_NOTICE_COPY[reason] ?? null;
}
