import { Connection, PublicKey } from "@solana/web3.js";

export interface TokenMeta {
  decimals: number;
  symbol: string;
  name: string;
}

const cache = new Map<string, TokenMeta>();

/** Well-known tokens that don't need a Jupiter lookup. */
const KNOWN_TOKENS: Record<string, { symbol: string; name: string }> = {
  A16Gd8AfaPnG6rohE6iPFDf6mr9gk519d6aMUJAperc: { symbol: "PERC", name: "Percolator" },
};

/**
 * Fetch token metadata: decimals from on-chain mint, symbol/name from Jupiter.
 * Results are cached in-memory.
 */
export async function fetchTokenMeta(
  connection: Connection,
  mint: PublicKey,
): Promise<TokenMeta> {
  const key = mint.toBase58();
  const cached = cache.get(key);
  if (cached) return cached;

  // Get decimals from on-chain mint account
  const mintInfo = await connection.getParsedAccountInfo(mint);
  let decimals = 6;
  if (mintInfo.value?.data && "parsed" in mintInfo.value.data) {
    decimals = mintInfo.value.data.parsed.info.decimals ?? 6;
  }

  // Check well-known tokens first, then try Jupiter
  const known = KNOWN_TOKENS[key];
  let symbol = known?.symbol ?? key.slice(0, 4) + "...";
  let name = known?.name ?? "Unknown Token";
  if (!known) {
    try {
      const resp = await fetch(`https://tokens.jup.ag/token/${key}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const json = (await resp.json()) as any;
        if (json.symbol) symbol = json.symbol;
        if (json.name) name = json.name;
      }
    } catch {
      // Use defaults
    }
  }

  const meta: TokenMeta = { decimals, symbol, name };
  cache.set(key, meta);
  return meta;
}
