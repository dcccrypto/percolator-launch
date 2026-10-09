/**
 * Tag 74 `CreateLpVault` account list, layout-aware (percolator-prog#545).
 *
 * v2.2 (flag on): SEVEN accounts, `[6]` the market's primary collateral mint (read-only; must equal `config.collateral_mint`; the share mint
 * is created with its decimals). The six-account form is REFUSED on chain (`NotEnoughAccountKeys`), with no fallback to a 0-decimal mint.
 * v2.1 (flag off): the six accounts the deployed wrapper takes, exactly as every call site built them before.
 *
 * ONE place so the five call sites (earn-vault-seed, both useCreateMarket calls through it, mobile-market-funding-ixs and its route,
 * useInsuranceLP) cannot drift.
 */
import type { AccountMeta, PublicKey } from "@solana/web3.js";
import { ACCOUNTS_CREATE_LP_VAULT, WELL_KNOWN, buildAccountMetas } from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "./flag";
import { ACCOUNTS_CREATE_LP_VAULT_V22 } from "./sdk";

export interface CreateLpVaultKeysArgs {
  /** marketauth (signer). */
  admin: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  lpMint: PublicKey;
  /** The market's PRIMARY collateral mint (`config.collateralMint`). Required with the v2.2 flag on, ignored with it off. */
  collateralMint?: PublicKey | null;
}

/** Account metas for tag 74 in the active layout. Throws with the flag on and no collateral mint (the program would refuse the 6-account form). */
export function createLpVaultKeys(a: CreateLpVaultKeysArgs): AccountMeta[] {
  const six = {
    admin: a.admin, market: a.market, registry: a.registry, lpMint: a.lpMint,
    systemProgram: WELL_KNOWN.systemProgram, tokenProgram: WELL_KNOWN.tokenProgram,
  };
  if (!isDevnetV22Enabled()) return buildAccountMetas(ACCOUNTS_CREATE_LP_VAULT, six);
  if (!a.collateralMint) throw new Error("CreateLpVault on v2.2 needs the market's collateral mint as account [6] (the six-account form is refused on chain)");
  return buildAccountMetas(ACCOUNTS_CREATE_LP_VAULT_V22, { ...six, collateralMint: a.collateralMint });
}
