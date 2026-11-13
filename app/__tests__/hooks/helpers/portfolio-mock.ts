/** Stand-in for @/hooks/usePortfolio in the faucet hook tests: one fake portfolio the test can set. */
export const portfolioState: {
  positions: { account?: { positionSize: bigint } }[];
  loading: boolean;
  error: string | null;
} = { positions: [], loading: false, error: null };

export function resetPortfolioState(): void {
  portfolioState.positions = [];
  portfolioState.loading = false;
  portfolioState.error = null;
}

export const usePortfolio = (enabled: boolean = true) =>
  enabled ? portfolioState : { positions: [], loading: false, error: null };

export const isOpenPosition = (p: { account?: { positionSize: bigint } }): boolean =>
  (p.account?.positionSize ?? 0n) !== 0n;
