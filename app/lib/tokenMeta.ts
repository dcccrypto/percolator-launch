import { Connection, PublicKey } from "@solana/web3.js";

export interface TokenMeta {
  decimals: number;
  symbol: string;
  name: string;
}

const cache = new Map<string, TokenMeta>();

// Jupiter token list cache (populated lazily on first miss)
let jupiterTokenMap: Map<string, { symbol: string; name: string }> | null = null;
let jupiterFetchPromise: Promise<void> | null = null;

async function loadJupiterTokenList(): Promise<Map<string, { symbol: string; name: string }>> {
  if (jupiterTokenMap) return jupiterTokenMap;
  if (jupiterFetchPromise) {
    await jupiterFetchPromise;
    return jupiterTokenMap ?? new Map();
  }
  jupiterFetchPromise = (async () => {
    try {
      const res = await fetch("https://token.jup.ag/all", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Jupiter API ${res.status}`);
      const tokens = (await res.json()) as Array<{ address: string; symbol: string; name: string }>;
      jupiterTokenMap = new Map();
      for (const t of tokens) {
        jupiterTokenMap.set(t.address, { symbol: t.symbol, name: t.name });
      }
    } catch {
      // Jupiter unavailable — use empty map, retry next time
      jupiterTokenMap = new Map();
      // Allow retry after 60s
      setTimeout(() => { jupiterTokenMap = null; jupiterFetchPromise = null; }, 60_000);
    }
  })();
  await jupiterFetchPromise;
  jupiterFetchPromise = null;
  return jupiterTokenMap ?? new Map();
}

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

  // Check well-known tokens first
  const known = KNOWN_TOKENS[key];
  let symbol = known?.symbol ?? "";
  let name = known?.name ?? "";

  if (!known) {
    // Try on-chain Metaplex metadata (works for most SPL tokens)
    const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID
    );
    try {
      const metadataAccount = await connection.getAccountInfo(metadataPDA);
      if (metadataAccount?.data) {
        const data = metadataAccount.data;
        const MAX_NAME_LEN = 256;
        const MAX_SYM_LEN = 32;
        
        // Check minimum buffer size for name length field
        if (data.length < 69) {
          throw new Error("Buffer too small for name length");
        }
        
        const nameLen = data.readUInt32LE(65);
        if (nameLen > MAX_NAME_LEN || data.length < 69 + nameLen) {
          throw new Error("Invalid name length or buffer too small");
        }
        
        const nameRaw = data.slice(69, 69 + nameLen).toString("utf8").replace(/\0/g, "").trim();
        const symOffset = 69 + nameLen;
        
        // Check buffer size for symbol length field
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
        }
      }
    } catch {
      // Metaplex lookup failed — will try Jupiter next
    }

    // If Metaplex didn't resolve, try Jupiter token list
    if (!symbol || !name) {
      try {
        const jupTokens = await loadJupiterTokenList();
        const jupMeta = jupTokens.get(key);
        if (jupMeta) {
          symbol = symbol || jupMeta.symbol;
          name = name || jupMeta.name;
        }
      } catch {
        // Jupiter unavailable — continue to fallback
      }
    }

    // Final fallback: show truncated mint address instead of "Unknown Token"
    if (!symbol) symbol = key.slice(0, 4) + "…" + key.slice(-4);
    if (!name) name = key.slice(0, 4) + "…" + key.slice(-4);
  }

  // R2-S14: Sanitize metadata — strip unsafe characters, limit length
  symbol = sanitizeTokenString(symbol, 16);
  name = sanitizeTokenString(name, 32);

  const meta: TokenMeta = { decimals, symbol, name };
  cache.set(key, meta);
  return meta;
}
