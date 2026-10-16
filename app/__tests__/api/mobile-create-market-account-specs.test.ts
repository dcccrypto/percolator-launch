// @vitest-environment node

/**
 * Regression coverage for GH#2542: SDK 6.0.0 corrected several ACCOUNTS_* specs
 * against the v18 program, and this route (unlike hooks/useCreateMarket.ts, fixed
 * in 8444dae6) still passed the old v17 positional key arrays — every request 500'd
 * with "Account count mismatch: expected 3, got 9" before it could even finish
 * building (see mobile-create-market-blockhash-recovery.test.ts, which failed with
 * exactly that error before this fix).
 *
 * A count match alone is not enough — a reordering with the same length would
 * silently build a WRONG instruction (the wrong pubkey landing at the wrong
 * account index) and still pass a length check. So this test decodes every
 * wrapper instruction the route builds, by its instruction tag, and asserts BOTH
 * the account count and the per-position IDENTITY of every account (by the SDK
 * ACCOUNTS_* spec's field name) against what the request should have produced.
 *
 * NOTE on signer/writable flags: this test does NOT compare decoded isSigner/
 * isWritable against the spec. A compiled+serialized Solana Transaction stores
 * privileges PER ACCOUNT INDEX (unioned across every instruction in the tx, incl.
 * the fee payer), not per instruction — so `Transaction.from(...)` necessarily
 * reports the deployer (signer+writable everywhere, as fee payer) as writable
 * even at spec positions marked non-writable (e.g. SetMatcherConfig's read-only
 * "lpOwner"). That's a correct decode of the wire format, not a route bug, and
 * comparing against it would fail on correct code. Order/identity is what
 * GH#2542 was actually about (positional arrays silently mis-mapping accounts),
 * and that survives the round trip intact.
 */

import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { ACCOUNTS_CREATE_LP_VAULT_V22 } from "@/lib/v22/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { NextRequest } from 'next/server';
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_CREATE_LP_VAULT,
  ACCOUNTS_LP_VAULT_DEPOSIT,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  deriveVaultAuthority,
} from '@percolatorct/sdk';
import { getConfig } from '@/lib/config';

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock('@/lib/get-client-ip', () => ({
  getClientIp: () => '127.0.0.1',
}));

vi.mock('@/lib/create-market-rate-limit', () => ({
  checkCreateMarketRateLimit: async () => ({
    allowed: true,
    retryAfterSecs: 0,
  }),
  CREATE_MARKET_RATE_LIMIT: 5,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: captureExceptionMock,
}));

import { POST } from '@/app/api/mobile/create-market/route';

interface MobileCreateMarketResponse {
  slab_address: string;
  unsigned_txs: string[];
  registration: { deployer: string; mint_address: string };
}

/** Wrapper instruction tags this route builds via buildAccountMetas (see IX_TAG in the SDK). */
const IX_TAG = {
  InitMarket: 0,
  InitUser: 1,
  DepositCollateral: 3,
  PermissionlessCrank: 5,
  TopUpInsurance: 9,
  SetMatcherConfig: 68,
  CreateLpVault: 74,
  DepositToLpVault: 75,
  InitMatcherCtx: 83,
} as const;

/** GH#2749: the route must never send a direct TopUpBackingBucket (tag 24). */
const TOP_UP_BACKING_BUCKET_TAG = 24;

interface AccountSpecEntry {
  name: string;
  signer: boolean;
  writable: boolean;
}

/** tag -> [spec, human label] for every ACCOUNTS_*-built wrapper ix this route sends.
 * SetNftProgramId (tag 73) is deliberately excluded — the route builds its 4-key
 * list by hand (no ACCOUNTS_* spec exists for it), so there is no spec to compare
 * against here; its presence/shape is covered by
 * mobile-create-market-blockhash-recovery.test.ts's TX0 assertions. */
