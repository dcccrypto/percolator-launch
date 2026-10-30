// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { __clearHistoryCache, readSlabHistory } from '@/lib/v22/creator-onchain';

const PROGRAM = new PublicKey(new Uint8Array(32).fill(3));
const SLAB = new PublicKey(new Uint8Array(32).fill(4));

const sig = (slot: number) => ({
  signature: `signature-${slot}`,
  slot,
  err: null,
  memo: null,
  blockTime: null,
});

beforeEach(() => {
  __clearHistoryCache();
});

describe('Creator history cache regression', () => {
  it('positive control: stable history is cached', async () => {
    const conn = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([sig(40)]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const first = await readSlabHistory(conn as never, PROGRAM, SLAB, 40n);

    const second = await readSlabHistory(conn as never, PROGRAM, SLAB, 40n);

    expect(first.creationSlot).toBe(40n);
    expect(second).toEqual(first);
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it('negative control: RPC exception is not cached', async () => {
    const conn = {
      getSignaturesForAddress: vi
        .fn()
        .mockRejectedValueOnce(new Error('RPC 429'))
        .mockResolvedValueOnce([sig(42)]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const first = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

    const second = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

    expect(first.creationSlot).toBeNull();
    expect(second.creationSlot).toBe(42n);
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });

  it('negative control: empty history is reused within TTL', async () => {
    const conn = {
      getSignaturesForAddress: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([sig(42)]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const first = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

    const second = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

    expect(first.creationSlot).toBeNull();

    // Reuse the unknown result without repeated RPC calls.
    expect(second.creationSlot).toBeNull();
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });
});

describe('Creator history cache TTL recovery', () => {
  it('retries inconclusive empty history after TTL', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      const conn = {
        getSignaturesForAddress: vi
          .fn()
          .mockResolvedValueOnce([])
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

      const first = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(first.creationSlot).toBeNull();
      expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);

      // Before TTL expiry, reuse the inconclusive result.
      const withinTtl = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(withinTtl.creationSlot).toBeNull();
      expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);

      // After 60 seconds, retry the history request.
      clock.mockReturnValue(61_001);

      const recovered = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(recovered.creationSlot).toBe(42n);
      expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('Creator history cache isolation and budget', () => {
  it('isolates identical slabs across RPC connections', async () => {
    const sourceA = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([sig(41)]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const sourceB = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([sig(42)]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const first = await readSlabHistory(sourceA as never, PROGRAM, SLAB, 42n);

    const second = await readSlabHistory(sourceB as never, PROGRAM, SLAB, 42n);

    expect(first.creationSlot).toBe(41n);
    expect(second.creationSlot).toBe(42n);

    expect(sourceA.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(sourceB.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it('isolates program ID and oracle mode', async () => {
    const otherProgram = new PublicKey(new Uint8Array(32).fill(5));

    const conn = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([sig(42)]),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    await readSlabHistory(conn as never, PROGRAM, SLAB, 42n, 0);

    await readSlabHistory(conn as never, otherProgram, SLAB, 42n, 0);

    await readSlabHistory(conn as never, PROGRAM, SLAB, 42n, 1);

    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(3);
  });

  it('preserves full-page cache after the temporary TTL', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      const conn = {
        getSignaturesForAddress: vi
          .fn()
          .mockResolvedValue(Array.from({ length: 1000 }, (_, i) => sig(i + 1))),
        getTransaction: vi.fn(),
      };

      const first = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(first.creationSlot).toBeNull();
      expect(first.neverPushed).toBeNull();

      clock.mockReturnValue(3_601_000);

      const second = await readSlabHistory(conn as never, PROGRAM, SLAB, 42n);

      expect(second).toEqual(first);
      expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);
      expect(conn.getTransaction).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
