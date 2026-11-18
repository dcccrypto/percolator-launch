import { Connection, PublicKey } from "@solana/web3.js";
import { type DiscoveredMarket, type GetMarketsByAddressOptions } from "@percolatorct/sdk";
// VERSION-aware (18 + 19) with the v2.2 flag on, the installed SDK function otherwise.
import { getMarketsByAddress } from "@/lib/v22/discovery";

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

/** An address with the base58 string it was parsed from (a valid string is the canonical encoding). */
interface KeyedAddress {
  address: PublicKey;
  key: string;
}

function dedupePublicKeys(addresses: KeyedAddress[]): KeyedAddress[] {
  const seen = new Set<string>();
  const unique: KeyedAddress[] = [];
  for (const entry of addresses) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    unique.push(entry);
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
  addresses: KeyedAddress[],
): Promise<{ owned: PublicKey[]; infos: Map<string, AccountInfoEntry>; keyOf: Map<PublicKey, string> }> {
  const owned: PublicKey[] = [];
  const infos = new Map<string, AccountInfoEntry>();
  // Identity -> base58, so the serving proxy never re-encodes the keys it is handed.
  const keyOf = new Map<PublicKey, string>();
  const batchSize = 100;
  for (let offset = 0; offset < addresses.length; offset += batchSize) {
    const batch = addresses.slice(offset, offset + batchSize);
    const batchInfos = await connection.getMultipleAccountsInfo(batch.map((entry) => entry.address));
    for (let i = 0; i < batch.length; i++) {
      const info = batchInfos[i];
      const { address, key } = batch[i];
      infos.set(key, info ?? null);
      keyOf.set(address, key);
      if (info?.owner.equals(programId)) {
        owned.push(address);
      }
    }
  }

  return { owned, infos, keyOf };
}

/**
 * A Connection for getMarketsByAddress that answers `getMultipleAccountsInfo` from the reads the
 * ownership pass just made. Without it every listed market was fetched twice per discovery, the two
 * identical getMultipleAccounts batches ~1 s apart (measured on /markets, 2026-10-14). Any key that
 * was not read falls through to the real connection; nothing else on the Connection is used there.
 */
function connectionServingReads(
  connection: Connection,
  infos: Map<string, AccountInfoEntry>,
  keyOf: Map<PublicKey, string>,
): Connection {
  const getMultipleAccountsInfo: Connection["getMultipleAccountsInfo"] = async (keys, commitmentOrConfig) => {
    const served: AccountInfoEntry[] = [];
    for (const k of keys) {
      const key = keyOf.get(k) ?? k.toBase58();
      if (!infos.has(key)) return connection.getMultipleAccountsInfo(keys, commitmentOrConfig);
      served.push(infos.get(key) ?? null);
    }
    return served;
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
    body.markets.flatMap((entry): KeyedAddress[] => {
      if (entry.program_id && entry.program_id !== programIdString) return [];
      if (typeof entry.slab_address !== "string") return [];
      try {
        return [{ address: new PublicKey(entry.slab_address), key: entry.slab_address }];
      } catch {
        return [];
      }
    }),
  );
  if (addresses.length === 0) return [];

  const { owned: ownedAddresses, infos, keyOf } = await getOwnedAddresses(connection, programId, addresses);
  if (ownedAddresses.length === 0) return [];

  return getMarketsByAddress(connectionServingReads(connection, infos, keyOf), programId, ownedAddresses, onChainOptions);
}
