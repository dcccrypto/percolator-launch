import { Connection, PublicKey } from "@solana/web3.js";

export interface TokenMeta {
  decimals: number;
  symbol: string;
  name: string;
}

const cache = new Map<string, TokenMeta>();

/** Max mints per Helius DAS getAssetBatch call */
const DAS_BATCH_SIZE = 100;

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
 * Batch-fetch token metadata via Helius DAS getAssetBatch.
 * Resolves up to DAS_BATCH_SIZE assets per call.
 * Returns a Map of mintAddress → { symbol, name, decimals }.
 */
async function fetchViaHeliusDASBatch(
  rpcUrl: string,
  mintAddresses: string[],
): Promise<Map<string, { symbol: string; name: string; decimals: number }>> {
  const result = new Map<string, { symbol: string; name: string; decimals: number }>();
  if (mintAddresses.length === 0) return result;

  // Split into chunks of DAS_BATCH_SIZE
  const chunks: string[][] = [];
  for (let i = 0; i < mintAddresses.length; i += DAS_BATCH_SIZE) {
    chunks.push(mintAddresses.slice(i, i + DAS_BATCH_SIZE));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "das-batch",
            method: "getAssetBatch",
            params: { ids: chunk, options: { showFungible: true } },
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) return;

        const json = await res.json();
        const assets = json?.result;
        if (!Array.isArray(assets)) return;

        for (const asset of assets) {
          if (!asset?.id) continue;
          const metadata = asset.content?.metadata;
          const tokenInfo = asset.token_info;

          const symbol = metadata?.symbol || tokenInfo?.symbol || "";
          const name = metadata?.name || "";
          const decimals = tokenInfo?.decimals ?? 6;

          if (symbol || name) {
            result.set(asset.id, {
              symbol: symbol || shortenMint(asset.id),
              name: name || shortenMint(asset.id),
              decimals,
            });
          }
        }
      } catch {
        // Batch call failed — will fall through to individual resolution
      }
    }),
  );

  return result;
}

/**
 * Batch-fetch token metadata for multiple mints efficiently.
 * Uses a single Helius DAS getAssetBatch call instead of N individual calls.
 * Falls back to individual fetchTokenMeta for non-Helius connections or failed lookups.
 *
 * Results are cached in the same in-memory cache as fetchTokenMeta.
 */
