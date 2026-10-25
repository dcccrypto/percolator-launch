import type { PnlHistoryViewModel } from "./PnlHistoryCard";

/**
 * Fabricated visual fixture for the local /dev-preview route ONLY.
 * Never import this into Portfolio, live metrics, or a data adapter.
 * This is deliberately NOT presented as historical wallet performance.
 */
export const LOCAL_PNL_HISTORY_FIXTURE: PnlHistoryViewModel = {
  kind: "records",
  source: "demo",
  summary: {
    today: 24.81,
    days7: 137.76,
    days30: -64.17,
    ytd: 1284.63,
    lifetime: 2917.4,
  },
  days: {
    "2026-10-01": { kind: "activity", realizedPnlUsd: 42.18 },
    "2026-10-02": { kind: "activity", realizedPnlUsd: -27.44 },
    "2026-10-03": { kind: "activity", realizedPnlUsd: 16.75 },
    "2026-10-04": { kind: "activity", realizedPnlUsd: 81.30 },
    "2026-10-05": { kind: "activity", realizedPnlUsd: -11.90 },
    "2026-10-06": { kind: "activity", realizedPnlUsd: 24.81 },
    "2026-10-07": { kind: "no-activity" },
    "2026-10-08": { kind: "activity", realizedPnlUsd: -64.17 },
  },
};
