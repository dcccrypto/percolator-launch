/**
 * Where the market endpoints get their bytes.
 *
 * One market: `getAccountInfoAndContext` (the slot comes from the RPC context of that very read).
 *
 * The list: discovery is ONE `getProgramAccounts` per wrapper program with a zero-length data slice (pubkeys only) and the
 * wrapper magic + MARKET kind filters, so portfolios (10 KB each) are never downloaded; the pubkey list is cached in
 * process for DISCOVERY_TTL_MS. Each request then reads the cached keys with `getMultipleAccountsInfoAndContext` (100 per
 * call). Chosen over the SDK's `discoverMarkets` (it downloads and parses every wrapper account, v12 tiers included) and
 * over the keeper registry (lib/playground-registered-markets.ts is a Vercel Blob, needs a token, and only knows wizard
 * launches). Cost: 1 gPA per 15 s per instance + 1 batched read per request.
 */
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "../errors";
import { rpc, wrapperPrograms, type ReadConnection } from "./common";
import { isKnownProgram } from "@/lib/programAllowlist";

export const DISCOVERY_TTL_MS = 15_000;
const WRAPPER_MAGIC_BYTES = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]); // "PERCV16\0" little-endian
const KIND_MARKET = Buffer.from([1]);

export interface RawMarket {
  market: PublicKey;
  programId: PublicKey;
  raw: Uint8Array;
  slot: number;
}

export async function loadMarket(connection: ReadConnection, meta: { rpcCalls: number }, market: PublicKey): Promise<RawMarket> {
  const res = await rpc(meta, () => connection.getAccountInfoAndContext(market, "confirmed"));
  if (!res.value) throw new ApiError("market_not_found");
  // An address that is not a Percolator market (a wallet, a token account, a program) is simply not a market here: market_not_found.
  if (!isKnownProgram(res.value.owner)) throw new ApiError("market_not_found", "no Percolator market at this address (the account is not owned by a Percolator wrapper)");
  return { market, programId: res.value.owner, raw: new Uint8Array(res.value.data), slot: res.context.slot };
}

interface Listed {
  market: PublicKey;
  programId: PublicKey;
}
let cache: { at: number; list: Listed[] } | null = null;
let inflight: Promise<Listed[]> | null = null;

/** Test seam. */
export function __resetDiscoveryCacheForTest(): void {
  cache = null;
  inflight = null;
}

async function discover(connection: ReadConnection, meta: { rpcCalls: number }): Promise<Listed[]> {
  const out: Listed[] = [];
  for (const programId of wrapperPrograms()) {
    const res = await rpc(meta, () =>
      connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { memcmp: { offset: 0, bytes: WRAPPER_MAGIC_BYTES.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: 10, bytes: KIND_MARKET.toString("base64"), encoding: "base64" } },
        ],
      }),
    );
    for (const r of res) out.push({ market: r.pubkey, programId });
  }
  return out;
}

export async function discoverMarketList(connection: ReadConnection, meta: { rpcCalls: number }, now: number = Date.now()): Promise<Listed[]> {
  if (cache && now - cache.at < DISCOVERY_TTL_MS) return cache.list;
  if (!inflight) {
    inflight = discover(connection, meta)
      .then((list) => {
        cache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** All discovered markets' bytes, 100 accounts per call. `slot` is the lowest context slot of the calls. */
export async function loadAllMarkets(connection: ReadConnection, meta: { rpcCalls: number }): Promise<{ markets: RawMarket[]; slot: number }> {
  const list = await discoverMarketList(connection, meta);
  const markets: RawMarket[] = [];
  let slot = Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await rpc(meta, () => connection.getMultipleAccountsInfoAndContext(chunk.map((c) => c.market), "confirmed"));
    slot = Math.min(slot, res.context.slot);
    res.value.forEach((info, k) => {
      if (info && info.owner.equals(chunk[k].programId)) markets.push({ market: chunk[k].market, programId: chunk[k].programId, raw: new Uint8Array(info.data), slot: res.context.slot });
    });
  }
  if (!Number.isFinite(slot)) {
    // No markets: still stamp a real slot.
    const s = await rpc(meta, () => connection.getSlot("confirmed"));
    slot = s;
  }
  return { markets, slot };
}

/** The given markets in one read (the stream's tick). Entries are null for a missing account or one not owned by an allowlisted wrapper. */
export async function loadMarketsByKey(connection: ReadConnection, meta: { rpcCalls: number }, keys: PublicKey[]): Promise<{ slot: number; markets: Array<RawMarket | null> }> {
  const res = await rpc(meta, () => connection.getMultipleAccountsInfoAndContext(keys, "confirmed"));
  return {
    slot: res.context.slot,
    markets: res.value.map((info, i) =>
      info && isKnownProgram(info.owner) ? { market: keys[i], programId: info.owner, raw: new Uint8Array(info.data), slot: res.context.slot } : null,
    ),
  };
}
