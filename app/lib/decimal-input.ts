/**
 * Amount / size / leverage fields: what the field holds and what it shows.
 *
 * `inputMode="decimal"` gives comma-locale phones a "," key, so a comma can be a decimal comma
 * ("0,5" = 0.5, "2,5"x = 2.5x) or a thousands separator ("1,000" = 1000). Stripping it (the old
 * behaviour) made "0,5" = 5; reading every comma as a point (N27, first cut) made "1,000" = 1. The
 * rule below picks one reading deterministically and never shrinks or grows a grouped number.
 *
 * The rule (on the text after dropping everything except digits, "." and ","):
 *
 * 1. Only commas.
 *    - Thousands grouping when the text is a grouped whole number: a first group of 1-3 digits
 *      that does not start with 0, then groups of exactly 3 ("1,000", "2,500", "12,345,678").
 *      While typing, a SECOND comma after a complete ",ddd" group also proves grouping, so the
 *      unfinished last group may have 0-2 digits ("1,000," / "1,000,0" on the way to 1,000,000).
 *      The commas are dropped.
 *    - Otherwise the first comma is the decimal point and any later comma is dropped
 *      ("0,5", "12,75", "0,500", "1,0005", "12345,678", "1,5," = 1.5).
 *    - So the one ambiguous shape, "1,234" (1-3 digits, a comma, exactly 3 digits), is read as
 *      1234 - the reading a thousands-comma typist and the pre-N27 field both gave.
 * 2. Both "." and "," (a pasted "1,234.5" or "1.000,50"): the LAST kind of separator is the
 *    decimal one and the other kind is grouping, if that grouping is well formed (the integer
 *    part is a grouped whole number as in 1). Otherwise the first separator is the decimal point
 *    and every later one is dropped ("1,5." = 1.5, never 15).
 * 3. Only points: a well-formed grouped whole number with two or more points ("1.000.000") is
 *    grouping; otherwise the first point is the decimal point and later ones are dropped
 *    ("1.5", "1.000" = 1, "1.2.3" = 1.23 - unchanged).
 *
 * `sanitizeDecimalInput` returns the canonical value (digits and at most one "."), which every
 * caller parses. It is a fixed point on its own output. `decimalInputText` returns what the
 * field should SHOW: the user's own comma is kept ("1," / "1,00" / "12,75" / "1,000") so the
 * next keystroke can still turn "1,00" into "1,000" = 1000. A field keeps a dot-only value in its
 * state and shows the typed text through `useDecimalInput` (hooks/useDecimalInput.ts).
 */

interface DecimalReading {
  /** Canonical value: digits and at most one ".". */
  value: string;
  /** The separators were thousands grouping (all dropped). */
  grouped: boolean;
  /** The character the user used as the decimal separator, if any. */
  decimalChar: "." | "," | null;
}

const GROUPED_COMMA = /^[1-9]\d{0,2}(?:,\d{3})+$/;
/** A grouped number still being typed: a second comma has appeared after a complete group. */
const GROUPED_COMMA_TYPING = /^[1-9]\d{0,2}(?:,\d{3})+,\d{0,2}$/;
const GROUPED_POINT = /^[1-9]\d{0,2}(?:\.\d{3}){2,}$/;
const GROUPED_POINT_INT = /^[1-9]\d{0,2}(?:\.\d{3})+$/;

/** Digits and at most one ".", the first one kept. */
function keepFirstPoint(s: string): string {
  const dot = s.indexOf(".");
  if (dot === -1) return s;
  return s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
}

/** The first separator ("." or ",") is the decimal point; every later separator is dropped. */
function firstSeparatorIsDecimal(f: string): DecimalReading {
  const i = f.search(/[.,]/);
  const decimalChar = f[i] === "," ? "," : ".";
  const value = f.slice(0, i).replace(/[.,]/g, "") + "." + f.slice(i + 1).replace(/[.,]/g, "");
  return { value, grouped: false, decimalChar };
}

function readDecimal(raw: string): DecimalReading {
  const f = raw.replace(/[^0-9.,]/g, "");
  const hasComma = f.includes(",");
  const hasPoint = f.includes(".");

  if (hasComma && hasPoint) {
    const decimalChar = f.lastIndexOf(",") > f.lastIndexOf(".") ? "," : ".";
    const at = f.lastIndexOf(decimalChar);
    const intPart = f.slice(0, at);
    const fracPart = f.slice(at + 1);
    const wellGrouped = decimalChar === "," ? GROUPED_POINT_INT.test(intPart) : GROUPED_COMMA.test(intPart);
    if (wellGrouped && !/[.,]/.test(fracPart)) {
      return { value: intPart.replace(/[.,]/g, "") + "." + fracPart, grouped: true, decimalChar };
    }
    return firstSeparatorIsDecimal(f);
  }
  if (hasComma) {
    if (GROUPED_COMMA.test(f) || GROUPED_COMMA_TYPING.test(f)) {
      return { value: f.replace(/,/g, ""), grouped: true, decimalChar: null };
    }
    return firstSeparatorIsDecimal(f);
  }
  if (hasPoint) {
    if (GROUPED_POINT.test(f)) return { value: f.replace(/\./g, ""), grouped: true, decimalChar: null };
    return { value: keepFirstPoint(f), grouped: false, decimalChar: "." };
  }
  return { value: f, grouped: false, decimalChar: null };
}

/** The canonical value of an amount field's text: digits and at most one decimal point. */
export function sanitizeDecimalInput(value: string): string {
  return readDecimal(value).value;
}

/**
 * What an amount field should show for the text the user typed or pasted: the same number as
 * `sanitizeDecimalInput`, written with the user's own separators (a decimal comma stays a comma,
 * a grouped number keeps its grouping), with stray characters and separators removed.
 */
export function decimalInputText(value: string): string {
  const reading = readDecimal(value);
  if (reading.grouped) return value.replace(/[^0-9.,]/g, "");
  if (reading.decimalChar === ",") return reading.value.replace(".", ",");
  return reading.value;
}
