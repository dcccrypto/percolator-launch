import { Connection, PublicKey } from "@solana/web3.js";
import {
  getMarketsByAddress,
  type DiscoveredMarket,
  type GetMarketsByAddressOptions,
} from "@percolatorct/sdk";

interface ApiMarketEntry {
  slab_address?: unknown;
  program_id?: unknown;
}

interface ApiMarketsResponse {
  markets?: ApiMarketEntry[];
}

interface DirectoryDiscoveryOptions {
  timeoutMs?: number;
  onChainOptions?: GetMarketsByAddressOptions;
}

function dedupePublicKeys(addresses: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const unique: PublicKey[] = [];
  for (const address of addresses) {
    const key = address.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

type AccountInfos = Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>;
type AccountInfoEntry = AccountInfos[number];

/**
 * The program-owned subset of `addresses`, plus every account read on the way (by base58), so the
 * caller can parse the same bytes instead of fetching each account a second time.
 */
async function getOwnedAddresses(
  connection: Connection,
  programId: PublicKey,
  addresses: PublicKey[],
): Promise<{ owned: PublicKey[]; infos: Map<string, AccountInfoEntry> }> {
  const owned: PublicKey[] = [];
  const infos = new Map<string, AccountInfoEntry>();
  const batchSize = 100;
  for (let offset = 0; offset < addresses.length; offset += batchSize) {
    const batch = addresses.slice(offset, offset + batchSize);
    const batchInfos = await connection.getMultipleAccountsInfo(batch);
    for (let i = 0; i < batch.length; i++) {
      const info = batchInfos[i];
      infos.set(batch[i].toBase58(), info ?? null);
      if (info?.owner.equals(programId)) {
        owned.push(batch[i]);
      }
    }
  }

  return { owned, infos };
}

/**
 * A Connection for getMarketsByAddress that answers `getMultipleAccountsInfo` from the reads the
 * ownership pass just made. Without it every listed market was fetched twice per discovery, the two
 * identical getMultipleAccounts batches ~1 s apart (measured on /markets, 2026-10-14). Any key that
 * was not read falls through to the real connection; nothing else on the Connection is used there.
 */
function connectionServingReads(connection: Connection, infos: Map<string, AccountInfoEntry>): Connection {
  const getMultipleAccountsInfo: Connection["getMultipleAccountsInfo"] = async (keys, commitmentOrConfig) => {
    if (keys.every((k) => infos.has(k.toBase58()))) return keys.map((k) => infos.get(k.toBase58()) ?? null);
    return connection.getMultipleAccountsInfo(keys, commitmentOrConfig);
  };
  return new Proxy(connection, {
    get(target, prop, receiver) {
      if (prop === "getMultipleAccountsInfo") return getMultipleAccountsInfo;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export async function discoverMarketsViaProgramDirectory(
  connection: Connection,
  programId: PublicKey,
  apiBaseUrl: string,
  options: DirectoryDiscoveryOptions = {},
): Promise<DiscoveredMarket[]> {
  const { timeoutMs = 8_000, onChainOptions } = options;
  const programIdString = programId.toBase58();
  const base = apiBaseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/markets`);
  url.searchParams.set("program_id", programIdString);
  url.searchParams.set("limit", "500");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Market directory returned ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as ApiMarketsResponse;
  if (!Array.isArray(body.markets) || body.markets.length === 0) return [];

  const addresses = dedupePublicKeys(
    body.markets.flatMap((entry) => {
      if (entry.program_id && entry.program_id !== programIdString) return [];
      if (typeof entry.slab_address !== "string") return [];
      try {
        return [new PublicKey(entry.slab_address)];
      } catch {
        return [];
      }
    }),
  );
  if (addresses.length === 0) return [];

  const { owned: ownedAddresses, infos } = await getOwnedAddresses(connection, programId, addresses);
  if (ownedAddresses.length === 0) return [];

  return getMarketsByAddress(connectionServingReads(connection, infos), programId, ownedAddresses, onChainOptions);
}
