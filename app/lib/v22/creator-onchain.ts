/**
 * Creator lookup that does not depend on the Supabase registry (#3637): a market with no registry row is invisible on
 * /markets and /my-markets, so the creator's own v2.2 markets are found on chain.
 *
 * Two markers, both read with memcmp filters (no full-program scan):
 *  - the LP portfolio the wizard creates with the creator's wallet as owner (portfolio +116, market id +16; the LP is the
 *    one whose matcher control bit 0 is set, lib/lpPortfolio.ts). Completed launches rotate `marketauth` to the stake pool PDA,
 *    so this is the durable creator marker;
 *  - `marketauth` (config +0 = account +16) still equal to the wallet: an unfinished launch. Keys only (dataSlice length 0).
 * Offsets: percolator-prog aca02ba6 `src/v16_program.rs` (HEADER_LEN 16, KIND_MARKET 1, KIND_PORTFOLIO 2,
 * provenance market id at +16, owner at +116, `WrapperConfigV16.marketauth` first field).
 *
 * RPC budget per lookup: 2 getProgramAccounts (owner-scoped), ceil(n/100) getMultipleAccounts, and at most
 * MAX_CREATION_LOOKUPS getSignaturesForAddress (cached per slab for the session: a creation slot never changes).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { ACCOUNT_KIND, LAYOUT_V22 } from "./sdk/layout";
import { portfolioGpaFilters } from "./layout";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { staleResolveStatusV22 } from "./stale-resolve";

const PF_MARKET_OFF = 16;
const PF_OWNER_OFF = 116;
const KIND_OFF = 10;
const MARKETAUTH_OFF = LAYOUT_V22.headerLen; // config rel 0

/** Hard caps: a wallet that traded widely owns many portfolios, but a creator owns few LP portfolios. */
export const MAX_CREATOR_SLABS = 30;
export const MAX_CREATION_LOOKUPS = 12;
const SIGNATURE_PAGE = 1000;

export interface CreatorSlab {
  slab: PublicKey;
  raw: Uint8Array;
}

type Conn = Pick<Connection, "getProgramAccounts" | "getMultipleAccountsInfo" | "getSignaturesForAddress">;

/** Distinct market ids the wallet created, from both markers. */
export async function findCreatorSlabKeys(connection: Pick<Connection, "getProgramAccounts">, programId: PublicKey, wallet: PublicKey): Promise<PublicKey[]> {
  const [owned, authored] = await Promise.all([
    connection.getProgramAccounts(programId, { filters: [...portfolioGpaFilters(), { memcmp: { offset: PF_OWNER_OFF, bytes: wallet.toBase58() } }] }),
    connection.getProgramAccounts(programId, {
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: KIND_OFF, bytes: bs58.encode(Uint8Array.of(ACCOUNT_KIND.Market)) } },
        { memcmp: { offset: MARKETAUTH_OFF, bytes: wallet.toBase58() } },
      ],
    }),
  ]);
  const out = new Map<string, PublicKey>();
  for (const { account } of owned) {
    const data = account.data instanceof Uint8Array ? account.data : new Uint8Array(account.data);
    if (!isLpPortfolio(data)) continue; // a trading account is not a creator marker
    out.set(...keyEntry(new PublicKey(data.subarray(PF_MARKET_OFF, PF_MARKET_OFF + 32))));
  }
  for (const { pubkey } of authored) out.set(...keyEntry(pubkey));
  return [...out.values()].slice(0, MAX_CREATOR_SLABS);
}

function keyEntry(k: PublicKey): [string, PublicKey] {
  return [k.toBase58(), k];
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

const creationSlotCache = new Map<string, bigint | null>();

/** Test seam. */
export function __clearCreationSlotCache(): void {
  creationSlotCache.clear();
}

/**
 * Slot of the oldest successful transaction on the slab (its creation). Null when it cannot be known: no history, a full
 * page (an old busy market, so certainly not freshly created), or an RPC failure (not cached, so a later scan retries).
 */
export async function findCreationSlot(connection: Pick<Connection, "getSignaturesForAddress">, slab: PublicKey): Promise<bigint | null> {
  const key = slab.toBase58();
  if (creationSlotCache.has(key)) return creationSlotCache.get(key) ?? null;
  try {
    const sigs = await connection.getSignaturesForAddress(slab, { limit: SIGNATURE_PAGE }, "confirmed");
    let result: bigint | null = null;
    if (sigs.length > 0 && sigs.length < SIGNATURE_PAGE) {
      const ok = sigs.filter((s) => s.err === null);
      if (ok.length > 0) result = BigInt(ok.reduce((m, s) => (s.slot < m ? s.slot : m), ok[0].slot));
    }
    creationSlotCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

export interface CreatorCandidate extends CreatorSlab {
  creationSlot: bigint | null;
  /** `last_good_oracle_slot` from the bytes just read. */
  lastGoodOracleSlot: bigint;
}

/** The full lookup: keys, bytes, then creation slots for at most MAX_CREATION_LOOKUPS Live or Resolved markets. */
export async function lookupCreatorMarkets(connection: Conn, programId: PublicKey, wallet: PublicKey): Promise<CreatorCandidate[]> {
  const keys = await findCreatorSlabKeys(connection, programId, wallet);
  const slabs = await readCreatorSlabs(connection, programId, keys);
  const out: CreatorCandidate[] = [];
  let lookups = 0;
  for (const s of slabs) {
    const cached = creationSlotCache.has(s.slab.toBase58());
    const lastGoodOracleSlot = staleResolveStatusV22(s.raw, 0n)?.lastGoodOracleSlot ?? 0n;
    if (!cached && lookups >= MAX_CREATION_LOOKUPS) {
      out.push({ ...s, creationSlot: null, lastGoodOracleSlot });
      continue;
    }
    if (!cached) lookups++;
    out.push({ ...s, creationSlot: await findCreationSlot(connection, s.slab), lastGoodOracleSlot });
  }
  return out;
}
