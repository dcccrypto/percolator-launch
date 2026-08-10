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
 * GH#2506: this was a hand-enumerated character class, and it omitted
 * characters sitting inside the very categories it exists to reject — the bidi
 * control U+061C, the deprecated format controls U+206A-U+206F, U+180E, and
 * the U+E0000-U+E007F TAG block, which can smuggle hidden ASCII. Enumerating
 * ranges by hand means the filter silently falls behind Unicode. It now matches
 * by PROPERTY instead, so new format characters are covered on sight:
 *
 *   \p{Cc}  C0/C1 controls
 *   \p{Cf}  format characters — every bidi control (including U+061C), the
 *           zero-width set, U+2060-U+2064, U+206A-U+206F, BOM, and the TAG
 *           block
 *   \p{Zl}  line separator (U+2028)
 *   \p{Zp}  paragraph separator (U+2029)
 *
 * Plus a supplement for invisible characters that are Default_Ignorable but
 * carry none of the properties above — the "filler" class, which renders as
 * nothing and is therefore usable for the same padding and dedupe-defeating
 * tricks:
 *
 *   U+115F, U+1160  Hangul choseong/jungseong fillers
 *   U+17B4, U+17B5  Khmer inherent vowels
 *   U+3164          Hangul filler
 *   U+FFA0          halfwidth Hangul filler
 *   U+2065, U+FFF0-U+FFF8  unassigned but Default_Ignorable
 *
 * Deliberately NOT `\p{Default_Ignorable_Code_Point}` on its own, even though
 * it reads like the obvious answer. Variation selectors (U+FE00-U+FE0F,
 * U+E0100-U+E01EF) are Default_Ignorable, and U+FE0F is what makes an emoji
 * render in colour — so that property would newly reject "BTC ❤️" and every
 * other VS16 emoji, which today pass. Verified: `\p{Cc}\p{Cf}\p{Zl}\p{Zp}`
 * leaves U+2764 U+FE0F alone; `\p{Default_Ignorable_Code_Point}` blocks it.
 *
 * One intended behaviour change beyond the gaps above: a TAG-sequence emoji
 * (the England/Scotland/Wales flags, built from U+E0067 etc.) is now rejected,
 * because the TAG block is exactly the hidden-ASCII channel this guard is for.
 * That is the trade the issue asks for, and it is worth stating plainly rather
 * than discovering later.
 */
const INVISIBLE_OR_BIDI = new RegExp(
  "[" +
    "\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}" +
    "\\u115F\\u1160\\u17B4\\u17B5\\u3164\\uFFA0" +
    "\\u2065\\uFFF0-\\uFFF8" +
    "]",
  "u",
);

export function hasInvisibleOrBidi(text: string): boolean {
  return INVISIBLE_OR_BIDI.test(text);
}