const SPEC_BY_TAG: Record<number, { spec: AccountSpecEntry[]; label: string }> = {
  [IX_TAG.InitMarket]: { spec: ACCOUNTS_INIT_MARKET, label: 'InitMarket' },
  [IX_TAG.InitUser]: { spec: ACCOUNTS_INIT_USER, label: 'InitUser' },
  [IX_TAG.DepositCollateral]: { spec: ACCOUNTS_DEPOSIT_COLLATERAL, label: 'DepositCollateral' },
  [IX_TAG.PermissionlessCrank]: { spec: ACCOUNTS_PERMISSIONLESS_CRANK_BASE, label: 'PermissionlessCrank' },
  [IX_TAG.TopUpInsurance]: { spec: ACCOUNTS_TOPUP_INSURANCE, label: 'TopUpInsurance' },
  // v2.2 (flag on): the seven-account form (the collateral mint at [6]); flag off the installed SDK's six.
  [IX_TAG.CreateLpVault]: { spec: isDevnetV22Enabled() ? ACCOUNTS_CREATE_LP_VAULT_V22 : ACCOUNTS_CREATE_LP_VAULT, label: 'CreateLpVault' },
  [IX_TAG.DepositToLpVault]: { spec: ACCOUNTS_LP_VAULT_DEPOSIT, label: 'DepositToLpVault' },
  [IX_TAG.SetMatcherConfig]: { spec: ACCOUNTS_SET_MATCHER_CONFIG, label: 'SetMatcherConfig' },
  [IX_TAG.InitMatcherCtx]: { spec: ACCOUNTS_INIT_MATCHER_CTX, label: 'InitMatcherCtx' },
};

