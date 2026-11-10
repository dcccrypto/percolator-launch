// @vitest-environment node
/**
 * R3 M8, "Faucet daily limit not enforced on the preview": the same wallet claimed 10,000 USDC twice ~1 min apart
 * with no database configured (process-local limiter, reset per serverless instance). With no durable gate the
 * route now reads the wallet's Sim-USDC ATA history: a recent faucet mint (10,000 mintTo to that ATA, paid by the
 * mint authority) is a claim; an unreadable or undecidable history fails closed. Harness copied from
 * playground-faucet-daily-limit.test.ts.
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
    getSignaturesForAddress: vi.fn(),
    getParsedTransactions: vi.fn(),
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
    getSignaturesForAddress: mocks.getSignaturesForAddress,
    getParsedTransactions: mocks.getParsedTransactions,
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
    // N4: the claim-marker derivation; a stable fake address is enough for these mocks.
    static async createWithSeed(_b: unknown, seed: string): Promise<PublicKey> {
      return new PublicKey(`marker-${seed}`);
    }
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
  const SystemProgram = { programId: new PublicKey('11111111111111111111111111111111'), createAccountWithSeed: () => ({}) };
  return { SystemProgram, Connection, PublicKey, Transaction, SendTransactionError, LAMPORTS_PER_SOL: 1_000_000_000 };
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

const MINT_AUTH = 'MintAuthority1111111111111111111111111111';
const WALLET = 'WalletNoDb1111111111111111111111111111111';
const DAY_MS = 24 * 60 * 60 * 1000;

const ATA = 'Ata111111111111111111111111111111111111';
function mintToIx(amount: string) {
  return { program: 'spl-token', parsed: { type: 'mintTo', info: { account: ATA, amount } } };
}

/** A tiny on-chain ledger: mints sent by the route show up in the ATA's history. */
function chain() {
  const landed: { signature: string; blockTime: number; err: unknown }[] = [];
  mocks.sendRawTransaction.mockImplementation(async () => {
    const signature = `mint-sig-${landed.length + 1}`;
    landed.unshift({ signature, blockTime: Math.floor(Date.now() / 1000), err: null });
    return signature;
  });
  mocks.getSignaturesForAddress.mockImplementation(async () => landed.map((l) => ({ ...l, slot: 1, memo: null })));
  mocks.getParsedTransactions.mockImplementation(async (sigs: string[]) =>
    sigs.map((sig) => ({
      transaction: {
        message: {
          accountKeys: [{ pubkey: { toBase58: () => MINT_AUTH } }],
          instructions: [mintToIx(sig.startsWith('autofund') ? '1000000000' : '10000000000')],
        },
      },
    })),
  );
  return landed;
}
/** What a fresh serverless instance looks like: an empty process-local map. */
function newInstance() {
  delete (globalThis as unknown as Record<string, unknown>).__percolatorSimUsdcClaims__;
}

describe('R3 M8: with no durable DB, the daily claim limit is still true', () => {
  beforeEach(() => {
    newInstance();
    mocks.tryFaucetGate.mockRejectedValue(new Error('Supabase env vars not set'));
  });

  it('first claim works; a second from another instance is refused with the real next-claim time', async () => {
    const landed = chain();
    const { POST } = await import('@/app/api/playground/faucet/route');

    const first = await POST(requestFor(WALLET));
    expect(first.status).toBe(200);
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);

    newInstance(); // cold start / different warm instance
    const second = await POST(requestFor(WALLET));
    const body = await second.json();
    expect(second.status).toBe(429);
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(body.error).toMatch(/once per wallet per day/);
    const expected = landed[0].blockTime * 1000 + DAY_MS;
    expect(new Date(body.nextClaimAt).getTime()).toBe(expected);
  });

  it('a mint older than 24h does not block a new claim', async () => {
    const landed = chain();
    landed.unshift({ signature: 'old', blockTime: Math.floor((Date.now() - DAY_MS - 3_600_000) / 1000), err: null });
    const { POST } = await import('@/app/api/playground/faucet/route');
    expect((await POST(requestFor(WALLET))).status).toBe(200);
  });

  it('fails closed (nothing minted) when the chain history cannot be read', async () => {
    chain();
    mocks.getSignaturesForAddress.mockRejectedValue(new Error('rpc down'));
    const { POST } = await import('@/app/api/playground/faucet/route');
    const res = await POST(requestFor(WALLET));
    expect(res.status).toBe(503);
    expect((await res.json()).retryable).toBe(true);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a failed mint does not burn the claim (retry still works)', async () => {
    chain();
    mocks.sendRawTransaction.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import('@/app/api/playground/faucet/route');
    expect((await POST(requestFor(WALLET))).status).toBe(503);
    newInstance();
    chain();
    expect((await POST(requestFor(WALLET))).status).toBe(200);
  });
});

describe('R3 M8 (review H1/L1): content-based claim detection and honest failures', () => {
  beforeEach(() => {
    newInstance();
    mocks.tryFaucetGate.mockRejectedValue(new Error('Supabase env vars not set'));
  });

  it('an auto-fund mint (1,000, same fee payer) is NOT a claim: the first faucet claim still works', async () => {
    const landed = chain();
    landed.unshift({ signature: 'autofund-1', blockTime: Math.floor(Date.now() / 1000), err: null });
    const { POST } = await import('@/app/api/playground/faucet/route');
    expect((await POST(requestFor(WALLET))).status).toBe(200);
    expect(mocks.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('a full in-window page the route cannot decide is refused with honest, non-retryable copy', async () => {
    chain();
    const now = Math.floor(Date.now() / 1000);
    mocks.getSignaturesForAddress.mockImplementation(async () =>
      Array.from({ length: 40 }, (_, i) => ({ signature: `autofund-${i}`, blockTime: now - i, err: null, slot: 1, memo: null })),
    );
    const { POST } = await import('@/app/api/playground/faucet/route');
    const res = await POST(requestFor(WALLET));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.retryable).toBe(false);
    expect(body.error).not.toMatch(/try again in a moment/i);
    expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('with a healthy durable gate the chain is not queried', async () => {
    mocks.tryFaucetGate.mockResolvedValue({ allowed: true, nextClaimAt: null, claimId: 5 });
    chain();
    const { POST } = await import('@/app/api/playground/faucet/route');
    expect((await POST(requestFor(WALLET))).status).toBe(200);
    expect(mocks.getSignaturesForAddress).not.toHaveBeenCalled();
    expect(mocks.getParsedTransactions).not.toHaveBeenCalled();
  });
});
