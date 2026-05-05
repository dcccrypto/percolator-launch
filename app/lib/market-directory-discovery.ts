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

async function getOwnedAddresses(
  connection: Connection,
  programId: PublicKey,
  addresses: PublicKey[],
): Promise<PublicKey[]> {
  const owned: PublicKey[] = [];
  const batchSize = 100;

  for (let offset = 0; offset < addresses.length; offset += batchSize) {
    const batch = addresses.slice(offset, offset + batchSize);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (let i = 0; i < batch.length; i++) {
      const info = infos[i];
      if (info?.owner.equals(programId)) {
        owned.push(batch[i]);
      }
    }
  }

  return owned;
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

  const ownedAddresses = await getOwnedAddresses(connection, programId, addresses);
  if (ownedAddresses.length === 0) return [];

  return getMarketsByAddress(connection, programId, ownedAddresses, onChainOptions);
}
