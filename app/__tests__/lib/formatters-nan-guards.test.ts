import { describe, it, expect } from 'vitest';
import { formatCompact, formatCompactUsd, formatPercent } from '@/lib/formatters';

/**
 * GH#2313 — non-finite values reached the display layer and rendered literally.
 *
 * The mechanism is quiet: `(NaN).toFixed(2)` is the STRING "NaN", and every
 * magnitude comparison against NaN is false — so NaN falls through each
 * `n >= 1e6` branch and lands on the final `toFixed`, producing "$NaN" with no
 * error anywhere.
 *
 * Scope note, because the issue overstates it: `lib/formatters.ts`'s
 * `formatCompact` was ALREADY guarded, and the Earn percentages (`utilPct`,
 * `userSharePct`) guard their divisors at source. The real gaps were two
 * divergent private copies of formatCompact and one inline 0/0.
 */
describe('display formatters reject non-finite input (GH#2313)', () => {
  const bad: Array<[string, number]> = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ];

  for (const [label, v] of bad) {
    it(`formatCompactUsd(${label}) renders a placeholder, not "$${label}"`, () => {
      const out = formatCompactUsd(v);
      expect(out).toBe('—');
      expect(out).not.toContain('NaN');
      expect(out).not.toContain('Infinity');
    });

    it(`formatPercent(${label}) renders a placeholder`, () => {
      const out = formatPercent(v);
      expect(out).toBe('—');
      expect(out).not.toContain('NaN');
    });

    it(`formatCompact(${label}) stays guarded`, () => {
      expect(formatCompact(v)).toBe('—');
    });
  }

  it('formatCompactUsd handles null/undefined like the copy it replaced', () => {
    // MarketInfoBar's private version guarded null; Watchlist's did not. The
    // shared one keeps the stricter behaviour of the two.
    expect(formatCompactUsd(null)).toBe('—');
    expect(formatCompactUsd(undefined)).toBe('—');
  });

  it('still formats real values across every magnitude branch', () => {
    // Guard against "fix" by making everything return a placeholder.
    expect(formatCompactUsd(1_500_000_000)).toBe('$1.5B');
    expect(formatCompactUsd(2_500_000)).toBe('$2.5M');
    expect(formatCompactUsd(3_400)).toBe('$3.4K');
    expect(formatCompactUsd(12.345)).toBe('$12.35');
    expect(formatCompactUsd(0)).toBe('$0.00');
    expect(formatPercent(12.345)).toBe('12.35%');
    expect(formatPercent(12.345, 0)).toBe('12%');
  });

  it('the 0/0 share preview that motivated this renders a placeholder', () => {
    // DepositWithdrawPanel: (Number(0n) / Number(0n + 0n)) * 100 === NaN
    const previewShares = 0n;
    const lpSupply = 0n;
    const pct = (Number(previewShares) / Number(lpSupply + previewShares)) * 100;
    expect(Number.isNaN(pct)).toBe(true);
    expect(formatPercent(pct)).toBe('—');
  });
});
