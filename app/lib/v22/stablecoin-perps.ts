/**
 * Dollar stablecoins are not perp underlyings on v2.2 (owner decision 2026-11-09, Council R2-11 / R3-10; widened to the whole
 * USD-stable class in Council r5 #2).
 *
 * One list and one predicate for every off-chain gate: the create wizard (UI), POST /api/markets (registration, incl. a
 * pool-only registration: the pool's mints are resolved server-side, see ./stablecoin-resolve), GET /api/markets (listing),
 * POST /api/mobile/create-market, POST /api/playground/keeper-register and POST /api/oracle-keeper/register. v2.2 flag only:
 * with the flag off nothing here blocks. This is NOT an on-chain rule: InitMarket stays permissionless, so these gates only keep
 * such a market from being created through the app or listed by it.
 *
 * Two layers:
 *  1. ADDRESS (primary, authoritative): STABLECOIN_MINT_LIST, every entry verified on-chain + against an independent source.
 *  2. SYMBOL / NAME (defence in depth): a token whose on-chain symbol or name IS a stable ticker (USDC, DAI, FDUSD, USDe, ...,
 *     with a bridge/wrapper prefix or suffix such as s / w / a / ae / et / bs) is refused even when its address is not in the
 *     list (a new bridge, a re-issue, an impersonator). This is a HARD block, and deliberately an EXACT-ticker match, not
 *     a "USD then anything" pattern: real memecoins are called USDUC, USDP, USDARK..., and "contains USD" would refuse them. The looser "looks
 *     USD-ish" pattern is only a WARNING ("suspect"): never a refusal, surfaced to Sentry by the server. Server routes derive the
 *     symbol/name from the token's on-chain metadata and never trust a client-supplied one to ALLOW anything (a client symbol can
 *     only add a refusal).
 *
 * Mainnet mints (the address pasted at step 1 / stored as `mainnet_ca` is the mainnet reference CA).
 */
import { PublicKey } from "@solana/web3.js";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { STABLECOIN_MINT_LIST } from "@/lib/v22/stablecoin-mints";

export { STABLECOIN_MINT_LIST } from "@/lib/v22/stablecoin-mints";
export type { StablecoinMint } from "@/lib/v22/stablecoin-mints";

export const STABLECOIN_PERP_MINTS: ReadonlySet<string> = new Set(STABLECOIN_MINT_LIST.map((m) => m.address));

export const STABLECOIN_PERP_REASON =
  "This is a dollar stablecoin (USDC, USDT, PYUSD, USDS, FDUSD, USDe, USDG, USD+, USX, JupUSD, RLUSD and similar), so it can't be a perp market's token. Paste the mint of the token you want to list.";

export const STABLECOIN_MISMATCH_REASON =
  "The token (mainnet_ca) you gave is not the base token of the pool you gave, so we can't tell which token this market prices. Use the pool that trades this token.";

export const STABLECOIN_NO_IDENTITY_REASON =
  "This market has no token identity: give the token's mint address (mainnet_ca) and its pool (dex_pool_address) so we can confirm it isn't a dollar stablecoin.";

export const STABLECOIN_POOL_MISMATCH_REASON =
  "The pool you gave is not the pool this market is pinned to on-chain (dex_pool). Register the market with its own pool.";

export const STABLECOIN_UNVERIFIABLE_REASON =
  "We couldn't read this market's token from its pool on mainnet, so we can't confirm it isn't a dollar stablecoin. Register it with the token's mint address (mainnet_ca) and a supported Pump.fun or Meteora pool.";

/** Normalised (upper-case, alphanumerics only) tickers of the verified USD stables. USDP / USDD / USDL / USDX are left out on purpose: live memecoins use them. */
const STABLE_TICKERS = ["USDC", "USDT", "PYUSD", "USDS", "FDUSD", "USDE", "USDG", "DAI", "UXD", "USDH", "AUSD", "USD1", "HYUSD", "FRXUSD", "RLUSD", "USDTB", "JUPUSD", "USDT0"];
/**
 * Tickers that are ordinary words or short and so are matched EXACTLY only (no wrapper prefix / bridge suffix: "GHOST" is another thing).
 * Added 2026-11-11: USD+ (Overnight), acUSD (Allbridge cUSD), eUSX (Solstice), GHO (Aave), FRAX, TUSD, BUSD. "USD+" is matched on its raw form
 * (normalising would reduce it to the bare "USD"), see isUsdPlus.
 *
 * r8: BOLD, USX and CASH are deliberately NOT here. They are ordinary words / short tickers that unrelated memecoins use, so they are
 * blocked BY MINT ONLY: the verified USX and CASH mints are in STABLECOIN_MINT_LIST (Liquity BOLD has no Solana mint). The name phrases
 * for the bare words are gone for the same reason; the qualified names ("Solstice USX", "Liquity BOLD") are still refused.
 * r9 (owner decision 2026-11-12): USDY joins them. An unrelated memecoin uses the exact ticker USDY, so Ondo USDY is blocked by its
 * verified mint only (A1KLoBrK..., in STABLECOIN_MINT_LIST); the bare ticker and bare name "USDY" are no longer refused, and the
 * qualified name "Ondo US Dollar Yield" still is.
 */
