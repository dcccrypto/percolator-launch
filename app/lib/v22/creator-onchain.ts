/**
 * Creator lookup that does not depend on the Supabase registry (#3637): a market with no registry row is invisible on
 * /markets and /my-markets, so the creator's own v2.2 markets are found on chain.
 *
 * Four markers:
 *  - the LP portfolio the wizard creates with the creator's wallet as owner (portfolio +116, market id +16; the LP is the one
 *    whose matcher control bit 0 is set, lib/lpPortfolio.ts). Completed launches rotate `marketauth` to the stake pool PDA, so
 *    this marks a completed creator-LP launch. Found WITHOUT downloading every trading portfolio: the owner-scoped scan returns only
 *    the 8-byte control word of each portfolio (dataSlice), and only the market id (32 bytes) of the LP ones is fetched next;
 *  - `marketauth` (config rel 0 = account +16) still equal to the wallet: an unfinished launch. Keys only (dataSlice length 0);
 *  - asset 0's `asset_admin` (oracle profile +368 of slot 0 = account +1766 on v2.2) equal to the wallet: a completed P3 (vault-LP)
 *    launch, which has no creator-owned LP (useCreateMarket `includeM2 = !params.p3`) and whose marketauth is the pool PDA.
 *    InitMarket sets it to the market's first marketauth, the creator (`asset_admin: config.marketauth`); StakeInitPool leaves it,
 *    and only UpdateAssetAuthority (tag 65, kind 0) moves it: signed by the current asset_admin, and co-signed by the new key unless
 *    it is zero. A market handed to another admin is listed for that admin, a burned one (zero) by this marker for no one. Keys only (dataSlice length 0);
 *  - the vault's `VaultLpState.junior_owner` equal to the wallet: a completed P3 launch whose admin key was burned. InitVaultLp
 *    writes it from the launching marketauth and nothing moves it. Only the market id (32 bytes at +16) is read.
 * Offsets: percolator-prog aca02ba6 `src/v16_program.rs` (HEADER_LEN 16, KIND_MARKET 1, KIND_PORTFOLIO 2, provenance market id
 * at +16, owner at +116, matcher control = matcher config +96, `WrapperConfigV16.marketauth` first field).
 *
 * Never-connected needs one more fact: was a price EVER pushed? `last_good_oracle_slot` is also written by launch-time config
 * (ConfigureAuthMark, tag 62), which can land tens to hundreds of slots after creation, so a slot-gap rule misses real cases.
 * `readNeverPushed` reads the transaction(s) AT `last_good_oracle_slot` and looks at the wrapper tags (lib/v22/never-connected.ts).
 *
 * RPC budget per lookup: 4 getProgramAccounts (tiny slices), ceil(n/100) getMultipleAccounts for market ids and for market
 * bytes, and per market that has been silent for longer than the launch wait (healthy markets cost nothing): one
 * getSignaturesForAddress and one getTransaction per transaction at that slot, at most MAX_HISTORY_LOOKUPS markets, newest
 * silence first, MAX_PARALLEL at a time. Results are cached for the session (history of a past slot never changes).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { decodePortfolioMatcherControl } from "@percolatorct/sdk";
import { ACCOUNT_KIND, LAYOUT_V22 } from "./sdk/layout";
import { activeLayout, portfolioGpaFilters } from "./layout";
import { LAUNCH_WAIT_SLOTS, NEVER_CONNECTED_FALLBACK_SLACK_SLOTS, classifyLastGoodTags } from "./never-connected";
import { parseWrapperConfigV17 } from "./sdk/slab";
import { staleResolveStatusV22 } from "./stale-resolve";
import { HEADER_KIND_OFF, KIND_VAULT_LP_STATE, VAULT_LP_STATE_ACCOUNT_LEN, VS } from "@/lib/limits/constants";

const PF_MARKET_OFF = 16;
const PF_OWNER_OFF = 116;
const KIND_OFF = 10;
const MARKETAUTH_OFF = LAYOUT_V22.headerLen; // config rel 0
const CONTROL_REL = 96; // matcher control word inside the 104-byte matcher config
const ASSET_ADMIN_REL = 368; // AssetOracleProfileV16.asset_admin inside the oracle profile (lib/v18-wire.ts readAssetAdmin)

/** A creator has few markets; this bounds a pathological wallet. Applied in marker order (LP, marketauth, asset_admin, junior_owner); `lookupCreatorMarkets` reorders only the silent ones, to pick history reads. */
export const MAX_CREATOR_SLABS = 100;
/** Markets whose history is read per lookup; the rest keep `neverPushed: null` (the fallback rule applies). */
export const MAX_HISTORY_LOOKUPS = 12;
export const MAX_PARALLEL = 4;
const SIGNATURE_PAGE = 1000;

export interface CreatorSlab {
  slab: PublicKey;
  raw: Uint8Array;
}

type Conn = Pick<Connection, "getProgramAccounts" | "getMultipleAccountsInfo" | "getSignaturesForAddress" | "getTransaction" | "getSlot">;

