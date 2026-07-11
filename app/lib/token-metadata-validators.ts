/**
 * Token metadata validators for external API responses.
 * DEXSCREENER-001: Validates and sanitizes token data from DexScreener and Jupiter APIs.
 */

/** Token metadata interface */
export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logoUrl?: string;
}

/** Constraints for token metadata fields */
const CONSTRAINTS = {
  MAX_NAME_LEN: 255,
  MAX_SYMBOL_LEN: 20,
  MAX_LOGO_URL_LEN: 500,
  MAX_DECIMALS: 18,
  MIN_DECIMALS: 0,
  ALLOWED_URL_PROTOCOLS: ['https', 'ipfs'], // ipfs:// for IPFS gateways
};

/**
 * Validates a URL to ensure it uses allowed protocols.
 * DEXSCREENER-001: Prevents javascript:, data:, and other malicious protocols.
 */
function validateUrl(url: string, allowedProtocols: readonly string[]): string | undefined {
  if (!url || typeof url !== 'string') return undefined;

  try {
    const parsed = new URL(url);
    // URL.protocol is the scheme plus a trailing colon ("https:"), never
    // "https://" — the old `.replace('://','')` was a no-op that left the
    // colon on, so `['https','ipfs'].includes('https:')` was ALWAYS false
    // and this validator silently rejected every URL (incl. legit https),
    // dropping all DexScreener/Jupiter logos. Strip the trailing colon.
    const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();

    if (!allowedProtocols.includes(protocol)) {
      console.warn(
        `[validateUrl] Rejected logo URL with disallowed protocol: ${protocol}`,
      );
      return undefined;
    }

    // Additional check: URLs should not be unreasonably long
    if (url.length > CONSTRAINTS.MAX_LOGO_URL_LEN) {
      console.warn('[validateUrl] Logo URL exceeded max length');
      return undefined;
    }

    return url;
  } catch {
    // Invalid URL format
    console.warn('[validateUrl] Invalid URL format for logo');
    return undefined;
  }
}

/**
 * Sanitize an attacker-suppliable logo URL for storage/display.
 *
 * Same policy as the DexScreener/Jupiter validator above (https/ipfs only,
 * ≤500 chars, rejects javascript:/data:/other schemes) — exported so the
 * permissionless market-creation path (POST /api/markets, whose `logo_url`
 * comes straight from the request body) applies the identical allowlist that
 * external-API metadata already gets, instead of storing the raw value.
 *
 * Returns the URL when it passes, or `null` when absent/invalid — the caller
 * stores `null` (the fallback avatar renders), never an untrusted string.
 * A rejected URL is dropped, not an error: market creation must not fail just
 * because a logo is malformed.
 *
 * @param url Raw logo URL (or null/undefined) from an untrusted source
 */
export function sanitizeLogoUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  return validateUrl(url, CONSTRAINTS.ALLOWED_URL_PROTOCOLS) ?? null;
}

/**
 * Validates and sanitizes token metadata from external APIs.
 * DEXSCREENER-001: Ensures all fields are within safe bounds and correct types.
 *
 * @param data Raw token metadata from DexScreener/Jupiter
 * @returns Validated TokenMetadata with safe defaults
 */
export function validateTokenMetadata(data: unknown): TokenMetadata {
  // Type guard: ensure data is an object
  if (!data || typeof data !== 'object') {
    return {
      name: 'Unknown',
      symbol: '???',
      decimals: 6,
    };
  }

  const raw = data as Record<string, unknown>;

  // Extract and validate name
  const rawName = String(raw.name ?? '').trim();
  const rawSymbol = String(raw.symbol ?? '').trim();

  const name =
    rawName.length > 0 && rawName.length <= CONSTRAINTS.MAX_NAME_LEN
      ? rawName
      : rawSymbol.length > 0
        ? rawSymbol
        : 'Unknown';

  // Extract and validate symbol
  const symbol =
    rawSymbol.length > 0 && rawSymbol.length <= CONSTRAINTS.MAX_SYMBOL_LEN
      ? rawSymbol
      : '???';

  // Extract and validate decimals
  let decimals = 6; // Safe default (matches Solana Token standard)
  const rawDecimals = raw.decimals;
  if (typeof rawDecimals === 'number') {
    if (
      Number.isInteger(rawDecimals) &&
      rawDecimals >= CONSTRAINTS.MIN_DECIMALS &&
      rawDecimals <= CONSTRAINTS.MAX_DECIMALS
    ) {
      decimals = rawDecimals;
    }
  }

  // Extract and validate logo URL
  const rawLogoUrl = raw.logoUrl ?? raw.logo_url;
  const logoUrl =
    typeof rawLogoUrl === 'string'
      ? validateUrl(rawLogoUrl, CONSTRAINTS.ALLOWED_URL_PROTOCOLS)
      : undefined;

  return {
    name,
    symbol,
    decimals,
    ...(logoUrl && { logoUrl }),
  };
}

/**
 * Validates token metadata from DexScreener API response.
 * Extracts best liquidity pair and validates result.
 */
export function validateDexScreenerResponse(
  pairs: unknown,
): TokenMetadata | null {
  // Type guard: ensure pairs is an array
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  // Extract objects with required fields
  const candidates = pairs.flatMap((p) => {
    if (!p || typeof p !== 'object') return [];
    const pair = p as Record<string, unknown>;

    const baseToken = pair.baseToken as Record<string, unknown> | undefined;
    const liquidity = pair.liquidity as Record<string, unknown> | undefined;

    if (!baseToken || !liquidity) return [];

    return [
      {
        data: {
          name: baseToken.name,
          symbol: baseToken.symbol,
          logoUrl: (pair.info as Record<string, unknown> | undefined)?.imageUrl,
        },
        // Use liquidity as sort key: higher = better
        liquidityUsd: (liquidity.usd as number | undefined) ?? 0,
      },
    ];
  });

  if (candidates.length === 0) return null;

  // Pick pair with highest liquidity
  candidates.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const best = candidates[0].data;

  return validateTokenMetadata({
    name: best.name,
    symbol: best.symbol,
    decimals: 6, // Default for DexScreener tokens
    logoUrl: best.logoUrl,
  });
}

/**
 * Validates token metadata from Jupiter token list response.
 * Jupiter response is array of tokens; extract and validate one.
 */
export function validateJupiterTokenResponse(
  tokens: unknown,
  targetAddress: string,
): TokenMetadata | null {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return null;
  }

  // Find token by address
  const token = tokens.find((t) => {
    if (!t || typeof t !== 'object') return false;
    const address = (t as Record<string, unknown>).address;
    return address === targetAddress;
  });

  if (!token) return null;

  return validateTokenMetadata(token);
}
