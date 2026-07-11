/**
 * Detects invisible / bidirectional / format characters in user-supplied
 * display text (e.g. a market name). These are NOT C0 control chars — they
 * pass a `[\x00-\x1f\x7f]` filter — but they are the active impersonation
 * vectors: RTL/LTR overrides and isolates can visually reorder text to mimic
 * another market or scramble adjacent UI, and zero-width characters hide
 * payloads and defeat dedupe-by-eye.
 *
 * Visible Unicode (accents, CJK, emoji) is intentionally NOT matched — legit
 * tokens use it, so this is not an ASCII-only filter. Homoglyph confusables
 * (e.g. Cyrillic letters that look Latin) are visible and out of scope here;
 * those are best handled by a verified-market badge.
 *
 * Ranges, in order: C1 controls; soft hyphen; zero-width chars + bidi marks
 * (LRM/RLM); line/paragraph separators; bidi embeddings + overrides; word
 * joiner + invisible math operators; bidi isolates; BOM / ZW no-break space.
 */
const INVISIBLE_OR_BIDI =
  /[\u0080-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export function hasInvisibleOrBidi(text: string): boolean {
  return INVISIBLE_OR_BIDI.test(text);
}