const bytes = (d: Uint8Array | Buffer): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array(d));

/** Distinct market ids the wallet created, from all four markers. */
export async function findCreatorSlabKeys(
  connection: Pick<Connection, "getProgramAccounts" | "getMultipleAccountsInfo">,
  programId: PublicKey,
  wallet: PublicKey,
): Promise<PublicKey[]> {
  const L = activeLayout();
  const controlOff = L.portfolio.matcherConfigOff + CONTROL_REL;
  const adminOff = L.marketGroupOff + L.marketGroupLen + L.wrapperSlot.oracleProfile + ASSET_ADMIN_REL; // asset 0
  const [owned, authored, administered, juniors] = await Promise.all([
    connection.getProgramAccounts(programId, {
      dataSlice: { offset: controlOff, length: 8 },
      filters: [...portfolioGpaFilters(), { memcmp: { offset: PF_OWNER_OFF, bytes: wallet.toBase58() } }],
    }),
    connection.getProgramAccounts(programId, {
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: KIND_OFF, bytes: bs58.encode(Uint8Array.of(ACCOUNT_KIND.Market)) } },
        { memcmp: { offset: MARKETAUTH_OFF, bytes: wallet.toBase58() } },
      ],
    }),
    connection.getProgramAccounts(programId, {
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: KIND_OFF, bytes: bs58.encode(Uint8Array.of(ACCOUNT_KIND.Market)) } },
        { memcmp: { offset: adminOff, bytes: wallet.toBase58() } },
      ],
    }),
    connection.getProgramAccounts(programId, {
      dataSlice: { offset: VS.marketGroup, length: 32 },
      filters: [
        { dataSize: VAULT_LP_STATE_ACCOUNT_LEN },
        { memcmp: { offset: HEADER_KIND_OFF, bytes: bs58.encode(Uint8Array.of(KIND_VAULT_LP_STATE)) } },
        { memcmp: { offset: VS.juniorOwner, bytes: wallet.toBase58() } },
      ],
    }),
  ]);
  const lpKeys: PublicKey[] = [];
  for (const { pubkey, account } of owned) {
    const d = bytes(account.data);
    if (d.length < 8) continue;
    const control = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(0, true);
    if (decodePortfolioMatcherControl(control).enabled) lpKeys.push(pubkey); // a trading account is not a creator marker
  }
  const out = new Map<string, PublicKey>();
  for (let i = 0; i < lpKeys.length; i += 100) {
    const chunk = lpKeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, { dataSlice: { offset: PF_MARKET_OFF, length: 32 } });
    for (const info of infos) {
      if (!info || info.data.length < 32) continue;
      const k = new PublicKey(bytes(info.data).subarray(0, 32));
      out.set(k.toBase58(), k);
    }
  }
  for (const { pubkey } of authored) out.set(pubkey.toBase58(), pubkey);
  for (const { pubkey } of administered) out.set(pubkey.toBase58(), pubkey);
  for (const { account } of juniors) {
    const d = bytes(account.data);
    if (d.length !== 32) continue;
    const k = new PublicKey(d);
    out.set(k.toBase58(), k);
  }
  return [...out.values()].slice(0, MAX_CREATOR_SLABS);
}

/** Market bytes for each key; keeps only accounts the program owns that decode as a v2.2 market. */
export async function readCreatorSlabs(connection: Pick<Connection, "getMultipleAccountsInfo">, programId: PublicKey, keys: PublicKey[]): Promise<CreatorSlab[]> {
  const out: CreatorSlab[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(programId)) return;
      const raw = new Uint8Array(info.data);
      if (staleResolveStatusV22(raw, 0n) === null) return; // not a v2.2 market
      out.push({ slab: chunk[j], raw });
    });
  }
  return out;
}

export interface SlabHistory {
  /** Slot of the oldest successful transaction on the slab (its creation), or null when unknown. */
  creationSlot: bigint | null;
  /** True: the transaction at `last_good_oracle_slot` was launch-time configuration only (no price ever pushed). False: a price. Null: not readable. */
  neverPushed: boolean | null;
}

const historyCache = new Map<string, SlabHistory>();

/** Test seam. */
export function __clearHistoryCache(): void {
  historyCache.clear();
}

interface SigInfo {
  slot: number;
  err: unknown;
  signature: string;
}

/** Wrapper instruction tags in a transaction that touch the slab. Null when the transaction cannot be read. */
async function tagsAt(connection: Pick<Connection, "getTransaction">, programId: PublicKey, slab: PublicKey, signature: string): Promise<number[] | null> {
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || tx.meta?.err) return null;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const tags: number[] = [];
  for (const ix of msg.compiledInstructions) {
    const prog = keys.get(ix.programIdIndex);
    if (!prog || !prog.equals(programId) || ix.data.length === 0) continue;
    if (!ix.accountKeyIndexes.some((a) => keys.get(a)?.equals(slab))) continue;
    tags.push(ix.data[0]);
  }
  return tags;
}

/**
 * Was a price ever pushed? Reads the transaction(s) at `lastGood` and applies `classifyLastGoodTags` (which tags can advance the
 * slot, derived from the program source). Unreadable or unexplained gives null.
 */
