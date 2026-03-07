import { NextRequest, NextResponse } from "next/server";

const PYTHNET_RPC =
  process.env.PYTHNET_RPC_URL || "https://pythnet.rpcpool.com";
const ORACLE_BRIDGE_URL =
  process.env.ORACLE_BRIDGE_URL || "http://127.0.0.1:18802";

/**
 * Well-known Pyth publisher public keys → display names.
 * Source: https://pyth.network/publishers (updated periodically).
 */
const KNOWN_PYTH_PUBLISHERS: Record<string, string> = {
  "BXzwCWKsMpAW2MxWTWPaJu4fByYWkBFGBmLz4QxGUkwi": "Jump Trading",
  "GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU": "Wintermute",
  "4X98LsiCByoQPsCi3i9T4C5U2sT3C7JJcBRixYNxH3ep": "LMAX",
  "89ijemGCPC9GUGjVA1K7GqBDjEwajmimgu4n55YHCmMX": "Cboe",
  "5HYfnjBJPJKxqsT8J1rVJLjY8ud7Wn4K1k3JNwSJnFeJ": "Jane Street",
  "FVYnLcNpPkDfHMJB2kWfT5jSGqNgPDN2vPaFheFmwKJe": "CMS",
  "GKNcUmNacSJo4S2Kq3DuYRYRGw3sNUfJ4tyqd198t6vQ": "Two Sigma",
  "HNRSheUqK53dBGE5JnqgjXPGLhJFeBPz2dYR28LS5JiR": "DRW Cumberland",
  "6jprZFdLP5MYw3owfV8c6yg3CSL8kcVqBvPSR5JCERXM": "Virtu Financial",
  "89k6VPy4yCBY2qdT9rgvPEgPthmqG2p6NnmYqYRjFXDi": "GBV Capital",
  "4RVFNKH15CxFSYdoNBJJGggjszuTKmpFs4PGwuXSNaK7": "Raydium",
};

/** Max age for cached publisher data (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  data: PublishersResponse;
  timestamp: number;
}
const cache = new Map<string, CacheEntry>();

interface PublisherInfo {
  key: string;
  name: string;
  status: "active" | "degraded" | "offline";
}

interface PublishersResponse {
  mode: string;
  publisherCount: number | null;
  publisherTotal: number | null;
  publishers: PublisherInfo[];
}

/**
 * GET /api/oracle/publishers
 *
 * Dynamically fetch oracle publisher data for a given mode.
 *
 * Query params:
 *   mode=pyth-pinned&feedId=<hex>   — reads Pythnet on-chain account
 *   mode=hyperp                     — queries oracle bridge
 *   mode=admin&authority=<base58>   — returns single authority
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");
  const feedId = searchParams.get("feedId");
  const authority = searchParams.get("authority");

  if (!mode) {
    return NextResponse.json({ error: "Missing mode parameter" }, { status: 400 });
  }

  // Check cache
  const cacheKey = `${mode}:${feedId || authority || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cached.data, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }

  try {
    let result: PublishersResponse;

    switch (mode) {
      case "pyth-pinned":
        if (!feedId) {
          return NextResponse.json(
            { error: "Missing feedId for pyth-pinned mode" },
            { status: 400 },
          );
        }
        result = await fetchPythPublishers(feedId);
        break;

      case "hyperp":
        result = await fetchHyperpPublishers();
        break;

      case "admin":
        result = getAdminPublishers(authority);
        break;

      default:
        return NextResponse.json({ error: `Unknown mode: ${mode}` }, { status: 400 });
    }

    // Update cache
    cache.set(cacheKey, { data: result, timestamp: Date.now() });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (err) {
    console.error("[oracle/publishers] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch publisher data" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Pyth: Read on-chain Pythnet price account for publisher data
// ---------------------------------------------------------------------------

/**
 * Pyth price account binary layout (v2):
 *   offset  0: magic       (u32) = 0xa1b2c3d4
 *   offset  4: version     (u32)
 *   offset  8: type        (u32) = 3 (price)
 *   offset 12: size        (u32)
 *   offset 16: price_type  (u32)
 *   offset 20: exponent    (i32)
 *   offset 24: num         (u32) — number of registered publisher components
 *   offset 28: num_qt      (u32)
 *   ...
 *   offset 208+: price components, each 96 bytes:
 *     +0:  publisher pubkey (32 bytes)
 *     +32: aggregate price_info (32 bytes): price(8)+conf(8)+status(4)+corp_act(4)+pub_slot(8)
 *     +64: latest price_info   (32 bytes): price(8)+conf(8)+status(4)+corp_act(4)+pub_slot(8)
 */
