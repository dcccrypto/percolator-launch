/**
 * The junior's terminal exit on a RESOLVED P3 market (F-14, 58e379f1): tag 102 with the
 * resolved tail pays up to `physical - C` in SPL (Earn seniors keep their claim C). 78 goes
 * first in the same tx when LP fees or a claim-free residual are still pending, because 102
 * values the vault only after they are credited. Shared by hooks/useJuniorTranche.ts
 * (releaseResolved) and the P3 BPF sim bridge (scripts/limits-parity/p3-app-ixs.ts
 * `junior-release`), so the sim executes exactly what the button sends.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { decodeMarketEngineView, decodeTerminalBacking, decodeTerminalBackingDomains } from "./decode";
import { harvestableFeeAtoms, juniorResolvedSurplusAtoms } from "./vault-tranche";
import { buildLpVaultCrankFeesIx, buildVaultLpReleaseSurplusIx, type VaultLpMarket } from "./p3-ix";

/** Does the release need 78 first (fees harvestable or a terminal residual not yet absorbed)? */
export function juniorReleaseNeedsHarvest(marketData: Uint8Array | null, registryDomain: number): boolean {
  if (!marketData) return false;
  const engine = decodeMarketEngineView(marketData);
  const tb = decodeTerminalBacking(marketData, registryDomain);
  return (engine ? harvestableFeeAtoms(engine) ?? 0n : 0n) > 0n || (tb ? tb.residual : 0n) > 0n;
}

/** What the junior can take now: `physical - C` over both domains of the vault's asset. */
export function juniorResolvedReleasableAtoms(
  marketData: Uint8Array | null,
  registryDomain: number,
  seniorClaimAtoms: bigint,
): bigint | null {
  if (!marketData) return null;
  const tb = decodeTerminalBacking(marketData, registryDomain);
  return tb ? juniorResolvedSurplusAtoms(tb.physical, seniorClaimAtoms) : null;
}

export interface JuniorResolvedReleaseCtx {
  vm: VaultLpMarket;
  domain: number;
  owner: PublicKey;
  ownerAta: PublicKey;
  mint: PublicKey;
  vaultToken: PublicKey;
  vaultAuthority: PublicKey;
}

/** Idle backing per source domain `[registry domain, sibling]` (null when the market cannot be decoded). */
export function juniorResolvedDomainIdle(marketData: Uint8Array | null, registryDomain: number): readonly [bigint, bigint] | null {
  return marketData ? decodeTerminalBackingDomains(marketData, registryDomain) : null;
}

/**
 * Tag 102 pays from ONE domain's backing bucket per call, but its gate (`physical - C`) spans both
 * domains. Split `amount` into per-domain legs: the registry's own bucket first (up to what it holds),
 * the rest from the sibling's. A claim that fits one bucket stays a single 102. With no per-domain
 * figures (null) the amount is one leg on the registry domain, as before.
 */
export function splitJuniorRelease(
  amount: bigint,
  registryDomain: number,
  idle: readonly [bigint, bigint] | null,
): { sourceDomain: number; amount: bigint }[] {
  if (!idle || amount <= idle[0]) return [{ sourceDomain: registryDomain, amount }];
  const first = idle[0];
  const rest = amount - first;
  return first > 0n
    ? [{ sourceDomain: registryDomain, amount: first }, { sourceDomain: registryDomain ^ 1, amount: rest }]
    : [{ sourceDomain: registryDomain ^ 1, amount: rest }];
}

export function buildJuniorResolvedReleaseIxs(
  c: JuniorResolvedReleaseCtx,
  amount: bigint,
  needHarvest: boolean,
  domainIdle: readonly [bigint, bigint] | null = null,
): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(c.owner, c.ownerAta, c.owner, c.mint),
    ...(needHarvest
      ? [
          buildLpVaultCrankFeesIx({
            programId: c.vm.programId,
            cranker: c.owner,
            market: c.vm.market,
            registry: c.vm.registry,
            ledger: c.vm.ledger,
            siblingLedger: c.vm.siblingLedger,
            domain: c.domain,
            bound: { vaultLpState: c.vm.vaultLpState, ...(c.vm.ext ? { ext: c.vm.ext, lpPortfolio: c.vm.lpPortfolio } : {}) },
          }),
        ]
      : []),
    ...splitJuniorRelease(amount, c.domain, domainIdle).map((leg) =>
      buildVaultLpReleaseSurplusIx(c.vm, c.owner, leg.amount, leg.sourceDomain, {
        destToken: c.ownerAta,
        vaultToken: c.vaultToken,
        vaultAuthority: c.vaultAuthority,
      }),
    ),
  ];
}
