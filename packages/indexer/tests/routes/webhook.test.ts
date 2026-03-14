import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as nodeCrypto from 'node:crypto';

vi.mock('@percolator/sdk', () => ({
  IX_TAG: { TradeNoCpi: 10, TradeCpi: 11, TradeCpiV2: 35 },
  // detectSlabLayout: returns a V1-style layout so engineOff + engineMarkPriceOff = 1040,
  // matching the mock slab buffers built in tests below.
  detectSlabLayout: vi.fn((dataLen: number) => {
    if (dataLen < 8) return null; // too small
    return { version: 1, engineOff: 640, engineMarkPriceOff: 400, engineBitmapOff: 656 };
  }),
}));

// NOTE: This constant must be a literal string used inside vi.mock (which is hoisted before const declarations).
// The string 'test-secret-token' is duplicated intentionally — do not replace with a variable reference.
const TEST_WEBHOOK_SECRET = 'test-secret-token';

vi.mock('@percolator/shared', () => ({
  config: {
    allProgramIds: ['FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD'],
    webhookSecret: 'test-secret-token', // must be a literal — vi.mock is hoisted
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
import { webhookRoutes, verifyWebhookSignature } from '../../src/routes/webhook.js';

const PROGRAM_ID = 'FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD';
const TRADER = 'So11111111111111111111111111111111111111112';
const SLAB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const SIG2 = '4VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

function makeRequest(body: any, secret: string | null = TEST_WEBHOOK_SECRET): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['authorization'] = secret;
  return new Request('http://localhost/webhook/trades', {
    method: 'POST',
    headers,
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

  it('indexes TradeCpiV2 (tag=35, 22-byte layout) — GH#1171 regression', async () => {
    // TradeCpiV2 adds a bump byte at position 21, total 22 bytes.
    // The TRADE_TAGS set must include IX_TAG.TradeCpiV2 or all such trades are silently dropped.
    const mockDecodeBase58 = vi.mocked(shared.decodeBase58);
    mockDecodeBase58.mockReturnValueOnce((() => {
      const buf = new Uint8Array(22); // 22-byte TradeCpiV2
      buf[0] = 35; // IX_TAG.TradeCpiV2
      buf[5] = 0x40; buf[6] = 0x42; buf[7] = 0x0f; // size bytes
      buf[21] = 0xfe; // bump byte
      return buf;
    })());

    const tx = {
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: ['Program log: 1500000, 2000000, 3000000, 4000000, 5000000'],
    };
    await app.fetch(makeRequest([tx]));

    // Must have been indexed — not silently skipped
    expect(shared.insertTrade).toHaveBeenCalledOnce();
    expect(shared.insertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'long', size: '1000000' })
    );
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/webhook/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authorization': TEST_WEBHOOK_SECRET },
      body: 'not-json',
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it('returns 503 when webhookSecret is not configured', async () => {
    const origSecret = (shared.config as any).webhookSecret;
    (shared.config as any).webhookSecret = null;
    try {
      const req = makeRequest([]);
      const res = await app.fetch(req);
      expect(res.status).toBe(503);
    } finally {
      (shared.config as any).webhookSecret = origSecret;
    }
  });

  it('returns 401 when auth header is missing and webhookSecret is set', async () => {
    // Pass null as secret to omit the authorization header
    const req = makeRequest([], null);
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong static token is sent', async () => {
    const req = makeRequest([], 'wrong-token');
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PERC-750: HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

/** Compute the expected x-helius-hmac-sha256 header value for a given body and secret. */
function computeHmac(body: unknown, secret: string): string {
  const raw = JSON.stringify(body);
  return nodeCrypto.createHmac('sha256', secret).update(raw).digest('hex');
}

/** Build a request with the HMAC signature in x-helius-hmac-sha256 (no Authorization). */
function makeHmacRequest(body: unknown, secret = TEST_WEBHOOK_SECRET): Request {
  const raw = JSON.stringify(body);
  const sig = nodeCrypto.createHmac('sha256', secret).update(raw).digest('hex');
  return new Request('http://localhost/webhook/trades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-helius-hmac-sha256': sig },
    body: raw,
  });
}

describe('verifyWebhookSignature — unit tests', () => {
  const SECRET = 'unit-test-secret';
  const BODY = Buffer.from('{"test":true}', 'utf8');
  const validHmac = nodeCrypto.createHmac('sha256', SECRET).update(BODY).digest('hex');

  it('accepts a correct HMAC-SHA256 signature', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET, validHmac)).toBe(true);
  });

  it('rejects a wrong HMAC-SHA256 signature', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET, 'deadbeef'.repeat(8))).toBe(false);
  });

  it('rejects a truncated HMAC-SHA256 signature', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET, validHmac.slice(0, 32))).toBe(false);
  });

  it('accepts a correct static token when no HMAC header is present', () => {
    expect(verifyWebhookSignature(BODY, SECRET, SECRET)).toBe(true);
  });

  it('rejects a wrong static token when no HMAC header is present', () => {
    expect(verifyWebhookSignature(BODY, 'wrong-secret', SECRET)).toBe(false);
  });

  it('rejects when both auth and HMAC headers are absent', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false);
  });

  it('prefers HMAC header over static auth header (HMAC correct, auth wrong)', () => {
    expect(verifyWebhookSignature(BODY, 'totally-wrong', SECRET, validHmac)).toBe(true);
  });

  it('HMAC verifies body integrity — fails when body is different from what was signed', () => {
    const signedOverDifferentBody = nodeCrypto.createHmac('sha256', SECRET).update('tampered').digest('hex');
    expect(verifyWebhookSignature(BODY, '', SECRET, signedOverDifferentBody)).toBe(false);
  });
});

describe('POST /webhook/trades — HMAC-SHA256 mode (PERC-750)', () => {
  let app: ReturnType<typeof webhookRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = webhookRoutes();
  });

  it('accepts a request with a valid x-helius-hmac-sha256 header', async () => {
    const body = [{
      signature: SIG,
      instructions: makeBaseInstructions(),
      innerInstructions: [],
      accountData: [],
      logs: [],
    }];
    const res = await app.fetch(makeHmacRequest(body));
    expect(res.status).toBe(200);
  });

  it('rejects a request with a wrong x-helius-hmac-sha256 header', async () => {
    const raw = JSON.stringify([]);
    const req = new Request('http://localhost/webhook/trades', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-helius-hmac-sha256': 'badhash'.padEnd(64, '0'),
      },
      body: raw,
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered body even when HMAC was computed over original body', async () => {
    // Compute HMAC over original payload, but send a different body
    const originalBody = [{ signature: SIG }];
    const sig = computeHmac(originalBody, TEST_WEBHOOK_SECRET);
    const req = new Request('http://localhost/webhook/trades', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-helius-hmac-sha256': sig,
      },
      body: JSON.stringify([{ signature: 'TAMPERED' }]),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });
});
