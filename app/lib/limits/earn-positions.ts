/**
 * The connected wallet's Earn position in EVERY vault, for the Earn hub table.
 *
 * Live report 2026-10-01: a creator's wizard seed (shares minted to their own LP ATA at market
 * creation) showed "—" under "Your Deposit" until they deposited again. The table only knew the
 * deposit of the vault bound to the right-hand rail; every other row was "—" whatever the wallet
 * held. This reads the wallet's LP ATA + pending-redemption escrow for all vaults in one batch
 * and values them like the rail (useInsuranceLP): the program's combined NAV over registry shares
 * on a two-pot vault (lib/limits/earn-split-pot.ts), else registry shares + distributed fees.
 */
import { parseLpVaultRegistry, parseLpRedemption } from "@/lib/v22/records";
import { PublicKey, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { deriveInsuranceLpMint, deriveLpRedemption, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { readSplitPotState, vaultValue } from "./earn-split-pot";

export interface EarnPosition {
  /** LP shares in the wallet + shares escrowed in a pending withdrawal. */
  shares: bigint;
  /** Collateral atoms those shares are worth (null = could not be valued). */
  valueAtoms: bigint | null;
}

/** shares * value / totalShares (floor); null when the vault has no shares. */
export function valueShares(shares: bigint, vaultValueAtoms: bigint, totalShares: bigint): bigint | null {
  if (totalShares <= 0n) return null;
  return (shares * vaultValueAtoms) / totalShares;
}

export async function readEarnPositions(
  connection: Connection,
  programId: PublicKey,
  wallet: PublicKey,
  slabs: readonly string[],
): Promise<Map<string, EarnPosition>> {
  const out = new Map<string, EarnPosition>();
  const rows = slabs.map((slab) => {
    const market = new PublicKey(slab);
    const [lpMint] = deriveInsuranceLpMint(programId, market);
    const [registry] = deriveLpVaultRegistry(programId, market);
    const [redemption] = deriveLpRedemption(programId, registry, wallet);
    return { slab, market, ata: getAssociatedTokenAddressSync(lpMint, wallet, true), registry, redemption };
  });
  const keys = rows.flatMap((r) => [r.ata, r.redemption, r.registry]);
  const infos: (Awaited<ReturnType<Connection["getAccountInfo"]>>)[] = [];
  for (let i = 0; i < keys.length; i += 99) infos.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")));

  await Promise.all(
    rows.map(async (r, i) => {
      const [ataInfo, redInfo, regInfo] = [infos[3 * i], infos[3 * i + 1], infos[3 * i + 2]];
      if (!regInfo || !regInfo.owner.equals(programId)) return;
      let shares = 0n;
      try {
        if (ataInfo) shares += unpackAccount(r.ata, ataInfo, ataInfo.owner).amount;
        if (redInfo && redInfo.owner.equals(programId) && redInfo.data.length > 0) shares += BigInt(parseLpRedemption(new Uint8Array(redInfo.data)).shares);
      } catch {
        return; // unreadable: leave the row unknown rather than claim zero
      }
      if (shares === 0n) {
        out.set(r.slab, { shares, valueAtoms: 0n });
        return;
      }
      const reg = parseLpVaultRegistry(new Uint8Array(regInfo.data));
      const total = BigInt(reg.totalLpSharesOutstanding);
      let valueAtoms = valueShares(shares, total + BigInt(reg.feeDistributionTotalAtoms), total);
      const sp = await readSplitPotState(connection, programId, r.market);
      const v = sp ? vaultValue(sp) : null;
      if (sp && v) valueAtoms = valueShares(shares, v.nav, sp.totalShares);
      out.set(r.slab, { shares, valueAtoms });
    }),
  );
  return out;
}
