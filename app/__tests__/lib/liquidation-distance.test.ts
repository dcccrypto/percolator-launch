import { describe, expect, it } from 'vitest';

import { computeLiquidationDistancePct } from '@/lib/liquidation-distance';

describe('computeLiquidationDistancePct', () => {
  it('preserves the canonical warning distance for a short position', () => {
    const distance = computeLiquidationDistancePct(-1n, 77_000_000n, 110_000_000n);

    // (110 - 77) / 110 * 100 = 30%
    expect(distance).toBe(30);
  });

  it('computes the directional distance for a healthy long position', () => {
    const distance = computeLiquidationDistancePct(1n, 120_000_000n, 90_000_000n);

    // (120 - 90) / 120 * 100 = 25%
    expect(distance).toBe(25);
  });

  it('computes the directional distance for a healthy short position', () => {
    const distance = computeLiquidationDistancePct(-1n, 80_000_000n, 100_000_000n);

    // (100 - 80) / 100 * 100 = 20%
    expect(distance).toBe(20);
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
});
