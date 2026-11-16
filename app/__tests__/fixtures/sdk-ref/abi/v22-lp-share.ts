/**
 * v2.2 LP / Earn share token identity (tag 122 `InitLpShareMetadata`): ticker rules, the name / symbol / uri the wrapper writes, and a
 * reader for the Metaplex metadata record it creates.
 *
 * Source of truth: percolator-prog `release/v22-wrapper-rem` `src/lp_share_meta_v22.rs` and `docs/v22-lp-share-mint.md` (security review
 * 2026-10-08, R1-R11). Pure functions; the instruction builder and PDAs are in `../solana/v22-lp-share.ts`.
 *
 * The ticker is chosen by the market creator and is NOT verified by Percolator. The record is cosmetic: no instruction of the program reads it.
 *
 * @module v22-lp-share
 */
import { PublicKey } from "@solana/web3.js";
import type { AccountSpec } from "./accounts.js";

export const LP_SHARE_TICKER_MAX_V22 = 8;
export const LP_SHARE_NAME_PREFIX_V22 = "Percolator Earn Share ";
export const LP_SHARE_NAME_MARKET_CHARS_V22 = 8;
export const LP_SHARE_GENERIC_SYMBOL_V22 = "pEARN";
export const LP_SHARE_TICKER_NAME_PREFIX_V22 = "Percolator Earn ";
export const LP_SHARE_TICKER_NAME_MARKET_CHARS_V22 = 6;
export const LP_SHARE_SYMBOL_PREFIX_V22 = "pe";
/** Metaplex field limits the wrapper pins. */
export const MPL_MAX_NAME_LEN_V22 = 32;
export const MPL_MAX_SYMBOL_LEN_V22 = 10;
export const MPL_MAX_URI_LEN_V22 = 200;
/** Build-time constants of the wrapper (`lp_share_meta_v22.rs`). The uri a record carries is fixed at birth by the program build. */
export const LP_SHARE_URI_BASE_DEVNET_V22 = "https://play.percolator.trade";
/** FOUNDER DECISION pending (the builder's default); confirm before a mainnet build. */
export const LP_SHARE_URI_BASE_MAINNET_V22 = "https://percolator.trade";
export const LP_SHARE_URI_PATH_V22 = "/api/earn-share/";
/** Lamports the caller must HOLD to create a record (net cost is ~15.1M; the rest comes back in the same instruction). */
export const LP_SHARE_META_FUND_LAMPORTS_V22 = 30_000_000n;
/** Metaplex Token Metadata program. */
export const METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22 = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const MPL_KEY_METADATA_V1 = 4;

/**
 * Reduce a market symbol to the ticker the wrapper accepts: uppercase, drop every character outside `A-Z 0-9`, keep the first 8.
 * An empty result means "send the generic form" (`n = 0`); the program never truncates, it refuses.
 * @example lpShareTickerFromSymbolV22("1000pepe") === "1000PEPE"; lpShareTickerFromSymbolV22("$wif-2") === "WIF2"; lpShareTickerFromSymbolV22("日本") === ""
 */
export function lpShareTickerFromSymbolV22(symbol: string | null | undefined): string {
  if (!symbol) return "";
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, LP_SHARE_TICKER_MAX_V22);
}

/** The program's ticker check: 1..=8 bytes, each `A-Z` or `0-9`. */
export function isLpShareTickerV22(ticker: string): boolean {
  return /^[A-Z0-9]{1,8}$/.test(ticker);
}

export interface LpShareIdentityV22 {
  name: string;
  symbol: string;
  uri: string;
  /** `true` = ticker form (immutable record), `false` = generic (mutable). */
  ticker: boolean;
}

/**
 * The name, symbol and uri the wrapper writes for `market`. Ticker form when `ticker` is non-empty (throws if it is not
 * {@link isLpShareTickerV22}); generic form otherwise. `uriBase` is the build's constant (devnet or mainnet).
 */
