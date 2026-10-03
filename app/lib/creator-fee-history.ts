/**
 * All-time creator fees CLAIMED on one market, rebuilt from chain history.
 *
 * The chain keeps no lifetime counter: `creator_fee_claimable_atoms` is the CURRENT balance and
 * every claim (`WithdrawCreatorFee`, tag 90) debits it. But tag 90 is exact-amount — its data
 * carries the u128 amount it paid — and it always moves funds out of the market's vault token
 * account. So summing the successful tag-90 instructions for this market, found through the
 * vault's signatures, gives the claimed total exactly, including claims made from another device
 * or through the /my-markets claim-all.
 *
 * Cost: two signature lists plus one getTransaction per transaction that touched both the vault
 * and the claimant's token account (see fetchCreatorFeesClaimed). The result is cached per market
 * and claimant in localStorage with the newest vault signature scanned, so a later view only
 * fetches what landed since.
 */
import { PublicKey, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveVaultAuthority } from "@percolatorct/sdk";

const TAG_WITHDRAW_CREATOR_FEE = 90;
/** tag u8 + amount u128 + asset_index u16 + authority_epoch u64 (SDK encodeWithdrawCreatorFee). */
const CLAIM_DATA_LEN = 1 + 16 + 2 + 8;
/** Account index of the market in ACCOUNTS_WITHDRAW_CREATOR_FEE (authority, market, ...). */
const MARKET_ACCOUNT_INDEX = 1;

export interface ClaimedTotal {
  /** Sum of every successful claim, in collateral atoms. */
  claimedAtoms: bigint;
  claims: number;
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}

/** Tag-90 claims for `market` in one transaction (top-level instructions only; a failed tx counts 0). */
export function claimsInTransaction(
  tx: Pick<VersionedTransactionResponse, "meta" | "transaction"> | null,
  programId: PublicKey,
  market: PublicKey,
): ClaimedTotal {
  const none = { claimedAtoms: 0n, claims: 0 };
  if (!tx || tx.meta?.err) return none;
  const msg = tx.transaction.message;
  // Resolve lookup-table accounts too, so an index past the static keys still maps.
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  let claimedAtoms = 0n;
  let claims = 0;
  // ponytail: top-level instructions only, which is how the app claims; a claim made through
  // a CPI (e.g. a multisig admin) or to a non-ATA destination isn't counted.
  for (const ix of msg.compiledInstructions) {
    const prog = keys.get(ix.programIdIndex);
    if (!prog || !prog.equals(programId)) continue;
    const data = ix.data;
    if (data.length !== CLAIM_DATA_LEN || data[0] !== TAG_WITHDRAW_CREATOR_FEE) continue;
    const mkt = keys.get(ix.accountKeyIndexes[MARKET_ACCOUNT_INDEX]);
    if (!mkt || !mkt.equals(market)) continue;
    claimedAtoms += readU128LE(data, 1);
    claims++;
  }
  return { claimedAtoms, claims };
}

interface Cached extends ClaimedTotal {
  /** Newest vault signature already scanned; the next scan stops there. */
  newest: string | null;
  /** Its slot: a node that returns anything older hasn't seen `newest` yet (see below). */
  newestSlot: number;
}

// Per market AND claimant: the scan only sees claims paid to this claimant's token account.
const cacheKey = (market: PublicKey, claimant: PublicKey) =>
  `percolator-creator-claimed:${market.toBase58()}:${claimant.toBase58()}`;

function readCache(key: string): Cached | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const c = JSON.parse(raw) as { claimedAtoms: string; claims: number; newest: string | null; newestSlot: number };
    return { claimedAtoms: BigInt(c.claimedAtoms), claims: c.claims, newest: c.newest, newestSlot: c.newestSlot ?? 0 };
  } catch {
    return null;
  }
}

function writeCache(key: string, c: Cached): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ claimedAtoms: c.claimedAtoms.toString(), claims: c.claims, newest: c.newest, newestSlot: c.newestSlot }),
    );
  } catch {
    // storage unavailable: the next view rescans
  }
}

interface SigEntry {
  signature: string;
  slot: number;
  ok: boolean;
}

/** Every signature for `address` (failed ones too), newest first, back to `until` (exclusive). */
async function signatures(connection: Connection, address: PublicKey, until?: string): Promise<SigEntry[]> {
  const out: SigEntry[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(address, { before, until, limit: 1000 });
    for (const s of page) out.push({ signature: s.signature, slot: s.slot, ok: !s.err });
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

/**
 * Total creator fees `claimant` has claimed on `market`. Throws if a read fails: an unread
 * history is not a zero.
 *
 * Tag 90 always moves funds from the market's vault token account to the claimant's own token
 * account, so a claim is in BOTH accounts' signature lists. Only that intersection is fetched:
 * the claimant's own deposits/withdrawals on this market plus their claims, not every trader's
 * vault activity. Signature lists are cheap (1000 per call); full transactions are not.
 *
 * The two lists are separate calls and can come from RPC nodes at different heights. A fresh
 * claim already in the vault list but not yet in the claimant's would be skipped, and the cache
 * would move past it for good. So only vault entries at or below the slot the claimant's list
 * has reached are counted, and the cache advances only that far; newer ones wait for the next
 * scan.
 */
export async function fetchCreatorFeesClaimed(
  connection: Connection,
  programId: PublicKey,
  market: PublicKey,
  collateralMint: PublicKey,
  claimant: PublicKey,
): Promise<ClaimedTotal> {
  const [vaultAuthority] = deriveVaultAuthority(programId, market);
  const vaultToken = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);
  const claimantToken = getAssociatedTokenAddressSync(collateralMint, claimant);
  const key = cacheKey(market, claimant);
  const cached = readCache(key);

  const vault = await signatures(connection, vaultToken, cached?.newest ?? undefined);
  // A node behind the cached scan doesn't know `until`, so it returns the whole history, which
  // would be added on top of the cached total. Anything older than the cached slot means that.
  if (cached?.newest && vault.some((e) => e.slot < cached.newestSlot)) {
    throw new Error("Transaction history is still loading");
  }
  let window: SigEntry[] = [];
  let mine = new Set<string>();
  if (vault.length > 0) {
    // ponytail: reads the claimant's full token-account history on every scan with new vault
    // activity, and the cache only advances to the claimant's latest activity, so a quiet creator
    // on a busy market re-reads the vault since then each time. Bound both by a getSlot height if
    // that gets slow.
    const claimantSigs = await signatures(connection, claimantToken);
    const reached = claimantSigs[0]?.slot ?? -1;
    window = vault.filter((e) => e.slot <= reached);
    mine = new Set(claimantSigs.filter((e) => e.ok).map((e) => e.signature));
  }

  let claimedAtoms = cached?.claimedAtoms ?? 0n;
  let claims = cached?.claims ?? 0;
  // One at a time: devnet rate-limits getTransaction hard, and the intersection is small.
  for (const e of window) {
    if (!e.ok || !mine.has(e.signature)) continue;
    const tx = await connection.getTransaction(e.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    // A transaction the RPC can't return yet would be skipped for good once the cache moves
    // past it, so fail the whole read instead and retry next time.
    if (!tx) throw new Error("Transaction history is still loading");
    const c = claimsInTransaction(tx, programId, market);
    claimedAtoms += c.claimedAtoms;
    claims += c.claims;
  }

  writeCache(key, {
    claimedAtoms,
    claims,
    newest: window[0]?.signature ?? cached?.newest ?? null,
    newestSlot: window[0]?.slot ?? cached?.newestSlot ?? 0,
  });
  return { claimedAtoms, claims };
}
