import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@percolator/sdk', () => ({
  IX_TAG: { TradeNoCpi: 10, TradeCpi: 11 },
  // detectSlabLayout: returns a V1-style layout so engineOff + engineMarkPriceOff = 1040,
  // matching the mock slab buffers built in tests below.
  detectSlabLayout: vi.fn((dataLen: number) => {
    if (dataLen < 8) return null; // too small
    return { version: 1, engineOff: 640, engineMarkPriceOff: 400, engineBitmapOff: 656 };
  }),
}));

vi.mock('@percolator/shared', () => ({
  config: {
    allProgramIds: ['FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD'],
    webhookSecret: null,
  },
  insertTrade: vi.fn(),
  eventBus: { publish: vi.fn() },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  decodeBase58: vi.fn(() => {
    const buf = new Uint8Array(21);
    buf[0] = 10; // IX_TAG.TradeNoCpi
    buf[5] = 0x40;
    buf[6] = 0x42;
    buf[7] = 0x0f;
    return buf;
  }),
  parseTradeSize: vi.fn(() => ({
    sizeValue: 1_000_000n,
    side: 'long' as const,
  })),
  readU128LE: vi.fn(() => 0n),
}));

import * as shared from '@percolator/shared';
import { webhookRoutes } from '../../src/routes/webhook.js';

const PROGRAM_ID = 'FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD';
const TRADER = 'So11111111111111111111111111111111111111112';
const SLAB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const SIG2 = '4VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

function makeRequest(body: any): Request {
  return new Request('http://localhost/webhook/trades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeBaseInstructions() {
  return [{
    programId: PROGRAM_ID,
    data: 'validbase58data',
    accounts: [TRADER, TRADER, SLAB],
  }];
}

describe('POST /webhook/trades — price extraction', () => {
  let app: ReturnType<typeof webhookRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = webhookRoutes();
  });

  it('falls back to log parsing when slab is V0 layout (engineMarkPriceOff < 0)', async () => {
    // Arrange: make detectSlabLayout return a V0 layout for a 512-byte buffer.
    // V0 slabs have engineMarkPriceOff=-1 — no mark_price field.
    const { detectSlabLayout } = await import('@percolator/sdk');
    vi.mocked(detectSlabLayout).mockImplementationOnce((dataLen: number) => {
      if (dataLen === 512) return { version: 0, engineOff: 480, engineMarkPriceOff: -1, engineBitmapOff: 496 } as any;
      if (dataLen < 8) return null;
      return { version: 1, engineOff: 640, engineMarkPriceOff: 400, engineBitmapOff: 656 } as any;
    });

    const v0SlabData = new Uint8Array(512); // V0 size — no mark_price bytes

    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [{
        account: SLAB,
        data: Buffer.from(v0SlabData).toString('base64'),
      }],
      logs: ['Program log: 3750000, 4000000, 5000000, 6000000, 7000000'], // $3.75 in logs
    };
    await app.fetch(makeRequest([tx]));

    // Should NOT read from slab (V0 has no mark_price), MUST fall back to logs
    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 3.75 }) // 3_750_000 / 1_000_000
    );
  });

  it('extracts price from slab accountData (primary strategy)', async () => {
    // Build a mock slab account buffer with mark_price_e6 at offset ENGINE_OFF + ENGINE_MARK_PRICE_OFF
    // Mock values: ENGINE_OFF=8, ENGINE_MARK_PRICE_OFF=1032, total offset=1040
    const slabData = new Uint8Array(1048); // offset 1040 + 8 bytes for u64
    const dv = new DataView(slabData.buffer);
    // Write 42_500_000 (= $42.50) as u64 little-endian at offset 1040
    dv.setBigUint64(1040, 42_500_000n, true);

    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [{
        account: SLAB,
        data: Buffer.from(slabData).toString('base64'),
      }],
      logs: [], // no logs — forces accountData path
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 42.5 }) // 42_500_000 / 1_000_000
    );
  });

  it('extracts price from slab accountData with array [base64, "base64"] format', async () => {
    const slabData = new Uint8Array(1048);
    const dv = new DataView(slabData.buffer);
    dv.setBigUint64(1040, 10_000_000n, true); // $10.00

    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [{
        account: SLAB,
        data: [Buffer.from(slabData).toString('base64'), 'base64'],
      }],
      logs: [],
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 10.0 })
    );
  });

  it('falls back to logs when accountData has no slab entry', async () => {
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [{ account: 'SomeOtherAccount', data: '' }],
      logs: ['Program log: 1500000, 2000000, 3000000, 4000000, 5000000'],
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 1.5 }) // fell back to log extraction
    );
  });

  it('extracts price from tx.logs (Helius Enhanced Transaction format)', async () => {
    // Helius Enhanced Transactions expose logs as tx.logs, NOT tx.logMessages
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: 1500000, 2000000, 3000000, 4000000, 5000000'],
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 1.5 }) // 1_500_000 / 1_000_000
    );
  });

  it('falls back to tx.logMessages if tx.logs is absent', async () => {
    // Fallback: some callers may pass logMessages (web3.js format)
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logMessages: ['Program log: 2500000, 3000000, 4000000, 5000000, 6000000'],
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 2.5 }) // 2_500_000 / 1_000_000
    );
  });

  it('stores price=0 when no log messages are present', async () => {
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      // neither tx.logs nor tx.logMessages
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0 })
    );
  });

  it('stores price=0 when logs contain no matching pattern', async () => {
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: something irrelevant', 'Program data: abc'],
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0 })
    );
  });

  it('extracts price from hex-formatted log values', async () => {
    // 0x16E360 = 1500000 → 1.5 USD at e6 precision
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: 0x16E360, 0x1E8480, 0x2DC6C0, 0x3D0900, 0x4C4B40'],
    };
    await app.fetch(makeRequest([tx]));

    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ price: 1.5 })
    );
  });

  it('processes an array of transactions and extracts prices independently', async () => {
    const tx1 = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: 1000000, 2000000, 3000000, 4000000, 5000000'],
    };
    const tx2 = {
      signature: SIG2,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: 2000000, 3000000, 4000000, 5000000, 6000000'],
    };
    await app.fetch(makeRequest([tx1, tx2]));

    expect(shared.insertTrade).toHaveBeenCalledTimes(2);
    const prices = vi.mocked(shared.insertTrade).mock.calls.map((c) => (c[0] as any).price);
    expect(prices).toContain(1.0);
    expect(prices).toContain(2.0);
  });

  it('returns 200 even when insertTrade throws', async () => {
    vi.mocked(shared.insertTrade).mockRejectedValueOnce(new Error('DB error'));
    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: 1500000, 2000000, 3000000, 4000000, 5000000'],
    };
    const res = await app.fetch(makeRequest([tx]));
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/webhook/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 when auth header is missing and webhookSecret is set', async () => {
    const origSecret = (shared.config as any).webhookSecret;
    (shared.config as any).webhookSecret = 'secret-token';
    try {
      const req = makeRequest([]);
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    } finally {
      (shared.config as any).webhookSecret = origSecret;
    }
  });
});
