// @vitest-environment node
/**
 * Council 2026-11-06-go1106-ux, First-timer (low) + Clerk (med): "The modal says '1 claim per wallet per day', but
 * about a minute after the modal claim, the /faucet page let me claim another 10,000 (balance 20,000), then said
 * 'Next claim: ... (1 hour)'." Mint txs 2tzysWCo... (06:51:12Z) and 3MadPBz8... 58 s apart, same wallet.
 *
 * Cause: the modal mints through /api/faucet (faucet_claims slot "usdc", 24h) and /faucet through
 * /api/playground/faucet (its own "playground-faucet" slot, 1h). Two gates, so one wallet got two claims.
 * Both routes now take the ONE Sim-USDC daily slot. Harness: playground-faucet-unresolved-claim.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  class ServerSignatureExecutionError extends Error {
    readonly signature: string;
    readonly transactionError: unknown;
    constructor(signature: string, transactionError: unknown) {
      super(`Transaction failed: ${JSON.stringify(transactionError)}`);
      this.name = 'ServerSignatureExecutionError';
      this.signature = signature;
      this.transactionError = transactionError;
    }
  }
  class ServerSignatureTimeoutError extends Error {
    readonly signature: string;
    readonly timeoutMs: number;
    constructor(signature: string, timeoutMs: number) {
      super(`Transaction ${signature} not confirmed within ${timeoutMs}ms`);
      this.name = 'ServerSignatureTimeoutError';
      this.signature = signature;
      this.timeoutMs = timeoutMs;
    }
  }
  return {
    ServerSignatureExecutionError,
    ServerSignatureTimeoutError,
    confirmServerSignature: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getBalance: vi.fn(),
    getAccount: vi.fn(),
    getAssociatedTokenAddress: vi.fn(),
    getDevnetMintSigner: vi.fn(),
    tryFaucetGate: vi.fn(),
    releaseFaucetClaim: vi.fn(),
    captureException: vi.fn(),
    checkFundRateLimit: vi.fn(),
    getClientIp: vi.fn(),
    serviceClient: { marker: 'service-client' },
  };
});

vi.mock('@/lib/config', () => ({
  getNetwork: () => 'devnet',
  getRpcEndpoint: () => 'https://api.devnet.solana.com',
}));
vi.mock('@/lib/get-client-ip', () => ({ getClientIp: mocks.getClientIp }));
vi.mock('@/lib/fund-ip-rate-limit', () => ({ checkFundRateLimit: mocks.checkFundRateLimit }));
vi.mock('@/lib/server-rpc', () => ({
  confirmServerSignature: mocks.confirmServerSignature,
  getServerConnection: () => ({
    getLatestBlockhash: mocks.getLatestBlockhash,
    sendRawTransaction: mocks.sendRawTransaction,
    getBalance: mocks.getBalance,
  }),
  ServerSignatureExecutionError: mocks.ServerSignatureExecutionError,
  ServerSignatureTimeoutError: mocks.ServerSignatureTimeoutError,
}));
vi.mock('@/lib/devnet-signer', () => ({ getDevnetMintSigner: mocks.getDevnetMintSigner }));
vi.mock('@/lib/supabase', () => ({ getServiceClient: () => mocks.serviceClient }));
vi.mock('@/lib/faucet-rate-gate', () => ({
  tryFaucetGate: mocks.tryFaucetGate,
  releaseFaucetClaim: mocks.releaseFaucetClaim,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/lib/transaction-confirmation', () => ({ assertSuccessfulConfirmation: vi.fn() }));
vi.mock('@solana/web3.js', () => {
  class PublicKey {
    constructor(private readonly value: unknown) {}
    toBase58(): string {
      return String(this.value);
    }
  }
  class Transaction {
    recentBlockhash?: string;
    feePayer?: PublicKey;
    add(): this {
      return this;
    }
    serialize(): Buffer {
      return Buffer.from([]);
    }
  }
  class Connection {}
  class SendTransactionError extends Error {
    constructor({ transactionMessage }: { transactionMessage: string }) {
      super(transactionMessage);
    }
  }
  return { Connection, PublicKey, Transaction, SendTransactionError, LAMPORTS_PER_SOL: 1_000_000_000 };
});
vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: mocks.getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction: vi.fn(),
  createMintToInstruction: vi.fn(),
  getAccount: mocks.getAccount,
  TOKEN_PROGRAM_ID: { toBase58: () => 'TokenProgram111' },
}));

function requestFor(wallet: string): NextRequest {
  return new NextRequest('http://localhost/api/playground/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = 'devnet';
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  mocks.getClientIp.mockReturnValue('203.0.113.10');
  mocks.checkFundRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 77 });
  mocks.releaseFaucetClaim.mockResolvedValue(undefined);
  mocks.getDevnetMintSigner.mockReturnValue({
    publicKey: () => 'MintAuthority1111111111111111111111111111',
    signTransaction: (tx: unknown) => tx,
  });
  mocks.getAssociatedTokenAddress.mockResolvedValue({ toBase58: () => 'Ata111111111111111111111111111111111111' });
  mocks.getAccount.mockResolvedValue({});
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: 'finalized-blockhash' });
  mocks.sendRawTransaction.mockResolvedValue('original-usdc-signature');
  mocks.confirmServerSignature.mockResolvedValue('original-usdc-signature');
  mocks.getBalance.mockResolvedValue(0);
});

describe('POST /api/playground/faucet: a wallet that already holds SOL is not told the airdrop was skipped', () => {
  it('reports sol_has_enough (and sends nothing) when the wallet already has fee SOL', async () => {
    mocks.getBalance.mockResolvedValue(1.9 * 1_000_000_000); // the First-timer's wallet: 1.9 SOL
    const { POST } = await import('@/app/api/playground/faucet/route');
    const body = await (await POST(requestFor('WalletRichSol11111111111111111111111111111'))).json();
    expect(body.sol_has_enough).toBe(true);
    expect(body.sol_airdropped).toBe(false);
    expect(body.sol_amount).toBe(0);
  });

  it('an empty wallet is not reported as having enough', async () => {
    mocks.getBalance.mockResolvedValue(0);
    const { POST } = await import('@/app/api/playground/faucet/route');
    const body = await (await POST(requestFor('WalletNoSol111111111111111111111111111111'))).json();
    expect(body.sol_has_enough).toBeUndefined();
  });
});

describe('POST /api/playground/faucet: one Sim-USDC claim per wallet per day, shared with the modal', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('reserves the same faucet_claims slot as /api/faucet type=usdc, with a 24h window', async () => {
    const { SIM_USDC_CLAIM_FUND_TYPE, SIM_USDC_CLAIM_WINDOW_MS } = await import('@/lib/sim-usdc-claim');
    expect(SIM_USDC_CLAIM_FUND_TYPE).toBe('usdc');
    expect(SIM_USDC_CLAIM_WINDOW_MS).toBe(DAY_MS);

    const { POST } = await import('@/app/api/playground/faucet/route');
    await POST(requestFor('WalletShared11111111111111111111111111111'));
    expect(mocks.tryFaucetGate).toHaveBeenCalledWith(
      mocks.serviceClient,
      'WalletShared11111111111111111111111111111',
      'usdc',
      DAY_MS,
    );
  });

  it('a wallet that claimed in the modal is refused here, told when, and told it is per day', async () => {
    const next = new Date(Date.now() + DAY_MS - 60_000).toISOString();
    mocks.tryFaucetGate.mockResolvedValueOnce({ allowed: false, nextClaimAt: next });

    const { POST } = await import('@/app/api/playground/faucet/route');
    const response = await POST(requestFor('WalletModal111111111111111111111111111111'));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.nextClaimAt).toBe(next);
    expect(body.error).toMatch(/once per wallet per day|today/i);
    expect(body.error).not.toMatch(/hour/i);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a successful claim names a next claim about 24h away (was 1h)', async () => {
    const { POST } = await import('@/app/api/playground/faucet/route');
    const before = Date.now();
    const response = await POST(requestFor('WalletFresh1111111111111111111111111111111'));
    const body = await response.json();

    expect(response.status).toBe(200);
    const nextMs = new Date(body.nextClaimAt).getTime();
    expect(nextMs - before).toBeGreaterThan(DAY_MS - 60_000);
    expect(nextMs - before).toBeLessThan(DAY_MS + 60_000);
  });

  it('without Supabase, the in-memory fallback is shared too: a modal claim blocks this route', async () => {
    mocks.tryFaucetGate.mockRejectedValue(new Error('supabase down'));
    const sim = await import('@/lib/sim-usdc-claim');
    sim.recordSimUsdcClaimInMemory('WalletMemory11111111111111111111111111111');

    const { POST } = await import('@/app/api/playground/faucet/route');
    const response = await POST(requestFor('WalletMemory11111111111111111111111111111'));

    expect(response.status).toBe(429);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });
});
