/**
 * Reads shared by the v2.2 Earn surfaces (bond card, rescue): the wrapper program id, the bond tranche /
 * position decoded by the account's VERSION, and the bound vault LP context. A missing account is `null`,
 * never an error: no tranche means "no bond surface".
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveVaultAuthority } from "@percolatorct/sdk";
import {
  ACCOUNT_KIND,
  decodeBondPositionV20,
  decodeBondTrancheV20,
  deriveBondPositionV22,
  deriveBondTrancheV22,
  resolveLayout,
  type BondPositionV20,
  type BondTrancheV20,
  type MarketV22,
} from "./sdk";

export interface BondAccounts {
  tranche: BondTrancheV20;
  position: BondPositionV20 | null;
  trancheKey: PublicKey;
  positionKey: PublicKey | null;
}

/** Read the bond tranche (and the wallet's position) of a market. Null when the market has no tranche. */
export async function readBondAccounts(connection: Connection, programId: PublicKey, market: PublicKey, owner: PublicKey | null): Promise<BondAccounts | null> {
  const [trancheKey] = deriveBondTrancheV22(programId, market);
  const positionKey = owner ? deriveBondPositionV22(programId, market, owner)[0] : null;
  const infos = await connection.getMultipleAccountsInfo(positionKey ? [trancheKey, positionKey] : [trancheKey], "confirmed");
  const t = infos[0];
  if (!t || !t.owner.equals(programId)) return null;
  const tb = new Uint8Array(t.data);
  // The VERSION picks the table (typed refusal of an unknown one); a non-bond account decodes to an error -> no surface.
  let tranche: BondTrancheV20;
  try {
    tranche = decodeBondTrancheV20(tb, resolveLayout(tb, { parser: "bondTranche", kind: ACCOUNT_KIND.BondTranche }));
  } catch {
    return null;
  }
  let position: BondPositionV20 | null = null;
  const p = infos[1];
  if (p && p.owner.equals(programId)) {
    const pb = new Uint8Array(p.data);
    try {
      position = decodeBondPositionV20(pb, resolveLayout(pb, { parser: "bondPosition", kind: ACCOUNT_KIND.BondPosition }));
    } catch {
      position = null;
    }
  }
  return { tranche, position, trancheKey, positionKey };
}

/** The vault token account the wrapper pays from / into (owned by the vault authority PDA). */
export function vaultTokenOf(programId: PublicKey, market: PublicKey, collateralMint: PublicKey): PublicKey {
  const [auth] = deriveVaultAuthority(programId, market);
  return getAssociatedTokenAddressSync(collateralMint, auth, true);
}

export type MarketCtx = MarketV22;