export async function readNeverPushed(
  connection: Pick<Connection, "getTransaction">,
  programId: PublicKey,
  slab: PublicKey,
  lastGood: bigint,
  sigs: readonly SigInfo[],
  oracleMode: number,
  creationSlot: bigint | null = null,
): Promise<boolean | null> {
  const at = sigs.filter((s) => s.err === null && BigInt(s.slot) === lastGood);
  if (at.length === 0) return null;
  const all: number[] = [];
  for (const s of at.slice(0, 4)) {
    const t = await tagsAt(connection, programId, slab, s.signature);
    if (t === null) return null;
    all.push(...t);
  }
  if (all.length === 0) return null;
  const r = classifyLastGoodTags(all, oracleMode);
  // A config / restart / freeze tx (62, 69, 40, 34, 35) long after creation, with no InitMarket in it, is a rotation or restart of a
  // market that may well have had prices before: its history is not "no price ever accepted". Inconclusive.
  if (r === true && creationSlot !== null && !all.includes(0) && lastGood - creationSlot > NEVER_CONNECTED_FALLBACK_SLACK_SLOTS) return null;
  return r;
}

/**
 * History facts for a slab. An RPC failure is unknown and NOT cached (the next scan retries); a full signature page is an old busy
 * market (certainly not freshly created): creation unknown, cached.
 */
export async function readSlabHistory(connection: Pick<Connection, "getSignaturesForAddress" | "getTransaction">, programId: PublicKey, slab: PublicKey, lastGood: bigint, oracleMode = 0): Promise<SlabHistory> {
  const key = `${slab.toBase58()}:${lastGood}`;
  const hit = historyCache.get(key);
  if (hit) return hit;
  try {
    const sigs = await connection.getSignaturesForAddress(slab, { limit: SIGNATURE_PAGE }, "confirmed");
    let result: SlabHistory;
    if (sigs.length === 0 || sigs.length >= SIGNATURE_PAGE) {
      result = { creationSlot: null, neverPushed: null };
    } else {
      const ok = sigs.filter((s) => s.err === null);
      const creationSlot = ok.length > 0 ? BigInt(ok.reduce((m, s) => (s.slot < m ? s.slot : m), ok[0].slot)) : null;
      result = { creationSlot, neverPushed: await readNeverPushed(connection, programId, slab, lastGood, ok, oracleMode, creationSlot) };
    }
    historyCache.set(key, result);
    return result;
  } catch {
    return { creationSlot: null, neverPushed: null };
  }
}

export interface CreatorCandidate extends CreatorSlab, SlabHistory {
  /** `last_good_oracle_slot` from the bytes just read. */
  lastGoodOracleSlot: bigint;
}

/** `oracle_mode` (config +193); an unreadable market is treated as non-manual (the conservative side: a crank tag then counts as a price). */
function oracleModeOf(raw: Uint8Array): number {
  try {
    return parseWrapperConfigV17(raw).oracleMode;
  } catch {
    return 1;
  }
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The full lookup. Markets that pushed a price within the launch wait cost no history call. Of the silent ones, the
 * MAX_HISTORY_LOOKUPS with the NEWEST last-good slot (the likeliest fresh launches) are read, MAX_PARALLEL at a time; the rest
 * are returned with unknown history.
 */
export async function lookupCreatorMarkets(connection: Conn, programId: PublicKey, wallet: PublicKey): Promise<CreatorCandidate[]> {
  const keys = await findCreatorSlabKeys(connection, programId, wallet);
  const slabs = await readCreatorSlabs(connection, programId, keys);
  const clusterSlot = BigInt(await connection.getSlot("confirmed"));
  const rows = slabs.map((s) => ({ ...s, lastGoodOracleSlot: staleResolveStatusV22(s.raw, 0n)?.lastGoodOracleSlot ?? 0n }));
  const silent = rows
    .filter((r) => clusterSlot - r.lastGoodOracleSlot > LAUNCH_WAIT_SLOTS)
    .sort((a, b) => (a.lastGoodOracleSlot < b.lastGoodOracleSlot ? 1 : a.lastGoodOracleSlot > b.lastGoodOracleSlot ? -1 : 0));
  const cached = (r: { slab: PublicKey; lastGoodOracleSlot: bigint }): boolean => historyCache.has(`${r.slab.toBase58()}:${r.lastGoodOracleSlot}`);
  const toRead = [...silent.filter(cached), ...silent.filter((r) => !cached(r)).slice(0, MAX_HISTORY_LOOKUPS)];
  const histories = new Map<string, SlabHistory>();
  await mapBounded(toRead, MAX_PARALLEL, async (r) => {
    histories.set(r.slab.toBase58(), await readSlabHistory(connection, programId, r.slab, r.lastGoodOracleSlot, oracleModeOf(r.raw)));
  });
  return rows.map((r) => ({ ...r, ...(histories.get(r.slab.toBase58()) ?? { creationSlot: null, neverPushed: null }) }));
}
