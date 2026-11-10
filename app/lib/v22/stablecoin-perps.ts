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
  "This is a dollar stablecoin (USDC, USDT, PYUSD, USDS, FDUSD, USDe, USDG and similar), so it can't be a perp market's token. Paste the mint of the token you want to list.";

export const STABLECOIN_MISMATCH_REASON =
  "The token (mainnet_ca) you gave is not the base token of the pool you gave, so we can't tell which token this market prices. Use the pool that trades this token.";

export const STABLECOIN_UNVERIFIABLE_REASON =
  "We couldn't read this market's token from its pool on mainnet, so we can't confirm it isn't a dollar stablecoin. Register it with the token's mint address (mainnet_ca) and a supported Pump.fun or Meteora pool.";

/** Normalised (upper-case, alphanumerics only) tickers of the verified USD stables. USDP / USDD / USDL / USDX are left out on purpose: live memecoins use them. */
const STABLE_TICKERS = ["USDC", "USDT", "PYUSD", "USDS", "FDUSD", "USDE", "USDG", "DAI", "UXD", "USDH", "USDY", "AUSD", "USD1", "HYUSD", "FRXUSD"];
/** Wrapper / bridge prefixes (s = staked, w = wrapped, a = aave / allbridge, ae/ap/ab/ac/aa = Allbridge chains, j/jl = Jupiter lend, ...). */
const WRAP_PREFIXES = ["W", "S", "B", "A", "X", "J", "JL", "ST", "AE", "AP", "AB", "AC", "AA"];
/** Bridge suffixes (Portal: et / po / bs / av / so, and the ".e" form which normalises to a trailing E for USDC / USDT only). */
const WRAP_SUFFIXES = ["ET", "PO", "BS", "AV", "SO"];
const STABLE_SYMBOL_RE = new RegExp(`^(?:${WRAP_PREFIXES.join("|")})?(?:${STABLE_TICKERS.join("|")})(?:${WRAP_SUFFIXES.join("|")})?$|^(?:USDC|USDT)E$|^UST$`); // UST exact only: a wrapper prefix would hit JUST / BUST / AUST etc.

const NAME_PHRASES = [
  "usd coin", "usdc", "tether usd", "tether usdt", "usdt", "tether", "paypal usd", "pyusd", "first digital usd", "fdusd", "global dollar", "usdg",
  "dai", "dai stablecoin", "ethena usde", "usde", "staked usde", "sky dollar", "usds", "world liberty financial usd", "ondo us dollar yield", "usdy",
  "hubble stablecoin", "usdh hubble stablecoin", "uxd stablecoin", "agora dollar", "hylo usd", "frax usd",
];
/** A whole-name match: [Wrapped] <phrase> [(parenthetical)...] — "Wrapped USDC (Allbridge from Ethereum)", "USD Coin (Portal from BSC)". */
const STABLE_NAME_RE = new RegExp(`^(?:wrapped )?(?:${NAME_PHRASES.join("|")})(?: ?\\([^)]*\\))*$`);

function normSymbol(raw: string): string {
  return raw.normalize("NFKC").replace(/\u20ae/g, "T").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
function normName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
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
  if (symbol && STABLE_SYMBOL_RE.test(normSymbol(symbol))) return "block";
  if (name && STABLE_NAME_RE.test(normName(name))) return "block";
  if ((symbol && /USD/i.test(symbol)) || (name && /(\busd\b|usd[a-z0-9]|stable ?coin|dollar)/i.test(name))) return "suspect";
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