export async function fetchTokenMetaBatch(
  connection: Connection,
  mints: PublicKey[],
): Promise<Map<string, TokenMeta>> {
  const resultMap = new Map<string, TokenMeta>();
  if (mints.length === 0) return resultMap;

  // Deduplicate
  const unique = [...new Set(mints.map((m) => m.toBase58()))];

  // Return cached entries immediately; track what still needs resolution
  const uncached: string[] = [];
  for (const key of unique) {
    const cached = cache.get(key);
    if (cached) {
      resultMap.set(key, cached);
    } else {
      // Check well-known tokens
      const known = KNOWN_TOKENS[key];
      if (known) {
        const meta: TokenMeta = { decimals: 6, symbol: known.symbol, name: known.name };
        cache.set(key, meta);
        resultMap.set(key, meta);
      } else {
        uncached.push(key);
      }
    }
  }

  if (uncached.length === 0) return resultMap;

  // Try Helius DAS batch first
  const heliusUrl = getHeliusRpcUrl(connection);
  let dasResults = new Map<string, { symbol: string; name: string; decimals: number }>();
  if (heliusUrl) {
    dasResults = await fetchViaHeliusDASBatch(heliusUrl, uncached);
  }

  // Apply DAS results and track remaining unresolved
  const unresolved: string[] = [];
  for (const key of uncached) {
    const das = dasResults.get(key);
    if (das) {
      const meta: TokenMeta = {
        decimals: das.decimals,
        symbol: sanitizeTokenString(das.symbol, 16),
        name: sanitizeTokenString(das.name, 32),
      };
      cache.set(key, meta);
      resultMap.set(key, meta);
    } else {
      unresolved.push(key);
    }
  }

  // For remaining unresolved mints, batch-fetch Metaplex metadata PDAs
  if (unresolved.length > 0) {
    const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

    // Compute all PDAs
    const pdaToMint = new Map<string, string>();
    const pdaKeys: PublicKey[] = [];
    for (const key of unresolved) {
      try {
        const mint = new PublicKey(key);
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
          TOKEN_METADATA_PROGRAM_ID,
        );
        pdaToMint.set(pda.toBase58(), key);
        pdaKeys.push(pda);
      } catch {
        // Invalid key — skip
      }
    }

    // Batch-fetch all metadata accounts using getMultipleAccountsInfo
    if (pdaKeys.length > 0) {
      try {
        // getMultipleAccountsInfo supports up to 100 keys per call
        const BATCH = 100;
        const allAccounts: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
        for (let i = 0; i < pdaKeys.length; i += BATCH) {
          const slice = pdaKeys.slice(i, i + BATCH);
          const accounts = await connection.getMultipleAccountsInfo(slice);
          allAccounts.push(...accounts);
        }

        for (let i = 0; i < pdaKeys.length; i++) {
          const account = allAccounts[i];
          const mintKey = pdaToMint.get(pdaKeys[i].toBase58());
          if (!account?.data || !mintKey) continue;

          try {
            const data = account.data;
            const MAX_NAME_LEN = 256;
            const MAX_SYM_LEN = 32;

            if (data.length < 69) continue;
            const nameLen = data.readUInt32LE(65);
            if (nameLen > MAX_NAME_LEN || data.length < 69 + nameLen) continue;

            const nameRaw = data.slice(69, 69 + nameLen).toString("utf8").replace(/\0/g, "").trim();
            const symOffset = 69 + nameLen;

            if (data.length < symOffset + 4) continue;
            const symLen = data.readUInt32LE(symOffset);
            if (symLen > MAX_SYM_LEN || data.length < symOffset + 4 + symLen) continue;

            const symRaw = data.slice(symOffset + 4, symOffset + 4 + symLen).toString("utf8").replace(/\0/g, "").trim();
            if (nameRaw && symRaw) {
              const meta: TokenMeta = {
                decimals: 6, // Will be overridden below
                symbol: sanitizeTokenString(symRaw, 16),
                name: sanitizeTokenString(nameRaw, 32),
              };
              cache.set(mintKey, meta);
              resultMap.set(mintKey, meta);
            }
          } catch {
            // Parse error — skip this account
          }
        }
      } catch {
        // Batch Metaplex fetch failed — continue with fallbacks
      }
    }

    // Batch-fetch decimals for all unresolved mints via getParsedMultipleAccountsInfo
    // (covers both Metaplex-resolved and completely unresolved)
    try {
      const mintKeys = unresolved.map((k) => new PublicKey(k));
      const BATCH = 100;
      const allMintInfos: (import("@solana/web3.js").AccountInfo<import("@solana/web3.js").ParsedAccountData | Buffer> | null)[] = [];
      for (let i = 0; i < mintKeys.length; i += BATCH) {
        const slice = mintKeys.slice(i, i + BATCH);
        // Use getMultipleAccountsInfo and parse manually since getParsedMultipleAccountsInfo
        // doesn't exist on the Connection class — use getParsedAccountInfo individually or
        // use the parsed token program account approach
        const accounts = await connection.getMultipleParsedAccounts(slice);
        allMintInfos.push(...accounts.value);
      }

      for (let i = 0; i < unresolved.length; i++) {
        const mintKey = unresolved[i];
        const info = allMintInfos[i];
        if (info?.data && "parsed" in info.data) {
          const decimals = info.data.parsed?.info?.decimals ?? 6;
          const existing = resultMap.get(mintKey) || cache.get(mintKey);
          if (existing) {
            existing.decimals = decimals;
          } else {
            // Completely unresolved — use truncated address
            const meta: TokenMeta = {
              decimals,
              symbol: sanitizeTokenString(shortenMint(mintKey), 16),
              name: sanitizeTokenString(shortenMint(mintKey), 32),
            };
            cache.set(mintKey, meta);
            resultMap.set(mintKey, meta);
          }
        } else if (!resultMap.has(mintKey)) {
          // No info at all — pure fallback
          const meta: TokenMeta = {
            decimals: 6,
            symbol: sanitizeTokenString(shortenMint(mintKey), 16),
            name: sanitizeTokenString(shortenMint(mintKey), 32),
          };
          cache.set(mintKey, meta);
          resultMap.set(mintKey, meta);
        }
      }
    } catch {
      // Decimals batch fetch failed — fill remaining with defaults
      for (const key of unresolved) {
        if (!resultMap.has(key)) {
          const meta: TokenMeta = {
            decimals: 6,
            symbol: sanitizeTokenString(shortenMint(key), 16),
            name: sanitizeTokenString(shortenMint(key), 32),
          };
          cache.set(key, meta);
          resultMap.set(key, meta);
        }
      }
    }
  }

  return resultMap;
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
