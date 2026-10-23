/**
 * Trade-history timestamps as two short lines: "5 Oct" over "18:38".
 *
 * The history used `toLocaleDateString([], { month: "short" })`, which follows the browser's
 * locale: on a phone set to e.g. Czech or German that renders "5. 10." and wrapped the Time cell
 * into three lines ("5." / "10.," / "18:38"). The UI is English, so dates are too: day + short
 * month and a 24-hour time, in the viewer's own time zone. Each line is nowrap at the call site.
 */
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const TIME_FMT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

export function fillTimeParts(ts: string, timeZone?: string): { date: string; time: string } | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  if (timeZone) {
    return {
      date: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(d),
      time: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d),
    };
  }
  return { date: DATE_FMT.format(d), time: TIME_FMT.format(d) };
}
