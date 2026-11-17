import { PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { getConfig } from "@/lib/config";

/**
 * Client-safe market-completeness signal (no server-only imports), shared by
 * the server markets list (via lib/live-market-state.ts) and the trade UI's
 * post-failure diagnosis (lib/tradeRejectDiagnosis.ts).
 */

/** Devnet-only today (percolator-stake has no mainnet deployment — see
 *  PERCOLATOR_ERRORS[60] StakeProgramNotPinned in @percolatorct/sdk). Read
 *  once per module load, not per-market — getConfig() is a pure function of
 *  the deployment's network. */
const STAKE_PROGRAM_ID: PublicKey | null = (() => {
  const vaultProgramId = (getConfig() as { vaultProgramId?: string }).vaultProgramId;
  if (!vaultProgramId) return null;
  try {
    return new PublicKey(vaultProgramId);
  } catch {
    return null;
  }
})();

/**
 * The stake-pool PDA is a pure function of (slab, stake program), and findProgramAddressSync costs
 * ~3 ms (it dominated the whole slab decode on every poll). Memoised per slab; only successful
 * derivations are cached, so a throw still reaches the caller each time. Bounded: cleared when full.
 */
const PDA_CACHE_MAX = 4096;
const pdaCache = new Map<string, PublicKey>();
function stakePoolPdaOf(slabKey: PublicKey, stakeProgram: PublicKey): PublicKey {
  const k = slabKey.toBase58();
  const hit = pdaCache.get(k);
  if (hit) return hit;
  const [pda] = deriveStakePool(slabKey, stakeProgram);
  if (pdaCache.size >= PDA_CACHE_MAX) pdaCache.clear();
  pdaCache.set(k, pda);
  return pda;
}

/**
 * Completeness test from a slab's `marketauth` alone.
 *
 * A market is complete once the create-market wizard's FINAL on-chain step
 * (percolator-stake InitPool) has run, which irreversibly rotates `marketauth`
 * from the creator's wallet to the stake-pool PDA. So `marketauth ==
 * derive("stake_pool", slab)` is a zero-extra-RPC completeness signal.
 *
 * No stake program pinned for this network (mainnet today) => the stake step
 * doesn't gate anything here => every market is treated as complete. A PDA
 * derivation/compare failure fails closed (incomplete).
 *
 * NOTE: "incomplete" does NOT imply "untradeable" — the stake pool is the last
 * wizard step, after the matcher/LP are configured, so a market that died at
 * "Create Earn vault" or "Stake pool" can still trade.
 */
export function isMarketauthComplete(marketauth: PublicKey, slabKey: PublicKey): boolean {
  if (!STAKE_PROGRAM_ID) return true;
  try {
    return marketauth.equals(stakePoolPdaOf(slabKey, STAKE_PROGRAM_ID));
  } catch {
    return false;
  }
}
