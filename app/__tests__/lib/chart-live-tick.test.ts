import { describe, expect, it } from 'vitest';
import {
  mergeMarkPriceIntoBar,
  mergeMarkPriceIntoPoint,
  resolveChartDataSource,
  type ChartDataSource,
} from '@/lib/chart-live-tick';

describe('resolveChartDataSource', () => {
  it('preserves the production source-priority order', () => {
    expect(resolveChartDataSource(true, true, true)).toBe('percolator');
    expect(resolveChartDataSource(false, true, true)).toBe('pyth');
    expect(resolveChartDataSource(false, false, true)).toBe('dex');
    expect(resolveChartDataSource(false, false, false)).toBe('oracle');
  });
});

describe('live mark tick source integrity', () => {
  const externalSources: ChartDataSource[] = ['percolator', 'pyth', 'dex'];

  it.each(externalSources)('does not overwrite an OHLC bar backed by %s', (source) => {
    const historicalBar = {
      time: 1_721_234_500,
      open: 0.0121,
      high: 0.0125,
      low: 0.0118,
      close: 0.0122,
    };

    // Reproduces the observed fresh-market mismatch: chart history is near
    // $0.012 while the market mark is near $0.0002.
    const result = mergeMarkPriceIntoBar(source, historicalBar, 0.0002);

    expect(result).toBe(historicalBar);
    expect(result).toEqual({
      time: 1_721_234_500,
      open: 0.0121,
      high: 0.0125,
      low: 0.0118,
      close: 0.0122,
    });
  });

  it.each(externalSources)('does not overwrite a line/area point backed by %s', (source) => {
    const historicalPoint = { time: 1_721_234_500, value: 0.0122 };
    const result = mergeMarkPriceIntoPoint(source, historicalPoint, 0.0002);

    expect(result).toBe(historicalPoint);
    expect(result.value).toBe(0.0122);
  });

  it('continues updating the oracle fallback OHLC bar', () => {
    const oracleBar = {
      time: 1_721_234_500,
      open: 0.00021,
      high: 0.00022,
      low: 0.0002,
      close: 0.00021,
    };

    expect(mergeMarkPriceIntoBar('oracle', oracleBar, 0.00019)).toEqual({
      time: 1_721_234_500,
      open: 0.00021,
      high: 0.00022,
      low: 0.00019,
      close: 0.00019,
    });
  });

  it('continues updating the oracle fallback line/area point', () => {
    const oraclePoint = { time: 1_721_234_500, value: 0.00021 };

    expect(mergeMarkPriceIntoPoint('oracle', oraclePoint, 0.00019)).toEqual({
      time: 1_721_234_500,
      value: 0.00019,
    });
  });

  it('rejects a non-finite mark without corrupting either series shape', () => {
    const bar = {
      time: 1_721_234_500,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    };
    const point = { time: 1_721_234_500, value: 1 };

    expect(mergeMarkPriceIntoBar('oracle', bar, Number.NaN)).toBe(bar);
    expect(mergeMarkPriceIntoPoint('oracle', point, Infinity)).toBe(point);
  });

  it('documents the old failure magnitude for the screenshot values', () => {
    const dexClose = 0.0122;
    const mark = 0.0002;
    const syntheticDropPercent = ((dexClose - mark) / dexClose) * 100;

    // The old unconditional merge created an artificial >98% red candle.
    expect(syntheticDropPercent).toBeGreaterThan(98);
    expect(
      mergeMarkPriceIntoBar(
        'dex',
        {
          time: 1,
          open: dexClose,
          high: dexClose,
          low: dexClose,
          close: dexClose,
        },
        mark,
      ).close,
    ).toBe(dexClose);
  });
});
