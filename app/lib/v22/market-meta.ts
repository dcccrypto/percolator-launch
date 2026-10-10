/**
 * v2.2 preview market list, from the build environment instead of the live devnet Supabase `markets` table.
 *
 * The v2.2 preview deployment runs WITHOUT Supabase (so it can never insert into, or read from, the table the live
 * playground and keeper use) and lists markets through on-chain discovery against its own (fresh) wrapper id. Discovery
 * on a playground build only shows curated slabs (PLAYGROUND_SLAB_META) plus wizard registrations; seeded v2.2 markets
 * are neither, so they would be hidden and nameless. `NEXT_PUBLIC_V22_MARKETS_JSON` supplies them as curated entries:
 *
 *   [{"slab":"<base58>","symbol":"SOL","name":"Solana","mainnet_ca":"<base58>","dex_pool_address":"<base58>",
 *     "lp_portfolio_address":"<base58>"}, ...]
 *
 * Read only when the v2.2 flag is on and the build is not mainnet; otherwise (and for any malformed input) it is `{}`,
 * so a v2.1 / playground build is unchanged. A bad entry is skipped with a warning; the rest still load.
 * `NEXT_PUBLIC_*` is inlined at build time, so the variable is read literally.
 *
 * Leaf module (imported by lib/playground-slab-meta.ts, which client hooks import): no app imports except the flag.
 */
import { PublicKey } from "@solana/web3.js";
import { isDevnetV22Enabled } from "./flag";

export interface V22MarketMeta {
  symbol: string;
  name: string;
  mainnet_ca: string;
  dex_pool_address: string;
  lp_portfolio_address: string;
}

/** More than this many entries is a misconfiguration, not a market list. */
export const V22_MARKETS_MAX = 32;

const KEY_FIELDS = ["slab", "mainnet_ca", "dex_pool_address", "lp_portfolio_address"] as const;

function canonicalKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    return new PublicKey(s).toBase58() === s ? s : null;
  } catch {
    return null;
  }
}

/** Printable label, 1..max chars; null otherwise. */
function label(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(s)) return null;
  return s;
}

/** Parse the JSON market list. Pure; never throws. */
export function parseV22MarketMeta(raw: string | undefined): Record<string, V22MarketMeta> {
  const out: Record<string, V22MarketMeta> = {};
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[v22-markets] NEXT_PUBLIC_V22_MARKETS_JSON is not valid JSON; ignoring it");
    return out;
  }
  if (!Array.isArray(parsed)) {
    console.warn("[v22-markets] NEXT_PUBLIC_V22_MARKETS_JSON must be a JSON array; ignoring it");
    return out;
  }
  if (parsed.length > V22_MARKETS_MAX) {
    console.warn(`[v22-markets] more than ${V22_MARKETS_MAX} entries; ignoring the list`);
    return out;
  }
  parsed.forEach((e: unknown, i: number) => {
    if (typeof e !== "object" || e === null) {
      console.warn(`[v22-markets] entry ${i} is not an object; skipped`);
      return;
    }
    const r = e as Record<string, unknown>;
    const keys: Partial<Record<(typeof KEY_FIELDS)[number], string>> = {};
    for (const f of KEY_FIELDS) {
      const k = canonicalKey(r[f]);
      if (!k) {
        console.warn(`[v22-markets] entry ${i}: "${f}" is not a base58 public key; skipped`);
        return;
      }
      keys[f] = k;
    }
    const symbol = label(r.symbol, 16);
    const name = label(r.name, 64);
    if (!symbol || !name) {
      console.warn(`[v22-markets] entry ${i}: symbol (1-16 chars) and name (1-64 chars) are required; skipped`);
      return;
    }
    const slab = keys.slab as string;
    if (out[slab]) {
      console.warn(`[v22-markets] entry ${i}: duplicate slab ${slab}; skipped`);
      return;
    }
    out[slab] = {
      symbol,
      name,
      mainnet_ca: keys.mainnet_ca as string,
      dex_pool_address: keys.dex_pool_address as string,
      lp_portfolio_address: keys.lp_portfolio_address as string,
    };
  });
  return out;
}

/** The env-configured v2.2 markets: `{}` unless the v2.2 flag is on and the build is not mainnet. */
export function v22MarketMetaFromEnv(): Record<string, V22MarketMeta> {
  if (!isDevnetV22Enabled()) return {};
  if (process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() === "mainnet") return {};
  return parseV22MarketMeta(process.env.NEXT_PUBLIC_V22_MARKETS_JSON);
}
