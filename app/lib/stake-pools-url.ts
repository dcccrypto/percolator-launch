/**
 * The /api/stake/pools URL for a pool-list fetch. The route is CDN-cached (s-maxage=30, SWR 60), so the refetch after a
 * deposit / withdraw got the pre-transaction snapshot and the pool row's TVL stayed stale (browser E2E 2026-10-16: SOL
 * pool $4.15 after a $20 deposit). A refresh after a transaction carries its own key, which the CDN caches separately;
 * the first load (key 0) keeps the shared cached URL.
 */
export function stakePoolsUrl(refreshKey: number): string {
  return refreshKey > 0 ? `/api/stake/pools?r=${refreshKey}-${Date.now()}` : "/api/stake/pools";
}
