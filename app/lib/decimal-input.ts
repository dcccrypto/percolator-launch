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

/** What the user meant, said back to them: the amount read (thin-space grouping past 4 digits, never "," or ".") and,
 *  for the one ambiguous shape, the other reading. */
export interface StrictAmountEcho {
  amount: string;
  /** "1,500" is read as 1500; a decimal-comma typist may have meant 1.5: say so. null when there is no other reading. */
  alternative: string | null;
}

export type StrictDecimalReading =
  | { ok: true; value: string; echo: StrictAmountEcho | null }
  | { ok: false; reason: string };

const EXPONENT_REASON = "Type the full number (for example 1000, not 1e3).";
const NEGATIVE_REASON = "Amounts can't be negative.";
const CHARS_REASON = "Use digits and one decimal point only.";
const ONE_POINT_REASON = "Use one decimal point (for example 1000.5 or 1,000.50).";
const GROUPING_REASON = "Check the commas: each thousands comma needs 3 digits after it (1,000,000), or type the number without commas.";

const MINUS = /[-−‒–]/;
const PLAIN = /^\d*\.?\d*$/;
const STRICT_COMMA_GROUPED = /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/;
const STRICT_DECIMAL_COMMA = /^\d*,\d*$/;
const STRICT_POINT_GROUPED_COMMA_DECIMAL = /^[1-9]\d{0,2}(?:\.\d{3})+,\d*$/;
/** "1,500": a thousands comma (1500) or a decimal comma (1.5). Read as 1500 (the pre-N27 reading), echoed with both. */
const AMBIGUOUS_COMMA = /^([1-9]\d{0,2}),(\d{3})$/;

/** The canonical amount for display: thin-space grouping (U+202F) of an integer part longer than 4 digits. */
function echoAmount(canonical: string): string {
  const dot = canonical.indexOf(".");
  const int = dot === -1 ? canonical : canonical.slice(0, dot);
  const rest = dot === -1 ? "" : canonical.slice(dot);
  const grouped = int.length > 4 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f") : int;
  return grouped + rest;
}

/** "1.500" → "1.5", "1.000" → "1": the decimal-comma reading of the ambiguous shape, said as a person would. */
function trimFraction(intPart: string, frac: string): string {
  const f = frac.replace(/0+$/, "");
  return f === "" ? intPart : `${intPart}.${f}`;
}

/**
 * The STRICT reading of a money field (Earn deposit / withdraw): one grammar, no rewriting.
 *
 * Council 2026-11-06-go1106-ux (LP) and 2026-11-07 council-leftovers run 2 (Skeptic, Attacker, First-timer, Trader):
 * `sanitizeDecimalInput` drops what it does not understand, which turned "-5" into 5, "1e3" into 13, "1.2.3" into
 * 1.23, "1..5" into 1.5, "1,2,3" into 1.23, "1,000.5.5" into 1.00055 and "1,000,00" into 100000, all with Deposit
 * enabled. Here each text either IS one amount or is refused with a reason (and the field holds no amount):
 *
 * - the exponent check comes first ("5e-1" is not a negative number, it is scientific notation);
 * - then a minus sign anywhere, then any character other than digits, "." and "," (spaces at the ends are fine);
 * - accepted shapes, and only these:
 *     plain           "5", "0.5", ".5", "5."                      (one point at most)
 *     comma-grouped   "1,000", "12,345,678", "1,234.56"           (groups of exactly 3; a point decimal after)
 *     decimal comma   "1,5", "0,5", "12,75", "1,"                 (exactly one comma, no point)
 *     point-grouped   "1.000,50", "1.234.567,8"                   (groups of exactly 3, then a decimal comma)
 * - refused: two or more points without a decimal comma ("1.2.3", "1..5", "1.000.000": "1.000" alone is 1, so
 *   point-only grouping cannot be told from a typo), a misplaced or unfinished thousands comma ("1,2,3",
 *   "1,000,00", "1,000,"), a separator after the decimal one ("1,5.", "1,000.5.5").
 *
 * The one shape with two readings, "1,500" (1-3 digits, a comma, exactly 3 digits), is read as 1500 and echoed as
 * "1500" with "1.5" named as the other reading; any comma echoes the amount read (resolves the ambiguity in the open).
 */
export function strictDecimalReading(raw: string): StrictDecimalReading {
  const t = raw.trim();
  if (t === "") return { ok: true, value: "", echo: null };
  // Exponent BEFORE minus (run 2, #13): "5e-1", "1e-7", "-1e3" are notation, not negatives.
  if (/\d/.test(t) && /[eE]/.test(t) && /^[0-9.,eE+\-−‒–]+$/.test(t)) return { ok: false, reason: EXPONENT_REASON };
  if (MINUS.test(t)) return { ok: false, reason: NEGATIVE_REASON };
  if (/[^0-9.,]/.test(t)) return { ok: false, reason: CHARS_REASON };

  if (PLAIN.test(t)) return { ok: true, value: t, echo: null };

  const amb = AMBIGUOUS_COMMA.exec(t);
  if (amb) {
    const value = amb[1] + amb[2];
    return { ok: true, value, echo: { amount: echoAmount(value), alternative: trimFraction(amb[1], amb[2]) } };
  }
  if (STRICT_COMMA_GROUPED.test(t)) {
    const value = t.replace(/,/g, "");
    return { ok: true, value, echo: { amount: echoAmount(value), alternative: null } };
  }
  if (STRICT_DECIMAL_COMMA.test(t)) {
    const value = t.replace(",", ".");
    return { ok: true, value, echo: { amount: echoAmount(value), alternative: null } };
  }
  if (STRICT_POINT_GROUPED_COMMA_DECIMAL.test(t)) {
    const value = t.replace(/\./g, "").replace(",", ".");
    return { ok: true, value, echo: { amount: echoAmount(value), alternative: null } };
  }
  // Refused. Any point in a text that is not one of the shapes above is a decimal-point problem ("1.2.3", "1..5",
  // "1,5.", "1,000.5.5"); commas alone are a grouping problem ("1,2,3", "1,000,00", "1,000,").
  return { ok: false, reason: t.includes(".") ? ONE_POINT_REASON : GROUPING_REASON };
}

/**
 * Why the typed text is not an amount at all, or null when it is one (possibly still being typed): the reason from
 * `strictDecimalReading`. A field that asks for strict input shows this reason, keeps what was typed, and holds no
 * amount (Council 2026-11-06-go1106-ux, LP; 2026-11-07 council-leftovers run 2).
 */
export function decimalInputRejection(raw: string): string | null {
  const r = strictDecimalReading(raw);
  return r.ok ? null : r.reason;
}

/**
 * An amount with more decimal places than the unit holds: it used to be cut off silently (so "0.0000001" became
 * 0 and Deposit greyed out with no reason). Takes the canonical value from `sanitizeDecimalInput`.
 */
export function amountPrecisionProblem(canonical: string, decimals: number, unit: string): string | null {
  const dot = canonical.indexOf(".");
  if (dot === -1) return null;
  const frac = canonical.slice(dot + 1);
  if (frac.length <= decimals) return null;
  if (decimals <= 0) return `${unit} are whole numbers only.`;
  return `${unit} has ${decimals} decimal places: the smallest amount is 0.${"0".repeat(decimals - 1)}1 ${unit}.`;
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
