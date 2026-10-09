/**
 * The off-chain half of the Earn share token's identity (percolator-prog `docs/v22-lp-share-mint.md`, "The JSON the app must serve", and the
 * security review's R10: "the endpoint must build its response from chain state and validate the market parameter").
 *
 * Pure functions; the routes `app/api/earn-share/[market]` (JSON) and `.../image` (PNG) are thin wrappers. Nothing here reads a secret, the
 * app database or the request's Host header: the public base URL is a constant of the program build (devnet or mainnet), and the response is
 * built from two accounts: the LP vault registry PDA (existence + owner) and the Metaplex record of the share mint.
 */
import { PublicKey } from "@solana/web3.js";
import {
  LP_SHARE_URI_BASE_DEVNET_V22,
  LP_SHARE_URI_BASE_MAINNET_V22,
  LP_SHARE_GENERIC_SYMBOL_V22,
  lpShareIdentityV22,
  type LpShareMetadataRecordV22,
} from "./sdk";

/** The program's own limits for the fields it writes (lp_share_meta_v22.rs); a record outside them is not what the program wrote. */
const NAME_MAX = 32;
const SYMBOL_MAX = 10;

/**
 * The path parameter as a market key: base58 of EXACTLY 32 bytes, in canonical text form (so `canonical.toBase58() === raw`: no leading
 * `1`s dropped or added, no alternate encodings). Anything else is `null` (the route answers 404). Never echo `raw`.
 */
export function parseMarketParam(raw: string | undefined | null): PublicKey | null {
  if (typeof raw !== "string" || raw.length < 32 || raw.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) return null;
  try {
    const pk = new PublicKey(raw);
    return pk.toBase58() === raw ? pk : null;
  } catch {
    return null;
  }
}

/** The public base URL fixed by the program build: devnet `https://play.percolator.trade`, mainnet `https://percolator.trade`. */
export function shareBaseUrl(network: "devnet" | "mainnet"): string {
  return network === "mainnet" ? LP_SHARE_URI_BASE_MAINNET_V22 : LP_SHARE_URI_BASE_DEVNET_V22;
}

export interface EarnShareMetadataJson {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
  properties: { category: "image"; files: { uri: string; type: "image/png" }[] };
}

/** Printable ASCII only: the program writes `A-Z0-9`, spaces and the fixed framing, so anything else is not its record. */
const printable = (s: string): boolean => /^[\x20-\x7e]+$/.test(s);

/**
 * Name and symbol from the share mint's Metaplex record, or the generic form.
 *
 * The record counts only when it is OURS: update authority = the registry PDA and mint = the share mint (the caller passes the expected keys;
 * a record with another update authority says whatever its creator wanted). A record that is ours but carries text the program could not have
 * written (non-printable, over Metaplex's limits, empty) falls back to the generic form, so a hostile Metaplex upgrade can at worst show the
 * generic name here. The ticker form's `pe<TICKER>` symbol is accepted only with the program's framing.
 */
export function shareIdentityFromChain(
  market: PublicKey,
  record: LpShareMetadataRecordV22 | null,
  expected: { registry: PublicKey; mint: PublicKey },
  uriBase: string,
): { name: string; symbol: string; ticker: string } {
  const generic = lpShareIdentityV22(market, "", uriBase);
  const fallback = { name: generic.name, symbol: generic.symbol, ticker: "" };
  if (!record) return fallback;
  if (!record.updateAuthority.equals(expected.registry) || !record.mint.equals(expected.mint)) return fallback;
  const { name, symbol } = record;
  if (name.length === 0 || name.length > NAME_MAX || symbol.length === 0 || symbol.length > SYMBOL_MAX) return fallback;
  if (!printable(name) || !printable(symbol)) return fallback;
  if (symbol === LP_SHARE_GENERIC_SYMBOL_V22) return { name, symbol, ticker: "" };
  const m = /^pe([A-Z0-9]{1,8})$/.exec(symbol);
  if (!m || !name.startsWith("Percolator Earn ")) return fallback;
  return { name, symbol, ticker: m[1] };
}

/** The JSON body of `GET /api/earn-share/<market>` (spec in the wrapper's docs): from chain state only. */
export function buildEarnShareMetadata(market: PublicKey, id: { name: string; symbol: string; ticker: string }, base: string): EarnShareMetadataJson {
  const m = market.toBase58();
  const image = `${base}/api/earn-share/${m}/image`;
  const what = id.ticker ? `the ${id.ticker} market` : "a market";
  return {
    name: id.name,
    symbol: id.symbol,
    description:
      `Share of the Earn vault of ${what} on Percolator (market ${m.slice(0, 8)}...). ` +
      (id.ticker ? "The ticker is set by the market creator and is not verified by Percolator." : "The market creator has not named this share."),
    image,
    external_url: `${base}/earn/${m}`,
    properties: { category: "image", files: [{ uri: image, type: "image/png" }] },
  };
}

/** Hosts a market's creator-supplied logo may be fetched from (server side, https only, no redirects). Anything else = no logo, never an error. */
export const LOGO_HOST_ALLOWLIST: readonly string[] = [
  "assets.coingecko.com",
  "coin-images.coingecko.com",
  "assets.geckoterminal.com",
  "dd.dexscreener.com",
  "cdn.dexscreener.com",
  "static.jup.ag",
  "arweave.net",
  "ipfs.io",
];

/** Whether `url` may be fetched as a logo: https, port 443, a host on the allowlist (or the project's own storage host), no credentials. */
export function isFetchableLogoUrl(url: string | null | undefined, extraHosts: readonly string[] = []): boolean {
  if (!url || url.length > 500) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return [...LOGO_HOST_ALLOWLIST, ...extraHosts.map((h) => h.toLowerCase())].includes(host);
}

/** Largest logo the image route will read, in bytes. */
export const LOGO_MAX_BYTES = 1_000_000;
