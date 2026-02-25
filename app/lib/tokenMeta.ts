import { Connection, PublicKey } from "@solana/web3.js";

export interface TokenMeta {
  decimals: number;
  symbol: string;
  name: string;
}

const cache = new Map<string, TokenMeta>();

/** Strip unsafe characters from token metadata strings */
function sanitizeTokenString(input: string, maxLen: number): string {
  // M6: Allow alphanumeric, spaces, dashes, dots, underscores, parentheses, $, #, &, and emoji
  // Use \p{Emoji} to preserve Unicode emoji properly
  return input.replace(/[^a-zA-Z0-9 \-._()$#&\p{Emoji}]/gu, "").trim().slice(0, maxLen);
}

/** Well-known tokens that don't need a Jupiter lookup. */
const KNOWN_TOKENS: Record<string, { symbol: string; name: string }> = {
  A16Gd8AfaPnG6rohE6iPFDf6mr9gk519d6aMUJAperc: { symbol: "PERC", name: "Percolator" },
};

/** Format a truncated mint address for display (e.g. "A16G...perc") */
function shortenMint(mint: string): string {
  if (mint.length <= 8) return mint;
  return mint.slice(0, 4) + "..." + mint.slice(-4);
}

/**
 * Extract the Helius RPC URL from a Connection object.
 * Returns the endpoint URL which contains the API key.
 */
function getHeliusRpcUrl(connection: Connection): string | null {
  try {
    const endpoint = connection.rpcEndpoint;
    if (endpoint.includes("helius-rpc.com")) {
      return endpoint;
    }
  } catch {
    // Not a Helius connection
  }
  return null;
}

/**
 * Fetch token metadata via Helius DAS API (getAsset).
 * Uses the same RPC URL we already have — no extra API key needed.
 */
async function fetchViaHeliusDAS(
  rpcUrl: string,
  mintAddress: string
): Promise<{ symbol: string; name: string; decimals: number } | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `das-${mintAddress}`,
        method: "getAsset",
        params: { id: mintAddress, options: { showFungible: true } },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const json = await res.json();
    const result = json?.result;
    if (!result) return null;

    // DAS returns content.metadata for NFTs and token_info for fungibles
    const metadata = result.content?.metadata;
    const tokenInfo = result.token_info;

    const symbol = metadata?.symbol || tokenInfo?.symbol || "";
    const name = metadata?.name || "";
    const decimals = tokenInfo?.decimals ?? 6;

    if (symbol && name) {
      return { symbol, name, decimals };
    }
    // Partial match is still useful
    if (symbol || name) {
      return { symbol: symbol || shortenMint(mintAddress), name: name || shortenMint(mintAddress), decimals };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch token metadata: decimals from on-chain mint, symbol/name from multiple sources.
 *
 * Resolution order:
 * 1. Well-known tokens (hardcoded)
 * 2. Helius DAS API (getAsset) — uses existing RPC connection, no extra key
 * 3. On-chain Metaplex metadata (manual buffer parsing)
 * 4. Truncated mint address (fallback — never shows "Unknown Token")
 *
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

  // 1. Check well-known tokens first
  const known = KNOWN_TOKENS[key];
  let symbol = known?.symbol ?? "";
  let name = known?.name ?? "";
  let resolved = !!known;

  // 2. Try Helius DAS API (preferred — comprehensive, uses existing RPC key)
  if (!resolved) {
    const heliusUrl = getHeliusRpcUrl(connection);
    if (heliusUrl) {
      const dasMeta = await fetchViaHeliusDAS(heliusUrl, key);
      if (dasMeta) {
        symbol = dasMeta.symbol;
        name = dasMeta.name;
        decimals = dasMeta.decimals;
        resolved = true;
      }
    }
  }

  // 3. Fallback: on-chain Metaplex metadata (manual buffer parsing)
  if (!resolved) {
    try {
      const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        TOKEN_METADATA_PROGRAM_ID
      );
      const metadataAccount = await connection.getAccountInfo(metadataPDA);
      if (metadataAccount?.data) {
        const data = metadataAccount.data;
        const MAX_NAME_LEN = 256;
        const MAX_SYM_LEN = 32;

        if (data.length < 69) {
          throw new Error("Buffer too small for name length");
        }

        const nameLen = data.readUInt32LE(65);
        if (nameLen > MAX_NAME_LEN || data.length < 69 + nameLen) {
          throw new Error("Invalid name length or buffer too small");
        }

        const nameRaw = data.slice(69, 69 + nameLen).toString("utf8").replace(/\0/g, "").trim();
        const symOffset = 69 + nameLen;

        if (data.length < symOffset + 4) {
          throw new Error("Buffer too small for symbol length");
        }

        const symLen = data.readUInt32LE(symOffset);
        if (symLen > MAX_SYM_LEN || data.length < symOffset + 4 + symLen) {
          throw new Error("Invalid symbol length or buffer too small");
        }

        const symRaw = data.slice(symOffset + 4, symOffset + 4 + symLen).toString("utf8").replace(/\0/g, "").trim();
        if (nameRaw && symRaw) {
          symbol = symRaw;
          name = nameRaw;
          resolved = true;
        }
      }
    } catch {
      // Metaplex lookup failed (PDA derivation or RPC) — use fallback
    }
  }

  // 4. Fallback — show truncated mint address instead of "Unknown Token"
  if (!resolved) {
    symbol = shortenMint(key);
    name = shortenMint(key);
  }

  // R2-S14: Sanitize metadata — strip unsafe characters, limit length
  symbol = sanitizeTokenString(symbol, 16);
  name = sanitizeTokenString(name, 32);

  const meta: TokenMeta = { decimals, symbol, name };
  cache.set(key, meta);
  return meta;
}
