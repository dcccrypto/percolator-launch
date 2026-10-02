/**
 * Authoritative DEX-pool classification by the pool account's MAINNET OWNER PROGRAM.
 *
 * DexScreener reports `dexId: "meteora"` for both Meteora DLMM and Meteora DAMM v1
 * pools (and "raydium" for CLMM and CPMM). The keeper parses a pool with the byte
 * layout its dexType names, so a DAMM pool labelled "meteora-dlmm" is unpriceable:
 * E2E B21 (2026-09-30) — WIF's top DexScreener pool `5rxahS44…` is DAMM v1 (owner
 * `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`), keeper-register 400'd it, and the
 * wizard still said "launched". Every surface that offers or registers a pool
 * (keeper-register, /api/oracle/resolve, /api/dex/classify-pools -> useDexPoolSearch)
 * classifies through this one module. Pure owner->type mapping is client-safe; the
 * RPC helper is used by server routes only.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { parseDexPool } from "@percolatorct/sdk";
import type { KeeperDexType } from "@/lib/dex-type";
import { USD_PRICEABLE_QUOTE_MINTS } from "@/lib/dex-constants";

/** Mainnet DEX program -> keeper dexType (verified against the curated playground pools). */
export const DEX_PROGRAM_TO_TYPE: Readonly<Record<string, KeeperDexType>> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm", // Raydium Concentrated Liquidity
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm", // Meteora DLMM
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap", // pump.fun AMM (PumpSwap)
};

/** Meteora DAMM v1 — reported as "meteora" by DexScreener, NOT priceable by the keeper. */
export const METEORA_DAMM_V1_PROGRAM = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";

/** Keeper types the wizard may OFFER for a new market (Raydium CLMM is withheld, see dex-constants). */
export const OFFERABLE_DEX_TYPES: readonly KeeperDexType[] = ["meteora-dlmm", "pumpswap"];

/**
 * "non-usd-quote": a PumpSwap / Meteora DLMM pool whose QUOTE mint is neither WSOL nor a USD
 * stable. The keeper publishes the pool's price in quote-token units and only converts WSOL, so
 * such a pool would be priced as USD in the wrong unit (2026-10-02 incident: SI quoted in MM,
 * ratio ~13.7 pushed as $13.7 against a real ~$0.03). It is never offered or registered.
 */
export type PoolClass = KeeperDexType | "unsupported" | "missing" | "non-usd-quote";

export interface PoolClassification {
  cls: PoolClass;
  /** Set when `cls` is "non-usd-quote": the offending quote mint (base58). */
  quoteMint?: string;
}

/**
 * Classify one pool account from its owner + bytes. Pure. For PumpSwap / Meteora DLMM the quote
 * mint is parsed with the SDK's own parser (the one the keeper prices with), so this check
 * cannot drift from the keeper's `quoteIsNotUsdOrWsol`. A pool that does not parse is
 * "unsupported" - never waved through. Raydium CLMM keeps its own refusal (dex-constants).
 */
export function classifyPoolAccount(poolAddress: PublicKey, owner: string, data: Uint8Array): PoolClassification {
  const type = classifyOwner(owner);
  if (type === "unsupported") return { cls: "unsupported" };
  if (type === "raydium-clmm") return { cls: type };
  try {
    const quote = parseDexPool(type, poolAddress, data).quoteMint.toBase58();
    return USD_PRICEABLE_QUOTE_MINTS.has(quote) ? { cls: type } : { cls: "non-usd-quote", quoteMint: quote };
  } catch {
    return { cls: "unsupported" };
  }
}

export function classifyOwner(owner: string): KeeperDexType | "unsupported" {
  return DEX_PROGRAM_TO_TYPE[owner] ?? "unsupported";
}

export function isOfferable(c: PoolClass | undefined | null): c is KeeperDexType {
  return !!c && (OFFERABLE_DEX_TYPES as readonly string[]).includes(c);
}

/** Human label for a keeper dexType. */
export function dexTypeLabel(t: KeeperDexType): string {
  return t === "meteora-dlmm" ? "Meteora DLMM" : t === "pumpswap" ? "PumpSwap" : "Raydium CLMM";
}

/** Max pools per classification call (one getMultipleAccountsInfo). */
export const MAX_CLASSIFY_POOLS = 20;

export const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

/**
 * Classify pools by their mainnet owner in ONE getMultipleAccountsInfo call.
 * Returns null when the RPC could not be reached (callers must treat that as
 * "unverified" and refuse, never fall back to the DexScreener string).
 */
export async function classifyPoolsByOwner(
  addresses: string[],
  conn: Pick<Connection, "getMultipleAccountsInfo"> = new Connection(MAINNET_RPC_URL, "confirmed"),
  timeoutMs = 8_000,
): Promise<Record<string, PoolClass> | null> {
  const keys: PublicKey[] = [];
  const out: Record<string, PoolClass> = {};
  for (const a of addresses.slice(0, MAX_CLASSIFY_POOLS)) {
    try {
      keys.push(new PublicKey(a));
    } catch {
      out[a] = "missing";
    }
  }
  if (keys.length === 0) return out;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const infos = await Promise.race([
      conn.getMultipleAccountsInfo(keys),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("mainnet RPC timeout")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    keys.forEach((k, i) => {
      const info = infos[i];
      out[k.toBase58()] = info ? classifyPoolAccount(k, info.owner.toBase58(), new Uint8Array(info.data)).cls : "missing";
    });
    return out;
  } catch {
    return null;
  }
}