const EXACT_ONLY_TICKERS: ReadonlySet<string> = new Set(["ACUSD", "EUSX", "GHO", "FRAX", "TUSD", "BUSD"]);
/** Wrapper / bridge prefixes (s = staked, w = wrapped, a = aave / allbridge, ae/ap/ab/ac/aa = Allbridge chains, j/jl = Jupiter lend, ...). */
const WRAP_PREFIXES = ["W", "S", "B", "A", "X", "J", "JL", "ST", "AE", "AP", "AB", "AC", "AA"];
/** Bridge suffixes (Portal: et / po / bs / av / so, and the ".e" form which normalises to a trailing E for USDC / USDT only). */
const WRAP_SUFFIXES = ["ET", "PO", "BS", "AV", "SO"];
const STABLE_SYMBOL_RE = new RegExp(`^(?:${WRAP_PREFIXES.join("|")})?(?:${STABLE_TICKERS.join("|")})(?:${WRAP_SUFFIXES.join("|")})?$|^(?:USDC|USDT)E$|^UST$`); // UST exact only: a wrapper prefix would hit JUST / BUST / AUST etc.

const NAME_PHRASES = [
  "usd coin", "usdc", "tether usd", "tether usdt", "usdt", "tether", "paypal usd", "pyusd", "first digital usd", "fdusd", "global dollar", "usdg",
  "dai", "dai stablecoin", "savings dai", "ethena usde", "usde", "staked usde", "sky dollar", "usds", "world liberty financial usd", "ondo us dollar yield",
  "hubble stablecoin", "usdh hubble stablecoin", "uxd stablecoin", "agora dollar", "hylo usd", "frax usd",
  "usd+", "overnight usd+", "wrapped cusd", "cusd", "solstice usx", "eusx", "solstice eusx", "gho", "aave gho", "frax", "frax dollar", "legacy frax dollar",
  "liquity bold", "liquity usd", "tusd", "trueusd", "busd", "binance usd", "binance-peg busd", "usdt0", "rlusd", "ripple usd",
  "usdtb", "ethena usdtb", "jupusd", "jupiter usd",
];
/** A whole-name match: [Wrapped] <phrase> [(parenthetical)...] — "Wrapped USDC (Allbridge from Ethereum)", "USD Coin (Portal from BSC)". */
const STABLE_NAME_RE = new RegExp(`^(?:wrapped )?(?:${NAME_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?: ?\\([^)]*\\))*$`);

/** Invisible / formatting characters that do not render but change the string: zero-width, bidi controls, soft hyphen, fillers, variation selectors, tags. */
const INVISIBLE_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;

