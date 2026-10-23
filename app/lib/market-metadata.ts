/**
 * One rule for a market's `symbol` / `name`, shared by the launch wizard, the creation-tx
 * registration memo and /api/playground/keeper-register.
 *
 * Why this exists: the wizard's token-name sanitiser used to strip every non-Latin character, so
 * a token named "ちいかわ" became "" and the memo (which binds the payload digest) was signed over
 * `name: ""`. The route then refused it for ever (400 "Invalid payload.name") while the launch was
 * already on chain. The route's validators (`checkName` / `checkSymbol`, lib/market-metadata-
 * validation.ts) are the single source of truth; everything here produces values that pass them,
 * and `preflightRegistration` runs the very same validators before the first signature.
 *
 * Names keep Unicode letters, marks, numbers and emoji (CJK, Cyrillic, accented Latin are real
 * token names); the route's name rule already allows them, and the invisible / bidi / control
 * characters it rejects are stripped here. Symbols stay `[A-Za-z0-9._-]{1,20}` because the symbol
 * rule is ASCII-only (it is also used in keeper symbol routing and URLs), so a non-Latin symbol
 * falls back to a short form of the mint.
 */
import { hasInvisibleOrBidi } from "@/lib/text-safety";
import { checkName, checkSymbol, NAME_MAX_LEN, SYMBOL_RE } from "@/lib/market-metadata-validation";
import { validateRegistrationPayload } from "@/lib/keeper-register-memo";

const SYMBOL_MAX_LEN = 20;
const KEEP_NAME_CHAR = /[\p{L}\p{M}\p{N} \-._()$#&]|\p{Extended_Pictographic}/u;

/** Drop invisible / bidi / control chars, collapse whitespace, trim. */
function cleanVisible(input: string): string {
  const out: string[] = [];
  for (const ch of input.normalize("NFC")) {
    // ZWJ / variation selectors etc. are Cf and rejected by checkName, so they go too.
    if (!hasInvisibleOrBidi(ch)) out.push(ch);
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

/**
 * Display-name sanitiser for token metadata (used by lib/tokenMeta.ts). Keeps Unicode letters,
 * combining marks (at most 3 in a row, no zalgo), numbers, emoji and ` -._()$#&`.
 */
export function sanitizeDisplayName(input: string, maxLen: number): string {
  if (typeof input !== "string") return "";
  const kept: string[] = [];
  let marks = 0;
  for (const ch of cleanVisible(input)) {
    if (!KEEP_NAME_CHAR.test(ch) || hasInvisibleOrBidi(ch)) continue;
    if (/\p{M}/u.test(ch)) {
      if (++marks > 3) continue;
    } else {
      marks = 0;
    }
    kept.push(ch);
  }
  return kept.slice(0, maxLen).join("").trim();
}

/** `ABCD1234`-style short form of a mint, always a valid symbol. */
export function shortMintSymbol(mint: string): string {
  const alnum = (mint ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length === 0) return "UNKNOWN";
  return alnum.length <= 8 ? alnum : alnum.slice(0, 4) + alnum.slice(-4);
}

/** A symbol the route accepts: ASCII-filtered raw symbol, else the mint's short form. */
export function toRegistrableSymbol(raw: string | null | undefined, mint: string): string {
  const ascii = (raw ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, SYMBOL_MAX_LEN);
  return SYMBOL_RE.test(ascii) ? ascii : shortMintSymbol(mint);
}

/** A name the route accepts: cleaned raw name, else the symbol. */
export function toRegistrableName(raw: string | null | undefined, symbol: string): string {
  const cleaned = cleanVisible(typeof raw === "string" ? raw : "");
  // checkName counts UTF-16 units: cap on code points, then shave surrogate pairs until it fits.
  const cps = Array.from(cleaned);
  while (cps.join("").length > NAME_MAX_LEN) cps.pop();
  const name = cps.join("").trim();
  return checkName(name).ok ? name : symbol;
}

/** Resolve the (symbol, name) pair that the memo and the payload will both carry. */
export function resolveMarketMetadata(args: {
  symbol?: string | null;
  name?: string | null;
  mint: string;
}): { symbol: string; name: string } {
  const symbol = toRegistrableSymbol(args.symbol, args.mint);
  return { symbol, name: toRegistrableName(args.name, symbol) };
}

/**
 * Run the route's own validators over what a launch is about to bind, BEFORE the first
 * signature. Returns the first problem, or null. `payload` is the markets-row payload the memo
 * digests; `symbol` / `label` are the memo-bound symbol and (optional) label.
 */
export function preflightRegistration(args: {
  symbol?: string | null;
  label?: string | null;
  payload?: unknown;
}): string | null {
  if (args.symbol !== null && args.symbol !== undefined) {
    const r = checkSymbol(args.symbol);
    if (!r.ok) return r.error;
  }
  if (args.label !== null && args.label !== undefined) {
    const r = checkName(args.label);
    if (!r.ok) return r.error;
  }
  const v = validateRegistrationPayload(args.payload ?? null);
  if (!v.ok) return v.error;
  return null;
}
