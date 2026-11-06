import { describe, expect, it } from 'vitest';

import { computeLiquidationDistancePct, computeLiquidationMovePct } from '@/lib/liquidation-distance';

describe('computeLiquidationDistancePct', () => {
  it('preserves the canonical warning distance for a short position', () => {
    const distance = computeLiquidationDistancePct(-1n, 77_000_000n, 110_000_000n);

    // (110 - 77) / 77 * 100 = 42.85% (share of the mark, like a long)
    expect(distance).toBe(42.85);
  });

  it('computes the directional distance for a healthy long position', () => {
    const distance = computeLiquidationDistancePct(1n, 120_000_000n, 90_000_000n);

    // (120 - 90) / 120 * 100 = 25%
    expect(distance).toBe(25);
  });

  it('computes the directional distance for a healthy short position', () => {
    const distance = computeLiquidationDistancePct(-1n, 80_000_000n, 100_000_000n);

    // (100 - 80) / 80 * 100 = 25%
    expect(distance).toBe(25);
  });

  it('returns zero when a short mark has crossed its liquidation price', () => {
    const distance = computeLiquidationDistancePct(-1n, 160_000_000n, 110_000_000n);

    expect(distance).toBe(0);
  });

  it('returns zero when a long mark has crossed its liquidation price', () => {
    const distance = computeLiquidationDistancePct(1n, 80_000_000n, 90_000_000n);

    expect(distance).toBe(0);
  });

  it.each([
    {
      name: 'long',
      positionSize: 1n,
      markPriceE6: 90_000_000n,
      liquidationPriceE6: 90_000_000n,
    },
    {
      name: 'short',
      positionSize: -1n,
      markPriceE6: 110_000_000n,
      liquidationPriceE6: 110_000_000n,
    },
  ])(
    'returns zero at the exact $name liquidation boundary',
    ({ positionSize, markPriceE6, liquidationPriceE6 }) => {
      expect(computeLiquidationDistancePct(positionSize, markPriceE6, liquidationPriceE6)).toBe(0);
    },
  );

  it('uses the supplied fallback when there is no open position', () => {
    expect(computeLiquidationDistancePct(0n, 100_000_000n, 90_000_000n, 37.5)).toBe(37.5);
  });

  it.each([
    {
      name: 'invalid mark',
      markPriceE6: 0n,
      liquidationPriceE6: 90_000_000n,
    },
    {
      name: 'invalid liquidation price',
      markPriceE6: 100_000_000n,
      liquidationPriceE6: 0n,
    },
  ])('uses the supplied fallback for $name', ({ markPriceE6, liquidationPriceE6 }) => {
    expect(computeLiquidationDistancePct(1n, markPriceE6, liquidationPriceE6, 64)).toBe(64);
  });

  it('handles prices above Number.MAX_SAFE_INTEGER without precision conversion', () => {
    const distance = computeLiquidationDistancePct(
      1n,
      10_000_000_000_000_000_000n,
      9_000_000_000_000_000_000n,
    );

    expect(distance).toBe(10);
  });

  it('council GO1106: the PENGU short reads 46.6% to liq, not 31.8%', () => {
    // mark $0.006612, liq $0.009697 (e6 units)
    expect(computeLiquidationMovePct(-1n, 6_612n, 9_697n)).toBeCloseTo(46.65, 1);
  });

  it('does not clamp a short that is more than 100% from liq, but the bar metric does', () => {
    // liq at 3x the mark: a 200% move
    expect(computeLiquidationMovePct(-1n, 100_000_000n, 300_000_000n)).toBe(200);
    expect(computeLiquidationDistancePct(-1n, 100_000_000n, 300_000_000n)).toBe(100);
  });
});