/** Cyrillic / Greek / Armenian / Cherokee lookalikes of Latin letters (NFKC, applied first, already folds fullwidth and mathematical forms). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic upper
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M", "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C",
  "\u0422": "T", "\u0423": "Y", "\u0425": "X", "\u0405": "S", "\u0406": "I", "\u0408": "J", "\u04C0": "I",
  // Cyrillic lower
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0455": "s", "\u0456": "i", "\u0458": "j",
  "\u04BB": "h", "\u0501": "d", "\u051B": "q", "\u051D": "w", "\u04CF": "l",
  // Greek upper
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O",
  "\u03A1": "P", "\u03A4": "T", "\u03A5": "Y", "\u03A7": "X",
  // Greek lower
  "\u03BF": "o", "\u03BD": "v", "\u03B9": "i", "\u03C1": "p", "\u03C5": "u", "\u03B1": "a", "\u03BA": "k",
  // Armenian / Cherokee lookalikes (single-letter ASCII targets from Unicode confusables.txt)
  "\u0545": "3", "\uAB9E": "4", "\u13CE": "4", "\uABBE": "6", "\u13EE": "6", "\u13AA": "A", "\u13CF": "b", "\u13F4": "B", "\uABAF": "c", "\u13DF": "C", "\u13E7": "d", "\u13A0": "D", "\u13AC": "E", "\u0584": "f", "\u0581": "g", "\u13C0": "G", "\u13F3": "G", "\u0570": "h", "\u13C2": "h", "\u13BB": "H", "\u0582": "i", "\uAB75": "i", "\u13A5": "i", "\u0575": "j", "\u13AB": "J", "\u13E6": "K", "\u13DE": "L", "\u13B7": "M", "\u0578": "n", "\u057C": "n", "\u0585": "o", "\u0555": "O", "\u13E2": "P", "\u0563": "q", "\u0566": "q", "\uAB81": "r", "\u13A1": "R", "\u13D2": "R", "\uABAA": "s", "\u054F": "S", "\u13D5": "S", "\u13DA": "S", "\u13A2": "T", "\u057D": "u", "\u054D": "U", "\uABA9": "v", "\u13D9": "V", "\u0561": "w", "\uAB83": "w", "\uABA4": "w", "\u13B3": "W", "\u13D4": "W", "\u13A9": "Y", "\u13BD": "Y", "\uAB93": "z", "\u13C3": "Z",
  // Latin lookalikes outside ASCII
  "\u0131": "i", "\u0269": "i", "\u0251": "a", "\u0261": "g", "\u1D00": "A", "\u1D04": "C", "\u1D05": "D", "\u1D07": "E", "\u1D1C": "U",
};

/**
 * Canonical form for matching: strip invisible characters, NFKC (fullwidth, compatibility forms), drop combining marks (NFD), fold the
 * Cyrillic / Greek lookalikes to Latin, strip invisibles again. Only the lookalike letters are mapped, so a genuinely non-Latin word
 * (Japanese, Arabic, a Cyrillic word with a non-lookalike letter) stays non-Latin and matches nothing.
 */
export function foldIdentity(raw: string): string {
  const base = raw.replace(INVISIBLE_RE, "").normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").normalize("NFKC");
  let out = "";
  for (const ch of base) out += CONFUSABLES[ch] ?? ch;
  return out.replace(INVISIBLE_RE, "");
}

function normSymbol(raw: string): string {
  return foldIdentity(raw).replace(/\u20ae/g, "T").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
/** "USD+" (Overnight) on its raw form: normSymbol would reduce it to "USD". */
function isUsdPlus(raw: string): boolean {
  return foldIdentity(raw).replace(/\s+/g, "").toUpperCase() === "USD+";
}
function normName(raw: string): string {
  return foldIdentity(raw).replace(/\s+/g, " ").trim().toLowerCase();
}

export interface StablecoinTokenMeta {
  symbol?: string | null;
  name?: string | null;
}

/**
 * "block": the symbol or the full name is a verified USD-stable identity. "suspect": it looks USD-ish (contains USD, or
 * stablecoin / dollar wording) but is not a stable identity: a warning only. null: nothing stable-like.
 */
export function stablecoinIdentityVerdict(meta: StablecoinTokenMeta | null | undefined): "block" | "suspect" | null {
  const symbol = typeof meta?.symbol === "string" ? meta.symbol : "";
  const name = typeof meta?.name === "string" ? meta.name : "";
  if (symbol) {
    const n = normSymbol(symbol);
    if (STABLE_SYMBOL_RE.test(n) || EXACT_ONLY_TICKERS.has(n) || isUsdPlus(symbol)) return "block";
  }
  if (name && STABLE_NAME_RE.test(normName(name))) return "block";
  if ((symbol && /USD/i.test(foldIdentity(symbol))) || (name && /(\busd\b|usd[a-z0-9]|stable ?coin|dollar)/i.test(foldIdentity(name)))) return "suspect";
  return null;
}

/** Address-only check (no flag): is `ca` (trimmed, canonicalised through PublicKey when it parses) in the verified list? */
export function isStablecoinMintAddress(ca: string | null | undefined): boolean {
  if (typeof ca !== "string") return false;
  const v = ca.trim();
  if (v.length === 0) return false;
  if (STABLECOIN_PERP_MINTS.has(v)) return true;
  try {
    return STABLECOIN_PERP_MINTS.has(new PublicKey(v).toBase58());
  } catch {
    return false;
  }
}

/**
 * True on v2.2 when `ca` is a blocked stablecoin mint, or (when `meta` is given) the token's symbol / name is a hard-block stable
 * identity. `meta` from a client is refuse-only: it can add a refusal, never lift one.
 */
export function isStablecoinPerpBlocked(ca: string | null | undefined, meta?: StablecoinTokenMeta | null): boolean {
  if (!isDevnetV22Enabled()) return false;
  return isStablecoinMintAddress(ca) || stablecoinIdentityVerdict(meta) === "block";
}
