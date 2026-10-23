/**
 * v2.2 QA A11y-1: the chart toolbar's six timeframe buttons were named only by "1m" / "4h" / "1d" glyphs. Each now has a
 * spoken name ("1 minute candles").
 */
const UNIT: Record<string, [string, string]> = { m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"] };

export function timeframeLabel(tf: string): string {
  const m = /^(\d+)([mhdw])$/.exec(tf);
  if (!m) return `${tf} candles`;
  const n = Number(m[1]);
  const [one, many] = UNIT[m[2]];
  return `${n} ${n === 1 ? one : many} candles`;
}
