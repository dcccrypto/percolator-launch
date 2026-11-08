// @vitest-environment node
/**
 * R3 M8 review (H1, M1, L1): the on-chain claim finder against the REAL lib with a fake Connection.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FAUCET_MINT_RAW,
  OnchainClaimUnverifiableError,
  findRecentOnchainClaim,
  onchainClaimCheckFailure,
} from '@/lib/sim-usdc-onchain-claim';

const AUTH = 'MintAuthority';
const ATA = 'AtaAddr';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ata = { toBase58: () => ATA } as never;
const sec = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);

type Sig = { signature: string; blockTime: number | null; err: unknown };
type Tx = { payer: string; ixs: unknown[] } | null;
const mintTo = (amount = FAUCET_MINT_RAW, account = ATA, type = 'mintTo') => ({
  program: 'spl-token',
  parsed:
    type === 'mintToChecked'
      ? { type, info: { account, tokenAmount: { amount } } }
      : { type, info: { account, amount } },
});

/** history: newest first. Paged by `before`. */
function conn(history: Sig[], txs: Record<string, Tx>) {
  const getSignaturesForAddress = vi.fn(async (_a: unknown, o: { limit: number; before?: string }) => {
    const start = o.before ? history.findIndex((h) => h.signature === o.before) + 1 : 0;
    return history.slice(start, start + o.limit).map((h) => ({ ...h, slot: 1, memo: null }));
  });
  const getParsedTransactions = vi.fn(async (sigs: string[]) =>
    sigs.map((s) => {
      const t = txs[s];
      return t === undefined || t === null
        ? null
        : { transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => t.payer } }], instructions: t.ixs } } };
    }),
  );
  return { getSignaturesForAddress, getParsedTransactions } as never as Parameters<typeof findRecentOnchainClaim>[0] & {
    getSignaturesForAddress: typeof getSignaturesForAddress;
    getParsedTransactions: typeof getParsedTransactions;
  };
}
const run = (c: Parameters<typeof findRecentOnchainClaim>[0]) => findRecentOnchainClaim(c, ata, AUTH, NOW);
const faucetTx = { payer: AUTH, ixs: [mintTo()] };

describe('findRecentOnchainClaim: what counts as a claim', () => {
  it('a faucet mint (10,000 mintTo to this ATA, paid by the authority) is a claim, with the real next time', async () => {
    const c = conn([{ signature: 'f', blockTime: sec(1000), err: null }], { f: faucetTx });
    expect(await run(c)).toBe(new Date(sec(1000) * 1000 + DAY).toISOString());
  });
  it('mintToChecked also counts', async () => {
    const c = conn([{ signature: 'f', blockTime: sec(1000), err: null }], { f: { payer: AUTH, ixs: [mintTo(FAUCET_MINT_RAW, ATA, 'mintToChecked')] } });
    expect(await run(c)).not.toBeNull();
  });
  it('an auto-fund mint (1,000, same payer) is not a claim', async () => {
    const c = conn([{ signature: 'a', blockTime: sec(1000), err: null }], { a: { payer: AUTH, ixs: [mintTo('1000000000')] } });
    expect(await run(c)).toBeNull();
  });
  it('a 10,000 mintTo to a DIFFERENT account is not a claim', async () => {
    const c = conn([{ signature: 'x', blockTime: sec(1000), err: null }], { x: { payer: AUTH, ixs: [mintTo(FAUCET_MINT_RAW, 'Other')] } });
    expect(await run(c)).toBeNull();
  });
  it('a non-faucet payer does not count', async () => {
    const c = conn([{ signature: 'p', blockTime: sec(1000), err: null }], { p: { payer: 'SomeUser', ixs: [mintTo()] } });
    expect(await run(c)).toBeNull();
  });
  it('a failed faucet tx does not count', async () => {
    const c = conn([{ signature: 'e', blockTime: sec(1000), err: { InstructionError: [0, 'x'] } }], { e: faucetTx });
    expect(await run(c)).toBeNull();
  });
  it('a faucet mint older than the window does not count', async () => {
    const c = conn([{ signature: 'o', blockTime: sec(DAY + 3_600_000), err: null }], { o: faucetTx });
    expect(await run(c)).toBeNull();
  });
  it('an unreadable parsed entry fails closed', async () => {
    const c = conn([{ signature: 'u', blockTime: sec(1000), err: null }], { u: null });
    await expect(run(c)).rejects.toBeInstanceOf(OnchainClaimUnverifiableError);
  });
});

describe('findRecentOnchainClaim: busy history (M1 bypasses)', () => {
  const failed = (n: number, offset = 0): Sig[] =>
    Array.from({ length: n }, (_, i) => ({ signature: `fail${offset + i}`, blockTime: sec(1000 + offset + i), err: { e: 1 } }));
  const oldClaim: Sig = { signature: 'claim', blockTime: sec(DAY / 2), err: null };

  it('40 failed txs pushing a real claim out of view: paginated through, claim found', async () => {
    const c = conn([...failed(40), oldClaim], { claim: faucetTx });
    expect(await run(c)).toBe(new Date(oldClaim.blockTime! * 1000 + DAY).toISOString());
    expect(c.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });
  it('39 ok non-faucet + 1 failed on a full page, claim behind: found', async () => {
    const oks: Sig[] = Array.from({ length: 39 }, (_, i) => ({ signature: `ok${i}`, blockTime: sec(1000 + i), err: null }));
    const txs: Record<string, Tx> = { claim: faucetTx };
    oks.forEach((o) => (txs[o.signature] = { payer: 'SomeUser', ixs: [] }));
    const c = conn([...oks, ...failed(1, 100), oldClaim], txs);
    expect(await run(c)).not.toBeNull();
  });
  it('a full page whose oldest entry is already past the window is decided clear without paging', async () => {
    const hist: Sig[] = [...failed(39), { signature: 'ancient', blockTime: sec(DAY + 10_000), err: null }];
    const c = conn(hist, { ancient: faucetTx });
    expect(await run(c)).toBeNull();
    expect(c.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });
  it('still undecidable after the page cap fails closed as "busy"', async () => {
    const c = conn(failed(200), {});
    const err = await run(c).catch((e) => e);
    expect(err).toBeInstanceOf(OnchainClaimUnverifiableError);
    expect((err as OnchainClaimUnverifiableError).reason).toBe('busy');
  });
  it('honest copy: busy is not retryable, unreadable is', () => {
    expect(onchainClaimCheckFailure(new OnchainClaimUnverifiableError('x', 'busy')).retryable).toBe(false);
    expect(onchainClaimCheckFailure(new OnchainClaimUnverifiableError('x', 'busy')).error).not.toMatch(/moment/i);
    expect(onchainClaimCheckFailure(new Error('rpc')).retryable).toBe(true);
  });
});
