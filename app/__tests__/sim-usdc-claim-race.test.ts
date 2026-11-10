// @vitest-environment node
/**
 * Council r4 N4 (R3-5): with no durable gate, two concurrent claims from one wallet were both admitted (30 ms apart,
 * one read-then-mint window). They only avoided a double mint because both built the same tx signature; across a
 * blockhash change both mint. The fix is a per-(wallet, UTC day) marker account created inside the claim tx (atomic
 * on chain, no program change) plus a per-wallet in-flight lock per instance.
 *
 * The fake chain below executes the marker semantics the System program has: createAccountWithSeed to an address
 * that already exists fails the whole tx; otherwise it creates the account and the mint counts. Each request gets a
 * DIFFERENT blockhash (different signature), which is the case the old code could not survive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair, Transaction } from '@solana/web3.js';

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
  class ServerSignatureTimeoutError extends Error {}
  return {
    ServerSignatureExecutionError,
    ServerSignatureTimeoutError,
    confirmServerSignature: vi.fn(),
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    getBalance: vi.fn(),
    getSignaturesForAddress: vi.fn(),
    getParsedTransactions: vi.fn(),
    tryFaucetGate: vi.fn(),
    releaseFaucetClaim: vi.fn(),
    checkFundRateLimit: vi.fn(),
    mintAddr: { current: '' },
    mintAuthority: { current: null as null | Uint8Array },
    signer: { current: null as null | { publicKey: () => string; signTransaction: (t: Transaction) => Transaction } },
  };
});

vi.mock('@/lib/config', async (orig) => ({
  ...(await orig<typeof import('@/lib/config')>()),
  getConfig: () => ({ testUsdcMint: mocks.mintAddr.current }),
  getNetwork: () => 'devnet',
  getRpcEndpoint: () => 'https://api.devnet.solana.com',
}));
vi.mock('@/lib/get-client-ip', () => ({ getClientIp: () => '203.0.113.10' }));
vi.mock('@/lib/fund-ip-rate-limit', () => ({ checkFundRateLimit: mocks.checkFundRateLimit }));
vi.mock('@/lib/server-rpc', () => ({
  confirmServerSignature: mocks.confirmServerSignature,
  getServerConnection: () => ({
    getLatestBlockhash: mocks.getLatestBlockhash,
    sendRawTransaction: mocks.sendRawTransaction,
    getBalance: mocks.getBalance,
    getSignaturesForAddress: mocks.getSignaturesForAddress,
    getParsedTransactions: mocks.getParsedTransactions,
    getAccountInfo: async () => {
      // Sim-USDC mint account: coption(u32)=1 then the mint authority (the faucet signer).
      const data = new Uint8Array(82);
      data[0] = 1;
      data.set(mocks.mintAuthority.current ?? new Uint8Array(32), 4);
      return { data };
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatus: async () => ({ value: null }),
    getMinimumBalanceForRentExemption: async () => 890_880,
  }),
  ServerSignatureExecutionError: mocks.ServerSignatureExecutionError,
  ServerSignatureTimeoutError: mocks.ServerSignatureTimeoutError,
}));
vi.mock('@/lib/devnet-signer', () => ({ getDevnetMintSigner: () => mocks.signer.current }));
vi.mock('@/lib/supabase', () => ({ getServiceClient: () => ({}) }));
vi.mock('@/lib/faucet-rate-gate', () => ({ tryFaucetGate: mocks.tryFaucetGate, releaseFaucetClaim: mocks.releaseFaucetClaim }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@solana/web3.js', async (orig) => {
  const actual = await orig<typeof import('@solana/web3.js')>();
  class Connection {
    async requestAirdrop(): Promise<string> {
      throw new Error('no network in tests');
    }
  }
  return { ...actual, Connection };
});

const WALLET = Keypair.generate().publicKey.toBase58();
const LOCK_KEY = '__percolatorSimUsdcClaimLocks__';
const g = globalThis as unknown as Record<string, unknown>;

/** The fake chain: accounts that exist, and the mints that landed. */
let accounts: Set<string>;
let mints: string[];
let blockhashCounter: number;