export function lpShareIdentityV22(market: PublicKey, ticker: string, uriBase: string = LP_SHARE_URI_BASE_DEVNET_V22): LpShareIdentityV22 {
  const b58 = market.toBase58();
  const uri = `${uriBase}${LP_SHARE_URI_PATH_V22}${b58}`;
  if (ticker === "") {
    return { name: `${LP_SHARE_NAME_PREFIX_V22}${b58.slice(0, LP_SHARE_NAME_MARKET_CHARS_V22)}`, symbol: LP_SHARE_GENERIC_SYMBOL_V22, uri, ticker: false };
  }
  if (!isLpShareTickerV22(ticker)) throw new Error(`ticker must be 1..8 characters of A-Z 0-9, got ${JSON.stringify(ticker)}`);
  return {
    name: `${LP_SHARE_TICKER_NAME_PREFIX_V22}${ticker} ${b58.slice(0, LP_SHARE_TICKER_NAME_MARKET_CHARS_V22)}`,
    symbol: `${LP_SHARE_SYMBOL_PREFIX_V22}${ticker}`,
    uri,
    ticker: true,
  };
}

/** The fields of a Metaplex `MetadataV1` the share endpoint and the app need. Strings have their NUL padding trimmed. */
export interface LpShareMetadataRecordV22 {
  updateAuthority: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  isMutable: boolean;
}

/**
 * Read a Metaplex metadata account. Strict: returns `null` (never throws) for anything that does not parse as a `MetadataV1`
 * (wrong key byte, a string over the Metaplex limit, bad option tags, truncation). The caller must still check the account owner
 * (Metaplex program), `updateAuthority` (the registry PDA) and `mint` (the share mint) before trusting name / symbol: a record that is
 * not ours says whatever its creator wanted.
 */
export function parseLpShareMetadataRecordV22(data: Uint8Array): LpShareMetadataRecordV22 | null {
  let o = 0;
  const take = (n: number): Uint8Array | null => {
    if (o + n > data.length) return null;
    const s = data.subarray(o, o + n);
    o += n;
    return s;
  };
  const takeStr = (max: number): string | null => {
    const l = take(4);
    if (!l) return null;
    const n = new DataView(l.buffer, l.byteOffset, 4).getUint32(0, true);
    if (n > max) return null;
    const s = take(n);
    if (!s) return null;
    let end = s.length;
    while (end > 0 && s[end - 1] === 0) end--;
    return new TextDecoder("utf-8", { fatal: false }).decode(s.subarray(0, end));
  };
  const key = take(1);
  if (!key || key[0] !== MPL_KEY_METADATA_V1) return null;
  const ua = take(32), mint = take(32);
  if (!ua || !mint) return null;
  const name = takeStr(MPL_MAX_NAME_LEN_V22), symbol = takeStr(MPL_MAX_SYMBOL_LEN_V22), uri = takeStr(MPL_MAX_URI_LEN_V22);
  if (name === null || symbol === null || uri === null) return null;
  if (!take(2)) return null; // seller_fee_basis_points
  const hc = take(1);
  if (!hc) return null;
  if (hc[0] === 1) {
    const nl = take(4);
    if (!nl) return null;
    const n = new DataView(nl.buffer, nl.byteOffset, 4).getUint32(0, true);
    if (n > 5 || !take(n * 34)) return null;
  } else if (hc[0] !== 0) return null;
  if (!take(1)) return null; // primary_sale_happened
  const im = take(1);
  if (!im || (im[0] !== 0 && im[0] !== 1)) return null;
  return { updateAuthority: new PublicKey(ua.slice()), mint: new PublicKey(mint.slice()), name, symbol, uri, isMutable: im[0] === 1 };
}

/**
 * InitLpShareMetadata (tag 122) accounts: 7 for the generic form (ticker length 0), 9 with a ticker.
 * `[7]` market and `[8]` marketauth (signer) are only passed when the data carries a ticker ({@link ACCOUNTS_INIT_LP_SHARE_METADATA_TICKER_TAIL}).
 */
export const ACCOUNTS_INIT_LP_SHARE_METADATA: readonly AccountSpec[] = [
  { name: "payer", signer: true, writable: true },
  { name: "registry", signer: false, writable: false },
  { name: "lpMint", signer: false, writable: false },
  { name: "metadata", signer: false, writable: true },
  { name: "metaplexProgram", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
  { name: "feePayerPda", signer: false, writable: true },
] as const;

/** Extra accounts of the ticker form of tag 122: market (read-only) then marketauth (signer). */
export const ACCOUNTS_INIT_LP_SHARE_METADATA_TICKER_TAIL: readonly AccountSpec[] = [
  { name: "market", signer: false, writable: false },
  { name: "marketauth", signer: true, writable: false },
] as const;
