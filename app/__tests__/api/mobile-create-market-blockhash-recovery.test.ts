// @vitest-environment node

/**
 * Regression coverage for issue #2400.
 *
 * Every transaction returned by the mobile create-market route must remain
 * recoverable after recentBlockhash expiry without requiring unavailable
 * server-generated account signatures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { NextRequest } from 'next/server';

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
  last_valid_block_height: number;
  registration: {
    slab_address: string;
    deployer: string;
    mint_address: string;
  };
}

function findCreateWithSeedInstruction(transaction: Transaction) {
  return transaction.instructions.find((instruction) => {
    if (!instruction.programId.equals(SystemProgram.programId)) {
      return false;
    }

    try {
      return SystemInstruction.decodeInstructionType(instruction) === 'CreateWithSeed';
    } catch {
      return false;
    }
  });
}

describe('mobile create-market blockhash recovery (#2400)', () => {
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

  it('allows every transaction to be refreshed and signed by the deployer only', async () => {
    const deployerKeypair = Keypair.generate();
    const deployer = deployerKeypair.publicKey.toBase58();

    const mint = Keypair.generate().publicKey.toBase58();

    const request = new NextRequest('http://localhost/api/mobile/create-market', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        deployer,
        mint,
        tier: 'small',
        name: 'Blockhash Recovery Regression',
        oracle_mode: 'admin',
        initial_price_e6: '1000000',
      }),
    });

    const response = await POST(request);
    const rawBody = await response.text();

    if (response.status !== 200) {
      const captured = captureExceptionMock.mock.calls.at(-1)?.[0];

      console.error('\n=== CAPTURED ROUTE ERROR ===');

      if (captured instanceof Error) {
        console.error(captured.stack ?? captured.message);
      } else {
        console.error(captured);
      }

      console.error('=== END CAPTURED ROUTE ERROR ===\n');
    }

    expect(response.status, `Unexpected route response: ${rawBody}`).toBe(200);

    const body = JSON.parse(rawBody) as MobileCreateMarketResponse;

    expect(body.unsigned_txs).toHaveLength(4);
    expect(body.last_valid_block_height).toBe(999_999);

    expect(body.registration.deployer).toBe(deployer);
    expect(body.registration.mint_address).toBe(mint);
    expect(body.registration.slab_address).toBe(body.slab_address);

    const transactions = body.unsigned_txs.map((encoded) =>
      Transaction.from(Buffer.from(encoded, 'base64')),
    );

    const createdAccounts: string[] = [];

    for (const [index, transaction] of transactions.entries()) {
      const originalBlockhash = transaction.recentBlockhash;

      const accountKeysBeforeRefresh = transaction
        .compileMessage()
        .accountKeys.map((key) => key.toBase58());

      /**
       * Every transaction must require exactly one signer:
       * the mobile deployer.
       */
      expect(transaction.signatures).toHaveLength(1);

      const [requiredSigner] = transaction.signatures;

      expect(requiredSigner.publicKey.toBase58()).toBe(deployer);

      /**
       * The route must not pre-populate a server signature.
       */
      expect(requiredSigner.signature).toBeNull();

      expect(accountKeysBeforeRefresh).toContain(body.slab_address);

      /**
       * TX0-TX2 create the slab, LP portfolio, and matcher
       * context through CreateAccountWithSeed.
       *
       * TX3 does not create a new system account.
       */
      const createWithSeedInstruction = findCreateWithSeedInstruction(transaction);

      if (index < 3) {
        expect(createWithSeedInstruction).toBeDefined();

        if (!createWithSeedInstruction) {
          throw new Error(`TX${index} is missing CreateWithSeed`);
        }

        const decoded = SystemInstruction.decodeCreateWithSeed(createWithSeedInstruction);

        /**
         * The deployer is both the funding account and the
         * base authority. No server account signer is needed.
         */
        expect(decoded.fromPubkey.toBase58()).toBe(deployer);

        expect(decoded.basePubkey.toBase58()).toBe(deployer);

        /**
         * randomBytes(12) produces 24 hex characters.
         * The prefix identifies each derived account type.
         */
        expect(decoded.seed).toMatch(/^[spm]-[0-9a-f]{24}$/);

        expect(Buffer.byteLength(decoded.seed, 'utf8')).toBeLessThanOrEqual(32);

        const expectedPrefix = ['s-', 'p-', 'm-'][index];

        expect(decoded.seed.startsWith(expectedPrefix)).toBe(true);

        /**
         * Verify that the system instruction creates exactly
         * the address derived from base + seed + program ID.
         */
        const expectedCreatedAddress = await PublicKey.createWithSeed(
          deployerKeypair.publicKey,
          decoded.seed,
          decoded.programId,
        );

        expect(decoded.newAccountPubkey.toBase58()).toBe(expectedCreatedAddress.toBase58());

        createdAccounts.push(decoded.newAccountPubkey.toBase58());
      } else {
        expect(createWithSeedInstruction).toBeUndefined();
      }

      let refreshedBlockhash = Keypair.generate().publicKey.toBase58();

      while (refreshedBlockhash === originalBlockhash) {
        refreshedBlockhash = Keypair.generate().publicKey.toBase58();
      }

      /**
       * Simulate recovery after the original blockhash
       * expires.
       */
      transaction.recentBlockhash = refreshedBlockhash;

      transaction.sign(deployerKeypair);

      /**
       * The rebuilt transaction must be fully valid with the
       * deployer signature alone.
       */
      expect(transaction.verifySignatures()).toBe(true);

      expect(transaction.signatures[0].signature).not.toBeNull();

      /**
       * Refreshing the blockhash must not change any account
       * address or instruction account.
       */
      expect(transaction.compileMessage().accountKeys.map((key) => key.toBase58())).toEqual(
        accountKeysBeforeRefresh,
      );

      console.log(`TX${index}: refreshed and signed by deployer only`);
    }

    /**
     * Exactly three unique system accounts must be created:
     * slab, LP portfolio, and matcher context.
     */
    expect(createdAccounts).toHaveLength(3);
    expect(new Set(createdAccounts).size).toBe(3);

    expect(createdAccounts[0]).toBe(body.slab_address);

    /**
     * No private signer material may be exposed.
     */
    expect(body).not.toHaveProperty('signers');
    expect(body).not.toHaveProperty('private_keys');
    expect(body).not.toHaveProperty('secret_keys');
  });
});