function chain() {
  accounts = new Set();
  mints = [];
  blockhashCounter = 0;
  const gateStart: { release: () => void; promise: Promise<void> } = (() => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { release, promise };
  })();
  mocks.getSignaturesForAddress.mockResolvedValue([]);
  mocks.getParsedTransactions.mockResolvedValue([]);
  mocks.getLatestBlockhash.mockImplementation(async () => {
    // Every request parks here until both are in flight: the race window.
    await gateStart.promise;
    blockhashCounter += 1;
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 + blockhashCounter };
  });
  mocks.sendRawTransaction.mockImplementation(async (raw: Buffer) => {
    const tx = Transaction.from(raw);
    // A marker create is the System program's instruction 0 (createAccountWithSeed: new account is key 1).
    const first = tx.instructions[0];
    const isMarker = first.programId.toBase58() === '11111111111111111111111111111111' && first.keys.length === 2 && first.data.length > 4;
    if (isMarker) {
      const marker = first.keys[1].pubkey.toBase58();
      if (accounts.has(marker)) throw new Error(`Simulation failed: Allocate: account Address { address: ${marker} } already in use`);
      accounts.add(marker);
    }
    const sig = `sig-${mints.length + 1}`;
    mints.push(sig);
    return sig;
  });
  mocks.confirmServerSignature.mockImplementation(async (_c: unknown, sig: string) => sig);
  return gateStart;
}

function reqFor(route: 'faucet' | 'playground', wallet: string): NextRequest {
  const url = route === 'faucet' ? 'http://localhost/api/faucet' : 'http://localhost/api/playground/faucet';
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(route === 'faucet' ? { wallet, type: 'usdc' } : { wallet }),
  });
}

async function post(route: 'faucet' | 'playground', wallet: string): Promise<Response> {
  const mod =
    route === 'faucet' ? await import('@/app/api/faucet/route') : await import('@/app/api/playground/faucet/route');
  return mod.POST(reqFor(route, wallet));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = 'devnet';
  delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  delete g.__percolatorSimUsdcClaims__;
  delete g[LOCK_KEY];
  mocks.checkFundRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.tryFaucetGate.mockRejectedValue(new Error('Supabase env vars not set')); // no durable gate
  mocks.getBalance.mockResolvedValue(0);
  const kp = Keypair.generate(); // throwaway test key, never a real faucet key
  mocks.mintAddr.current = Keypair.generate().publicKey.toBase58();
  mocks.mintAuthority.current = kp.publicKey.toBytes();
  mocks.signer.current = {
    publicKey: () => kp.publicKey.toBase58(),
    signTransaction: (t: Transaction) => {
      t.partialSign(kp);
      return t;
    },
  };
});

/** Start two claims 30 ms apart; the second looks like a different serverless instance (no shared lock). */
async function parkedAt(calls: number): Promise<void> {
  for (let i = 0; i < 400 && mocks.getLatestBlockhash.mock.calls.length < calls; i++) await new Promise((r) => setTimeout(r, 5));
  expect(mocks.getLatestBlockhash.mock.calls.length).toBeGreaterThanOrEqual(calls);
}

async function twoInstancesRace(route: 'faucet' | 'playground') {
  const gate = chain();
  await Promise.all([import('@/app/api/faucet/route'), import('@/app/api/playground/faucet/route')]);
  const first = post(route, WALLET);
  await parkedAt(1); // request 1 has read the (empty) history and is building its tx
  delete g[LOCK_KEY]; // second request lands on another instance: layer 1 cannot see the first
  const second = post(route, WALLET);
  await parkedAt(2);
  gate.release();
  return Promise.all([first, second]);
}

