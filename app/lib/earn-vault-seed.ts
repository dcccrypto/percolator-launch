/**
 * earn-vault-seed.ts — how a NEW market's two asset-0 backing domains get funded.
 *
 * WHY (bug C-1, 2026-09-29): the wizard used to top up both domains directly
 * (TopUpBackingBucket at MAX-1 expiry, M3a) and THEN send CreateLpVault(domain 0).
 * The deployed wrapper (percolator-prog @ 6377376a, v16_program.rs handle_create_lp_vault,
 * loop over [domain, sibling_domain(domain)] at ~L21492-21506) refuses when either
 * domain already holds backing at any expiry other than LP_VAULT_BACKING_EXPIRY_SLOT
 * (u64::MAX/2): Custom(63) LpVaultBackingBucketNotEmpty. So every wizard market
 * failed at "Creating the Earn vault".
 *
 * FIX (mirrors the fork-verified seed relaunch/newmarkets-v18.3.ts BACKING_MODE=lpvault):
 * NO direct top-up. One atomic transaction does
 *   CreateLpVault(domain 0)            -- buckets are still Empty
 *   createATA(LP-share mint) idempotent
 *   DepositToLpVault(domain 0)         -- stamps LP_VAULT_BACKING_EXPIRY_SLOT (never lapses)
 *   DepositToLpVault(domain 1)         -- sibling domain, same authority (registry PDA)
 * The creator wallet funds BOTH deposits from its own ATA (same money the two
 * direct seeds used: backingSeedPerDomain x 2) and receives the LP shares.
 * DepositToLpVault (handler L21623) needs no authority-epoch / intent lane, so it is
 * independent of the oracle hand-off; it MUST land before Stake InitPool (marketauth
 * rotation makes CreateLpVault unreachable), which the M4a-before-M4b order keeps.
 * Genesis deposit must exceed LP_VAULT_MINIMUM_LIQUIDITY (1_000 shares, v16_program.rs:573);
 * backingSeedPerDomain floors at 10_000.
 *
 * Markets created by the OLD flow (MAX-1 buckets present) can never get a vault:
 * see EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ACCOUNTS_LP_VAULT_DEPOSIT,
  WELL_KNOWN,
  buildAccountMetas,
  buildIx,
  deriveLpBackingLedger,
  encodeCreateLpVaultV17,
  encodeDepositToLpVault,
} from "@percolatorct/sdk";
import { createLpVaultKeys } from "@/lib/v22/create-lp-vault";
import { isShareNamingEnabled, shareTickerFor } from "@/lib/v22/share-naming";
import { buildInitLpShareMetadataIxV22 } from "@/lib/v22/sdk";

/** Wrapper PercolatorError::LpVaultBackingBucketNotEmpty (v16_program.rs:1066). */
export const LP_VAULT_BACKING_BUCKET_NOT_EMPTY_CODE = 63;

/** Vault params — unchanged from the wizard and the seeded markets. */
export const EARN_VAULT_FEE_SHARE_BPS = 1000;
export const EARN_VAULT_OI_RESERVATION_BPS = 8000;
/**
 * C-1 (live SDK tests 2026-10-01, decided): new markets' Earn redemption cooldown AND stake
 * cooldown are the relaunch floor of 150 slots (~1 min), the front-run protection decided for the
 * relaunch (kit RELAUNCH_MIN_COOLDOWN_SLOTS). 5 slots (~2 s) was enforced (Custom 36) but too short
 * to protect anything. Existing markets keep theirs.
 */
export const RELAUNCH_MIN_COOLDOWN_SLOTS = 150n;
export const EARN_VAULT_COOLDOWN_SLOTS = RELAUNCH_MIN_COOLDOWN_SLOTS;
export const STAKE_POOL_COOLDOWN_SLOTS = RELAUNCH_MIN_COOLDOWN_SLOTS;

/** CreateLpVault + ATA + 2 deposits in one tx (devnet sim: ~151k CU measured; 500k leaves 3x headroom). */
export const EARN_VAULT_SEED_COMPUTE_UNITS = 500_000;

