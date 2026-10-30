import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { __clearHistoryCache, readSlabHistory } from '@/lib/v22/creator-onchain';

const PROGRAM = new PublicKey(new Uint8Array(32).fill(3));
const SLAB = new PublicKey(new Uint8Array(32).fill(4));

interface TestSignature {
  signature: string;
  slot: number;
  err: null;
  memo: null;
  blockTime: null;
}

beforeEach(() => {
  __clearHistoryCache();
});

describe('Creator history concurrent RPC reads', () => {
  it('coalesces simultaneous identical history lookups', async () => {
    let release!: (value: TestSignature[]) => void;

    const pending = new Promise<TestSignature[]>((resolve) => {
      release = resolve;
    });

    const conn = {
      getSignaturesForAddress: vi.fn(() => pending),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    // Both requests begin before the first RPC returns.
    const first = readSlabHistory(conn as never, PROGRAM, SLAB, 42n);
    const second = readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

    release([
      {
        signature: 'signature-42',
        slot: 42,
        err: null,
        memo: null,
        blockTime: null,
      },
    ]);

    const [a, b] = await Promise.all([first, second]);

    expect(a.creationSlot).toBe(42n);
    expect(b.creationSlot).toBe(42n);

    // Desired optimization: one shared in-flight RPC read.
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });
});

describe('Creator history concurrency isolation', () => {
  it('keeps different slabs independent', async () => {
    const otherSlab = new PublicKey(new Uint8Array(32).fill(7));

    const conn = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        {
          signature: 'signature-42',
          slot: 42,
          err: null,
          memo: null,
          blockTime: null,
        },
      ]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const [first, second] = await Promise.all([
      readSlabHistory(conn as never, PROGRAM, SLAB, 42n),
      readSlabHistory(conn as never, PROGRAM, otherSlab, 42n),
    ]);

    expect(first.creationSlot).toBe(42n);
    expect(second.creationSlot).toBe(42n);

    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });
});

describe('Creator single-flight failure recovery', () => {
  it('retries after a shared RPC failure', async () => {
    const conn = {
      getSignaturesForAddress: vi
        .fn()
        .mockRejectedValueOnce(new Error('RPC 429'))
        .mockResolvedValueOnce([
          {
            signature: 'signature-42',
            slot: 42,
            err: null,
            memo: null,
            blockTime: null,
          },
        ]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const [first, second] = await Promise.all([
      readSlabHistory(conn as never, PROGRAM, SLAB, 42n),
      readSlabHistory(conn as never, PROGRAM, SLAB, 42n),
    ]);

    expect(first.creationSlot).toBeNull();
    expect(second.creationSlot).toBeNull();

    // Both callers share the failed RPC read.
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);

    // A subsequent request must be allowed to retry.
    const recovered = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

    expect(recovered.creationSlot).toBe(42n);
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });
});
