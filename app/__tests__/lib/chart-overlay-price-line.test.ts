import { describe, expect, it, vi } from 'vitest';
import { syncOverlayPriceLine } from '@/lib/chart-overlay-price-line';

function makeSeries() {
  const lines: { price: number; applyOptions: ReturnType<typeof vi.fn>; options: () => { price: number } }[] = [];
  const series = {
    createPriceLine: vi.fn((o: { price: number; title: string }) => {
      const line = {
        price: o.price,
        applyOptions: vi.fn((u: { price: number }) => { line.price = u.price; }),
        options: () => ({ price: line.price }),
      };
      lines.push(line);
      return line;
    }),
    removePriceLine: vi.fn(),
  };
  return { series, lines };
}

const opts = () => ({ title: 'Liq' });

describe('syncOverlayPriceLine (#2990: overlay lines move in place)', () => {
  it('creates once, then moves the same line in place on every price change', () => {
    const { series, lines } = makeSeries();
    const ref = { current: null as (typeof lines)[number] | null };
    syncOverlayPriceLine(series, ref, 100, opts);
    syncOverlayPriceLine(series, ref, 101, opts);
    syncOverlayPriceLine(series, ref, 102, opts);
    expect(series.createPriceLine).toHaveBeenCalledTimes(1);
    expect(series.createPriceLine).toHaveBeenCalledWith({ title: 'Liq', price: 100 });
    expect(lines[0].applyOptions.mock.calls).toEqual([[{ price: 101 }], [{ price: 102 }]]);
    expect(series.removePriceLine).not.toHaveBeenCalled();
    expect(ref.current).toBe(lines[0]);
  });

  it('skips applyOptions when the price is unchanged', () => {
    const { series, lines } = makeSeries();
    const ref = { current: null as (typeof lines)[number] | null };
    syncOverlayPriceLine(series, ref, 100, opts);
    syncOverlayPriceLine(series, ref, 100, opts);
    expect(lines[0].applyOptions).not.toHaveBeenCalled();
  });

  it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'removes the drawn line when the desired price becomes %s (never draws a bogus line)',
    (p) => {
      const { series, lines } = makeSeries();
      const ref = { current: null as (typeof lines)[number] | null };
      syncOverlayPriceLine(series, ref, 100, opts);
      syncOverlayPriceLine(series, ref, p as number | null, opts);
      expect(series.removePriceLine).toHaveBeenCalledWith(lines[0]);
      expect(ref.current).toBeNull();
      // and does not create one from nothing
      syncOverlayPriceLine(series, ref, p as number | null, opts);
      expect(series.createPriceLine).toHaveBeenCalledTimes(1);
    },
  );

  it('recreates on a new series after a rebuild nulled the ref', () => {
    const a = makeSeries();
    const b = makeSeries();
    const ref = { current: null as (typeof a.lines)[number] | null };
    syncOverlayPriceLine(a.series, ref, 100, opts);
    ref.current = null; // series-rebuild effect drops lines with the old series
    syncOverlayPriceLine(b.series, ref, 100, opts);
    expect(b.series.createPriceLine).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(b.lines[0]);
  });

  it('does nothing without a series', () => {
    const ref = { current: null };
    expect(() => syncOverlayPriceLine(null, ref, 100, opts)).not.toThrow();
    expect(ref.current).toBeNull();
  });
});