export const EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE =
  "This market's backing was seeded by an older version of the launcher (a direct top-up), and the " +
  "program refuses to create an Earn vault over it (LpVaultBackingBucketNotEmpty). Retrying cannot fix " +
  "this, and the vault can never be created for this market. Nothing further was applied — abandon this " +
  "market and launch a new one, or contact a maintainer to re-seed it.";

export interface EarnVaultSeedArgs {
  programId: PublicKey;
  wallet: PublicKey;
  market: PublicKey;
  registry: PublicKey;
  lpMint: PublicKey;
  userAta: PublicKey;
  vaultAta: PublicKey;
  /** Collateral to put into EACH of the two domains (backingSeedPerDomain). */
  seedPerDomain: bigint;
  /** false when the registry already exists (resume) — then only ATA + deposits. */
  includeCreate: boolean;
  /**
   * The market's primary collateral mint (`config.collateralMint`). v2.2 (flag on): tag 74's required account `[6]`; flag off: ignored.
   * Required with the flag on whenever `includeCreate` (the six-account form is refused on chain).
   */
  collateralMint?: PublicKey | null;
  /**
   * v2.2 (flag on): the market's symbol, reduced to the share token's ticker (tag 122, `A-Z0-9` up to 8; the generic form when empty).
   * Tag 122 follows tag 74 in the same transaction, signed by marketauth (`wallet`), before any marketauth handoff. Flag off: ignored.
   */
  shareSymbol?: string | null;
  /** `false` leaves tag 122 out (balance preflight failed, or the retry after a naming failure). Default: named whenever naming is enabled. */
  nameShare?: boolean;
}

/** Ordered instructions; never contains a direct TopUpBackingBucket. */
export function buildEarnVaultSeedInstructions(a: EarnVaultSeedArgs): TransactionInstruction[] {
  if (a.seedPerDomain <= 0n) throw new Error("Earn vault seed must be > 0 per domain");
  const ixs: TransactionInstruction[] = [];
  if (a.includeCreate) {
    ixs.push(
      buildIx({
        programId: a.programId,
        keys: createLpVaultKeys({
          admin: a.wallet, market: a.market, registry: a.registry, lpMint: a.lpMint, collateralMint: a.collateralMint,
        }),
        data: encodeCreateLpVaultV17({
          feeShareBps: EARN_VAULT_FEE_SHARE_BPS,
          oiReservationThresholdBps: EARN_VAULT_OI_RESERVATION_BPS,
          redemptionCooldownSlots: EARN_VAULT_COOLDOWN_SLOTS,
          domain: 0,
        }),
      }),
    );
    // v2.2: name the share token right after the vault exists (registry + mint are initialised), while `wallet` is still marketauth.
    // The wallet pays the record (it must hold 0.03 SOL for the instruction; ~0.0151 SOL is the net cost) and signs as marketauth.
    if (isShareNamingEnabled() && a.nameShare !== false) {
      ixs.push(
        buildInitLpShareMetadataIxV22({
          programId: a.programId, market: a.market, payer: a.wallet, ticker: shareTickerFor(a.shareSymbol), marketauth: a.wallet,
        }),
      );
    }
  }
  const lpAta = getAssociatedTokenAddressSync(a.lpMint, a.wallet, false, WELL_KNOWN.tokenProgram);
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(a.wallet, lpAta, a.wallet, a.lpMint, WELL_KNOWN.tokenProgram),
  );
  // ledger = registry.domain's (0); siblingLedger = domain 1; `domain` arg picks the pot.
  const [ledger0] = deriveLpBackingLedger(a.programId, a.market, 0);
  const [ledger1] = deriveLpBackingLedger(a.programId, a.market, 1);
  for (const domain of [0, 1]) {
    ixs.push(
      buildIx({
        programId: a.programId,
        keys: buildAccountMetas(ACCOUNTS_LP_VAULT_DEPOSIT, {
          depositor: a.wallet, market: a.market, registry: a.registry, lpMint: a.lpMint,
          depositorLpAta: lpAta, sourceToken: a.userAta, vaultToken: a.vaultAta, ledger: ledger0,
          tokenProgram: WELL_KNOWN.tokenProgram, systemProgram: SystemProgram.programId, siblingLedger: ledger1,
        }),
        data: encodeDepositToLpVault({ amount: a.seedPerDomain.toString(), domain }),
      }),
    );
  }
  return ixs;
}
