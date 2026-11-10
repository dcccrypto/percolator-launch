/**
 * The /api/stake/pools URL for a pool-list fetch. The route is CDN-cached (s-maxage=30, SWR 60), so the refetch after a
 * deposit / withdraw got the pre-transaction snapshot and the pool row's TVL stayed stale (browser E2E 2026-10-16: SOL
 * pool $4.15 after a $20 deposit). A refresh after a transaction carries its own key, which the CDN caches separately;
 * the first load (key 0) keeps the shared cached URL, EXCEPT within a couple of minutes of the user's own stake tx
 * (Council r4 R2-10: a reload after a withdraw still showed the pre-withdraw TVL from the cached copy).
 */
const KEY = "v22:lastStakeTx";
const RECENT_MS = 120_000;

/** Remember that this browser just confirmed a stake deposit / withdraw. */
export function markStakeTx(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage unavailable: the in-page refresh still runs */
  }
}

function recentStakeTx(): boolean {
  try {
    const t = Number(sessionStorage.getItem(KEY));
    return Number.isFinite(t) && t > 0 && Date.now() - t < RECENT_MS;
  } catch {
    return false;
  }
}

export function stakePoolsUrl(refreshKey: number): string {
  return refreshKey > 0 || recentStakeTx() ? `/api/stake/pools?r=${refreshKey}-${Date.now()}` : "/api/stake/pools";
}