describe('N4: concurrent claims from one wallet with no durable gate', () => {
  for (const route of ['playground', 'faucet'] as const) {
    it(`/${route}: two claims on different instances with different blockhashes mint exactly once`, async () => {
      const [a, b] = await twoInstancesRace(route);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 429]);
      expect(mints).toHaveLength(1);
      const loser = a.status === 429 ? a : b;
      expect((await loser.json()).error).toMatch(/once per wallet per day/);
    });
  }

  it('the marker also stops a later claim on another instance even if chain history is lagging', async () => {
    const gate = chain();
    gate.release();
    expect((await post('playground', WALLET)).status).toBe(200);
    delete g[LOCK_KEY];
    delete g.__percolatorSimUsdcClaims__;
    const again = await post('faucet', WALLET);
    expect(again.status).toBe(429);
    expect(mints).toHaveLength(1);
  });

  it('a different wallet is not blocked by the marker', async () => {
    const gate = chain();
    gate.release();
    expect((await post('playground', WALLET)).status).toBe(200);
    delete g[LOCK_KEY];
    expect((await post('playground', Keypair.generate().publicKey.toBase58())).status).toBe(200);
    expect(mints).toHaveLength(2);
  });

  it('an on-chain marker collision at confirm time (Custom 0 at instruction 0) is a refusal, not a 500', async () => {
    const gate = chain();
    gate.release();
    mocks.confirmServerSignature.mockRejectedValueOnce(
      new mocks.ServerSignatureExecutionError('sig-x', { InstructionError: [0, { Custom: 0 }] }),
    );
    const res = await post('playground', WALLET);
    expect(res.status).toBe(429);
  });
});

describe('N4 layer 1: one in-flight claim per wallet on an instance', () => {
  it('the second concurrent request on the same instance is refused before any chain work', async () => {
    const gate = chain();
    await Promise.all([import('@/app/api/faucet/route'), import('@/app/api/playground/faucet/route')]);
    const first = post('playground', WALLET);
    await parkedAt(1);
    const second = await post('faucet', WALLET); // same lock, other route
    expect(second.status).toBe(429);
    expect((await second.json()).error).toMatch(/already being processed/);
    gate.release();
    expect((await first).status).toBe(200);
    expect(mints).toHaveLength(1);
  });

  it('the lock is released after the request, so a failed mint can be retried', async () => {
    const gate = chain();
    gate.release();
    // A definite on-chain failure (not a marker collision) frees the claim.
    mocks.confirmServerSignature.mockRejectedValueOnce(
      new mocks.ServerSignatureExecutionError('sig-y', { InstructionError: [2, { Custom: 1 }] }),
    );
    expect((await post('playground', WALLET)).status).toBe(503);
    delete g.__percolatorSimUsdcClaims__;
    accounts.clear(); // the failed tx reverted, including its marker
    expect((await post('playground', WALLET)).status).toBe(200);
  });
});

describe('isClaimMarkerCollision', () => {
  it('matches preflight text and on-chain Custom(0) only at marker instructions', async () => {
    const { isClaimMarkerCollision } = await import('@/lib/sim-usdc-claim-guard');
    expect(isClaimMarkerCollision(new Error('Allocate: account Address {} already in use'), 1)).toBe(true);
    expect(isClaimMarkerCollision({ logs: ['Program 111 failed: custom program error: 0x0', 'x already in use'] }, 1)).toBe(true);
    expect(isClaimMarkerCollision({ transactionError: { InstructionError: [0, { Custom: 0 }] } }, 1)).toBe(true);
    expect(isClaimMarkerCollision({ transactionError: { InstructionError: [1, { Custom: 0 }] } }, 1)).toBe(false);
    expect(isClaimMarkerCollision(new Error('blockhash not found'), 1)).toBe(false);
    expect(isClaimMarkerCollision(undefined, 1)).toBe(false);
  });

  it('markers: deterministic per (wallet, day), distinct across wallets and days, 2 near midnight', async () => {
    const m = await import('@/lib/sim-usdc-claim-guard');
    const auth = Keypair.generate().publicKey;
    const [a1] = await m.markerAddresses(auth, WALLET, [20_000]);
    const [a2] = await m.markerAddresses(auth, WALLET, [20_000]);
    const [b] = await m.markerAddresses(auth, WALLET, [20_001]);
    const [c] = await m.markerAddresses(auth, Keypair.generate().publicKey.toBase58(), [20_000]);
    expect(a1.address.equals(a2.address)).toBe(true);
    expect(a1.address.equals(b.address)).toBe(false);
    expect(a1.address.equals(c.address)).toBe(false);
    expect(a1.seed.length).toBeLessThanOrEqual(32);
    const day = 20_000 * 86_400_000;
    expect(m.claimMarkerDays(day + 3_600_000)).toEqual([20_000]);
    expect(m.claimMarkerDays(day + 86_400_000 - 60_000)).toEqual([20_000, 20_001]);
  });
});