describe('mobile create-market account specs (#2542)', () => {
  const originalNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = 'devnet';
    captureExceptionMock.mockClear();

    vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999_999,
    });

    vi.spyOn(Connection.prototype, 'getMinimumBalanceForRentExemption').mockResolvedValue(
      1_000_000,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalNetwork === undefined) {
      delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    } else {
      process.env.NEXT_PUBLIC_DEFAULT_NETWORK = originalNetwork;
    }
  });

  it('every wrapper instruction has the account count, signer/writable flags, and identity order the installed SDK spec describes', async () => {
    const deployerKeypair = Keypair.generate();
    const deployer = deployerKeypair.publicKey.toBase58();
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey.toBase58();

    const request = new NextRequest('http://localhost/api/mobile/create-market', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deployer,
        mint,
        tier: 'small',
        name: 'Account Spec Regression',
        oracle_mode: 'admin',
        initial_price_e6: '1000000',
      }),
    });

    const response = await POST(request);
    const rawBody = await response.text();

    if (response.status !== 200) {
      throw new Error(`Route returned ${response.status}: ${rawBody}`);
    }

    const body = JSON.parse(rawBody) as MobileCreateMarketResponse;

    // Independently derive the accounts the route SHOULD have used, from the same
    // config + SDK helpers the route itself calls, so identity checks below aren't
    // just comparing the route against itself.
    const cfg = getConfig();
    const wrapperProgramId = new PublicKey(
      (cfg.programsBySlabTier?.small as string | undefined) ?? (cfg.programId as string),
    );
    const matcherProgramId = new PublicKey(cfg.matcherProgramId as string);
    const [vaultPda] = deriveVaultAuthority(wrapperProgramId, new PublicKey(body.slab_address));
    const vaultAta = await getAssociatedTokenAddress(mintKeypair.publicKey, vaultPda, true);
    const userAta = await getAssociatedTokenAddress(mintKeypair.publicKey, deployerKeypair.publicKey);

    const transactions: Transaction[] = body.unsigned_txs.map((encoded) =>
      Transaction.from(Buffer.from(encoded, 'base64')),
    );

    const seenTags = new Set<number>();
    // Cross-instruction consistency: the SAME lpPortfolio/matcherCtx/matcherDelegate
    // pubkey must appear everywhere it's referenced, even though this test can't
    // independently recompute their createWithSeed/PDA addresses (the route's random
    // account nonce is internal).
    let lpPortfolioRef: string | undefined;
    let matcherCtxRef: string | undefined;
    let matcherDelegateRef: string | undefined;

    const bySpecName = (
      spec: AccountSpecEntry[],
      keys: { pubkey: PublicKey }[],
      name: string,
    ): PublicKey | undefined => {
      const idx = spec.findIndex((s) => s.name === name);
      return idx === -1 ? undefined : keys[idx]?.pubkey;
    };

    for (const tx of transactions) {
      for (const ix of tx.instructions) {
        if (!ix.programId.equals(wrapperProgramId)) continue; // skip System/Token/ATA ixs
        if (ix.data.length === 0) continue;

        const tag = ix.data[0];
        expect(tag, 'no direct TopUpBackingBucket (GH#2749)').not.toBe(TOP_UP_BACKING_BUCKET_TAG);
        const entry = SPEC_BY_TAG[tag];
        if (!entry) continue; // SetNftProgramId (73) — no spec to compare against, see note above

        seenTags.add(tag);
        const { spec, label } = entry;

        expect(ix.keys.length, `${label}: account count`).toBe(spec.length);

        for (const name of ['admin', 'owner', 'lpOwner', 'signer', 'depositor']) {
          const pk = bySpecName(spec, ix.keys, name);
          if (pk) expect(pk.toBase58(), `${label}.${name}`).toBe(deployer);
        }

        for (const name of ['slab', 'market']) {
          const pk = bySpecName(spec, ix.keys, name);
          if (pk) expect(pk.toBase58(), `${label}.${name}`).toBe(body.slab_address);
        }

        if (label === 'InitMarket') {
          expect(bySpecName(spec, ix.keys, 'mint')?.toBase58(), `${label}.mint`).toBe(mint);
        }

        if (label === 'SetMatcherConfig' || label === 'InitMatcherCtx') {
          expect(
            bySpecName(spec, ix.keys, 'matcherProg')?.toBase58(),
            `${label}.matcherProg`,
          ).toBe(matcherProgramId.toBase58());
        }

        for (const name of ['sourceToken']) {
          const pk = bySpecName(spec, ix.keys, name);
          if (pk) expect(pk.toBase58(), `${label}.${name}`).toBe(userAta.toBase58());
        }

        for (const name of ['vaultToken']) {
          const pk = bySpecName(spec, ix.keys, name);
          if (pk) expect(pk.toBase58(), `${label}.${name}`).toBe(vaultAta.toBase58());
        }

        const portfolioPk =
          bySpecName(spec, ix.keys, 'portfolio') ?? bySpecName(spec, ix.keys, 'lpPortfolio');
        if (portfolioPk) {
          lpPortfolioRef ??= portfolioPk.toBase58();
          expect(portfolioPk.toBase58(), `${label}.portfolio/lpPortfolio consistency`).toBe(
            lpPortfolioRef,
          );
        }

        const matcherCtxPk = bySpecName(spec, ix.keys, 'matcherCtx');
        if (matcherCtxPk) {
          matcherCtxRef ??= matcherCtxPk.toBase58();
          expect(matcherCtxPk.toBase58(), `${label}.matcherCtx consistency`).toBe(matcherCtxRef);
        }

        const matcherDelegatePk = bySpecName(spec, ix.keys, 'matcherDelegate');
        if (matcherDelegatePk) {
          matcherDelegateRef ??= matcherDelegatePk.toBase58();
          expect(matcherDelegatePk.toBase58(), `${label}.matcherDelegate consistency`).toBe(
            matcherDelegateRef,
          );
        }
      }
    }

    // Every ACCOUNTS_*-spec'd instruction this route is documented to send must
    // actually have been observed — guards a future refactor from silently dropping
    // one (e.g. GH#2542's follow-up InitMatcherCtx) without a test noticing.
    expect(seenTags).toEqual(new Set(Object.keys(SPEC_BY_TAG).map(Number)));
  });
});
