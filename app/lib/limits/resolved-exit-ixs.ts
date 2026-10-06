/**
 * Instructions for one `ExitStep` (lib/limits/resolved-exit.ts). Payout destinations are the
 * OWNER's collateral ATA (tags 30/46 verify `dest.owner == portfolio owner`; tag 101 pays the
 * junior owner), created idempotently by the caller in front of the step — the caller pays that
 * rent (~0.002 SOL each); tag 8 returns the portfolio's own rent to its owner.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TAG_CLAIM_RESOLVED_PAYOUT_TOPUP, TAG_CLOSE_RESOLVED } from "./constants";
import {
  buildLpVaultCrankFeesIx,
  buildPermissionlessResolvedIx,
  buildResolvedClosePortfolioIx,
  buildVaultLpSettleResolvedIx,
  type VaultLpMarket,
} from "./p3-ix";
import type { ExitStep } from "./resolved-exit";

export interface ExitPortfolioRef {
  owner: PublicKey;
  portfolioId: bigint;
  matcherSequence: bigint;
  positionEpoch: bigint;
}

export interface ExitIxContext {
  payer: PublicKey;
  collateralMint: PublicKey;
  vaultToken: PublicKey;
  vaultAuthority: PublicKey;
  /** Present when the market has a bound vault LP (`domain` = the registry's own pot). */
  vault: (VaultLpMarket & { juniorOwner: PublicKey; domain: number }) | null;
  programId: PublicKey;
  market: PublicKey;
  portfolios: ReadonlyMap<string, ExitPortfolioRef>;
}

function ownerAta(c: ExitIxContext, owner: PublicKey): { ata: PublicKey; create: TransactionInstruction } {
  const ata = getAssociatedTokenAddressSync(c.collateralMint, owner, true);
  return { ata, create: createAssociatedTokenAccountIdempotentInstruction(c.payer, ata, owner, c.collateralMint) };
}

export function exitStepIxs(step: ExitStep, c: ExitIxContext): TransactionInstruction[] {
  if (step.kind === "harvest") {
    if (!c.vault) throw new Error("harvest without a bound vault");
    return [
      buildLpVaultCrankFeesIx({
        programId: c.programId,
        cranker: c.payer,
        market: c.market,
        registry: c.vault.registry,
        ledger: c.vault.ledger,
        siblingLedger: c.vault.siblingLedger,
        domain: c.vault.domain,
        bound: { vaultLpState: c.vault.vaultLpState, ...(c.vault.ext ? { ext: c.vault.ext, lpPortfolio: c.vault.lpPortfolio } : {}) },
      }),
    ];
  }
  if (step.kind === "settle-vault-lp") {
    if (!c.vault) throw new Error("settle-vault-lp without a bound vault");
    const j = ownerAta(c, c.vault.juniorOwner);
    return [j.create, buildVaultLpSettleResolvedIx(c.vault, c.payer, j.ata, c.vaultToken, c.vaultAuthority, step.topup)];
  }
  const ref = c.portfolios.get(step.portfolio);
  if (!ref) throw new Error(`unknown portfolio ${step.portfolio}`);
  const portfolio = new PublicKey(step.portfolio);
  if (step.kind === "close-empty") {
    return [
      buildResolvedClosePortfolioIx({
        programId: c.programId,
        closer: c.payer,
        market: c.market,
        portfolio,
        owner: ref.owner,
        portfolioId: ref.portfolioId,
        matcherSequence: ref.matcherSequence,
        positionEpoch: ref.positionEpoch,
      }),
    ];
  }
  const a = ownerAta(c, ref.owner);
  return [
    a.create,
    buildPermissionlessResolvedIx({
      tag: step.kind === "close-resolved" ? TAG_CLOSE_RESOLVED : TAG_CLAIM_RESOLVED_PAYOUT_TOPUP,
      programId: c.programId,
      owner: ref.owner,
      market: c.market,
      portfolio,
      ownerAta: a.ata,
      vaultToken: c.vaultToken,
      vaultAuthority: c.vaultAuthority,
    }),
  ];
}
