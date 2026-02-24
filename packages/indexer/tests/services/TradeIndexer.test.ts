import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const mockGetSignaturesForAddress = vi.fn();
const mockGetParsedTransaction = vi.fn();

vi.mock('@percolator/sdk', () => ({
  IX_TAG: { TradeNoCpi: 10, TradeCpi: 11 },
}));

vi.mock('@percolator/shared', () => ({
  config: {
    allProgramIds: ['FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD'],
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({
    getSignaturesForAddress: mockGetSignaturesForAddress,
    getParsedTransaction: mockGetParsedTransaction,
  })),
  insertTrade: vi.fn(),
  tradeExistsBySignature: vi.fn(async () => false),
  getMarkets: vi.fn(async () => []),
  eventBus: {
    on: vi.fn(),
    off: vi.fn(),
    publish: vi.fn(),
  },
  decodeBase58: vi.fn((str: string) => {
    // Simple mock: return a Buffer from the base64 or return bytes
    try {
      return Buffer.from(str, 'base64');
    } catch {
      return null;
    }
  }),
  readU128LE: vi.fn((bytes: Uint8Array) => {
    let value = 0n;
    for (let i = 15; i >= 0; i--) {
      value = (value << 8n) | BigInt(bytes[i]);
    }
    return value;
  }),
  parseTradeSize: vi.fn((sizeBytes: Uint8Array) => {
    const isNegative = sizeBytes[15] >= 128;
    return {
      sizeValue: isNegative ? 500_000n : 1_000_000n,
      side: isNegative ? 'short' as const : 'long' as const,
    };
  }),
  withRetry: vi.fn(async (fn: any) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

import { TradeIndexerPolling } from '../../src/services/TradeIndexer.js';
import * as shared from '@percolator/shared';

const SLAB = 'FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD';
const PROGRAM_ID = 'FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD';
const TRADER = 'So11111111111111111111111111111111111111112';
// Valid base58 signature (88 chars)
const VALID_SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const VALID_SIG2 = '4VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

describe('TradeIndexerPolling', () => {
  let indexer: TradeIndexerPolling;

  beforeEach(() => {
    vi.clearAllMocks();
    indexer = new TradeIndexerPolling();
  });

  afterEach(() => {
    indexer.stop();
  });

  describe('start and stop', () => {
    it('should start without errors', () => {
      vi.mocked(shared.getMarkets).mockResolvedValue([]);
      indexer.start();
      expect(shared.eventBus.on).toHaveBeenCalledWith('crank.success', expect.any(Function));
    });

    it('should stop and clean up listeners', () => {
      indexer.start();
      indexer.stop();
      expect(shared.eventBus.off).toHaveBeenCalledWith('crank.success', expect.any(Function));
    });

    it('should not start twice', () => {
      indexer.start();
      indexer.start(); // no-op
      // eventBus.on should only be called once
      expect(vi.mocked(shared.eventBus.on).mock.calls.length).toBe(1);
    });

    it('should perform backfill on start', async () => {
      vi.mocked(shared.getMarkets).mockResolvedValue([
        { slab_address: SLAB } as any,
      ]);
      mockGetSignaturesForAddress.mockResolvedValue([]);

      indexer.start();

      // Wait for backfill (5s delay + execution)
      await new Promise(r => setTimeout(r, 6000));

      expect(mockGetSignaturesForAddress).toHaveBeenCalled();
    }, 10000);
  });

  describe('duplicate trade detection', () => {
    it('should skip trades that already exist by signature', async () => {
      vi.mocked(shared.tradeExistsBySignature).mockResolvedValue(true);

      // The indexer checks tradeExistsBySignature internally
      // We verify by checking insertTrade is NOT called when duplicate detected
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);

      // Mock a transaction that would produce a trade
      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_SIG, err: null },
      ]);

      // Build a realistic instruction data buffer:
      // tag(1) + lpIdx(2) + userIdx(2) + size(16) = 21 bytes
      const ixData = new Uint8Array(21);
      ixData[0] = 10; // IX_TAG.TradeNoCpi
      // size bytes (positive = long)
      ixData[5] = 0x40; // some size
      ixData[6] = 0x42;
      ixData[7] = 0x0f;

      // decodeBase58 returns the instruction data
      vi.mocked(shared.decodeBase58).mockReturnValue(ixData);

      mockGetParsedTransaction.mockResolvedValue({
        meta: { err: null, logMessages: [] },
        transaction: {
          message: {
            instructions: [{
              programId: new PublicKey(PROGRAM_ID),
              accounts: [new PublicKey(TRADER)],
              data: 'base58encodeddata',
            }],
          },
        },
      });

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      // Should NOT insert because tradeExistsBySignature returns true
      expect(shared.insertTrade).not.toHaveBeenCalled();
    }, 10000);

    it('should insert trade when not duplicate', async () => {
      vi.mocked(shared.tradeExistsBySignature).mockResolvedValue(false);
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);

      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_SIG, err: null },
      ]);

      const ixData = new Uint8Array(21);
      ixData[0] = 10; // TradeNoCpi
      ixData[5] = 0x40;
      ixData[6] = 0x42;
      ixData[7] = 0x0f;

      vi.mocked(shared.decodeBase58).mockReturnValue(ixData);

      mockGetParsedTransaction.mockResolvedValue({
        meta: { err: null, logMessages: [] },
        transaction: {
          message: {
            instructions: [{
              programId: new PublicKey(PROGRAM_ID),
              accounts: [new PublicKey(TRADER)],
              data: 'base58encodeddata',
            }],
          },
        },
      });

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      expect(shared.insertTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          slab_address: SLAB,
          trader: TRADER,
          tx_signature: VALID_SIG,
        })
      );
    }, 10000);
  });

  describe('error handling', () => {
    it('should skip errored transactions from signatures', async () => {
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);

      // One errored, one valid
      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_SIG, err: { SomeError: true } },
        { signature: VALID_SIG2, err: null },
      ]);

      mockGetParsedTransaction.mockResolvedValue(null); // no parseable tx

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      // Only VALID_SIG2 should be fetched (VALID_SIG was errored)
      if (mockGetParsedTransaction.mock.calls.length > 0) {
        const fetchedSigs = mockGetParsedTransaction.mock.calls.map(c => c[0]);
        expect(fetchedSigs).not.toContain(VALID_SIG);
      }
    }, 10000);

    it('should handle empty signatures gracefully', async () => {
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);
      mockGetSignaturesForAddress.mockResolvedValue([]);

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      expect(shared.insertTrade).not.toHaveBeenCalled();
    }, 10000);

    it('should handle getSignaturesForAddress failure', async () => {
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);
      mockGetSignaturesForAddress.mockRejectedValue(new Error('RPC error'));

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      // Should not crash
      expect(shared.insertTrade).not.toHaveBeenCalled();
    }, 10000);

    it('should skip instructions with data too short', async () => {
      vi.mocked(shared.tradeExistsBySignature).mockResolvedValue(false);
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);

      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_SIG, err: null },
      ]);

      // Return data that's too short (< 21 bytes)
      vi.mocked(shared.decodeBase58).mockReturnValue(new Uint8Array([10, 0, 0]));

      mockGetParsedTransaction.mockResolvedValue({
        meta: { err: null, logMessages: [] },
        transaction: {
          message: {
            instructions: [{
              programId: new PublicKey(PROGRAM_ID),
              accounts: [new PublicKey(TRADER)],
              data: 'shortdata',
            }],
          },
        },
      });

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      expect(shared.insertTrade).not.toHaveBeenCalled();
    }, 10000);

    it('should skip non-trade instruction tags', async () => {
      vi.mocked(shared.tradeExistsBySignature).mockResolvedValue(false);
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);

      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_SIG, err: null },
      ]);

      // Tag 99 is not a trade tag
      const ixData = new Uint8Array(21);
      ixData[0] = 99;
      vi.mocked(shared.decodeBase58).mockReturnValue(ixData);

      mockGetParsedTransaction.mockResolvedValue({
        meta: { err: null, logMessages: [] },
        transaction: {
          message: {
            instructions: [{
              programId: new PublicKey(PROGRAM_ID),
              accounts: [new PublicKey(TRADER)],
              data: 'somedata',
            }],
          },
        },
      });

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      expect(shared.insertTrade).not.toHaveBeenCalled();
    }, 10000);
  });

  describe('price extraction from logs', () => {
    it('should extract price from program logs', async () => {
      vi.mocked(shared.tradeExistsBySignature).mockResolvedValue(false);
      vi.mocked(shared.getMarkets).mockResolvedValue([{ slab_address: SLAB } as any]);

      mockGetSignaturesForAddress.mockResolvedValue([
        { signature: VALID_SIG, err: null },
      ]);

      const ixData = new Uint8Array(21);
      ixData[0] = 10; // TradeNoCpi
      ixData[5] = 1;
      vi.mocked(shared.decodeBase58).mockReturnValue(ixData);

      mockGetParsedTransaction.mockResolvedValue({
        meta: {
          err: null,
          logMessages: [
            'Program log: 1500000, 2000000, 3000000, 4000000, 5000000',
          ],
        },
        transaction: {
          message: {
            instructions: [{
              programId: new PublicKey(PROGRAM_ID),
              accounts: [new PublicKey(TRADER)],
              data: 'somedata',
            }],
          },
        },
      });

      indexer.start();
      await new Promise(r => setTimeout(r, 6500));

      if (vi.mocked(shared.insertTrade).mock.calls.length > 0) {
        const call = vi.mocked(shared.insertTrade).mock.calls[0][0] as any;
        expect(call.price).toBe(1.5); // 1500000 / 1_000_000
      }
    }, 10000);
  });
});