const PYTH_MAGIC = 0xa1b2c3d4;
const COMPONENT_OFFSET = 208;
const COMPONENT_SIZE = 96;

async function fetchPythPublishers(feedIdHex: string): Promise<PublishersResponse> {
  const feedBytes = hexToBytes(feedIdHex);
  const accountAddress = bytesToBase58(feedBytes);

  const resp = await fetch(PYTHNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [accountAddress, { encoding: "base64", commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(`Pythnet RPC error: ${resp.status}`);
  }

  const json = await resp.json();

  if (!json.result?.value?.data?.[0]) {
    // Feed not found on Pythnet — return empty response
    return {
      mode: "pyth-pinned",
      publisherCount: 0,
      publisherTotal: 0,
      publishers: [],
    };
  }

  const data = Buffer.from(json.result.value.data[0], "base64");

  const magic = data.readUInt32LE(0);
  if (magic !== PYTH_MAGIC) {
    throw new Error(`Invalid Pyth magic: 0x${magic.toString(16)}`);
  }

  const numComponents = data.readUInt32LE(24);
  const publishers: PublisherInfo[] = [];
  let activeCount = 0;

  for (let i = 0; i < numComponents; i++) {
    const base = COMPONENT_OFFSET + i * COMPONENT_SIZE;
    if (base + COMPONENT_SIZE > data.length) break;

    // Publisher public key (32 bytes at base+0)
    const pubKeyBytes = new Uint8Array(data.subarray(base, base + 32));
    const pubKeyB58 = bytesToBase58(pubKeyBytes);

    // Latest price_info.status at base+64+16 (u32, 1 = Trading)
    const latestStatus = data.readUInt32LE(base + 64 + 16);
    const isActive = latestStatus === 1;
    if (isActive) activeCount++;

    const name =
      KNOWN_PYTH_PUBLISHERS[pubKeyB58] ||
      `${pubKeyB58.slice(0, 6)}…${pubKeyB58.slice(-4)}`;

    publishers.push({
      key: pubKeyB58,
      name,
      status: isActive ? "active" : "offline",
    });
  }

  // Sort: active publishers first, then by name
  publishers.sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (a.status !== "active" && b.status === "active") return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    mode: "pyth-pinned",
    publisherCount: activeCount,
    publisherTotal: numComponents,
    publishers: publishers.slice(0, 15), // Limit for UI
  };
}

// ---------------------------------------------------------------------------
// HyperP: Query oracle bridge for DEX price sources
// ---------------------------------------------------------------------------

async function fetchHyperpPublishers(): Promise<PublishersResponse> {
  try {
    const resp = await fetch(`${ORACLE_BRIDGE_URL}/oracle/markets`, {
      signal: AbortSignal.timeout(5000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const markets = Array.isArray(data) ? data : data.markets || [];
      const sources = markets.map(
        (m: { address?: string; market?: string; symbol?: string; name?: string }) => ({
          key: m.address || m.market || "unknown",
          name: m.symbol || m.name || "DEX Source",
          status: "active" as const,
        }),
      );

      return {
        mode: "hyperp",
        publisherCount: sources.length,
        publisherTotal: sources.length,
        publishers: sources.slice(0, 10),
      };
    }
  } catch {
    // Oracle bridge not available
  }

  // HyperP uses on-chain DEX liquidity — no traditional publishers.
  // Return null (not 0) so the UI knows to suppress "0 publishers" text.
  return {
    mode: "hyperp",
    publisherCount: null,
    publisherTotal: null,
    publishers: [],
  };
}

// ---------------------------------------------------------------------------
// Admin: Single oracle authority
// ---------------------------------------------------------------------------

function getAdminPublishers(authority: string | null): PublishersResponse {
  if (!authority || authority === "11111111111111111111111111111111") {
    return {
      mode: "admin",
      publisherCount: 0,
      publisherTotal: 0,
      publishers: [],
    };
  }

  return {
    mode: "admin",
    publisherCount: 1,
    publisherTotal: 1,
    publishers: [
      {
        key: authority,
        name: `Authority ${authority.slice(0, 4)}…${authority.slice(-4)}`,
        status: "active",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers: hex ↔ bytes ↔ base58
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bytesToBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }
  let result = "";
  while (num > 0n) {
    const [q, r] = [num / 58n, num % 58n];
    result = BASE58_ALPHABET[Number(r)] + result;
    num = q;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result || "1";
}
