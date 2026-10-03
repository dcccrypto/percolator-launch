/**
 * Two at-risk positions on one market (an owned and an NFT-wrapped one, which usePortfolio now
 * lists together) must not share a React key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AtRiskBanner } from '@/components/portfolio/AtRiskBanner';
import type { PortfolioPosition } from '@/hooks/usePortfolio';

// One owned + one NFT-wrapped position on the SAME market, both near
// liquidation — what usePortfolio returns once the wrapped row is no longer
// hidden by a market-level dedup.
const row = (nftWrapped: boolean) =>
  ({ slabAddress: 'SLAB1111', symbol: 'SOL-PERP', idx: 0, nftWrapped,
     liquidationDistancePct: 1.1, account: { positionSize: 1_000_000n, capital: 10_000_000n },
     // 10x long at 100 (mm 5% / im 10%), polled at 95.8: engine liquidation 94.74, danger.
     effectiveSize: 1_000_000n, effectiveEntryPrice: 100_000_000n, oraclePriceE6: 95_800_000n,
     liquidationPriceE6: 94_736_843n, maintenanceMarginBps: 500n, initialMarginBps: 1000n }) as unknown as PortfolioPosition;

describe('AtRiskBanner: two at-risk rows on one market', () => {
  afterEach(cleanup);
  it('renders both with no duplicate-key warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getAllByRole } = render(<AtRiskBanner positions={[row(false), row(true)]} />);
    expect(getAllByRole('link')).toHaveLength(2);
    const dupKey = err.mock.calls.some((c) => c.join(' ').includes('same key'));
    err.mockRestore();
    expect(dupKey).toBe(false);
  });
});
