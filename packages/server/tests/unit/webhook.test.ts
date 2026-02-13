/**
 * Webhook Route Tests — POST /webhook/trades
 * Tests Helius enhanced transaction parsing, trade extraction, auth, dedup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { webhookRoutes } from "../../src/routes/webhook.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockInsertTrade = vi.fn().mockResolvedValue(undefined);
const mockPublish = vi.fn();

vi.mock("../../src/db/queries.js", () => ({
  insertTrade: (...args: any[]) => mockInsertTrade(...args),
}));

vi.mock("../../src/services/events.js", () => ({
  eventBus: { publish: (...args: any[]) => mockPublish(...args) },
}));

vi.mock("../../src/config.js", () => ({
  config: {
    webhookSecret: "test-secret",
    allProgramIds: ["FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"],
    rpcUrl: "https://api.devnet.solana.com",
    heliusApiKey: "",
    webhookUrl: "",
  },
}));

// ─── Base58 Encoder ──────────────────────────────────────────────────────────

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to bigint
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);

  let result = "";
  while (value > 0n) {
    result = ALPHABET[Number(value % 58n)] + result;
    value = value / 58n;
  }

  return "1".repeat(zeros) + result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROGRAM_ID = "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD";
// Valid base58 pubkeys (32 bytes each, different)
const TRADER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const LP = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const SLAB = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const ORACLE = "7UVimffxr9ow1dPPZfGREfGnuw4sMB3ABN1Ff3dLw4hT";

function buildTradeIxData(tag: number, lpIdx: number, userIdx: number, sizeBigint: bigint): Uint8Array {
  const buf = new Uint8Array(21);
  buf[0] = tag;
  // lpIdx u16 LE
  buf[1] = lpIdx & 0xff;
  buf[2] = (lpIdx >> 8) & 0xff;
  // userIdx u16 LE
  buf[3] = userIdx & 0xff;
  buf[4] = (userIdx >> 8) & 0xff;
  // size i128 LE — write as two's complement
  let val = sizeBigint;
  if (val < 0n) {
    val = (1n << 128n) + val; // two's complement
  }
  for (let i = 0; i < 16; i++) {
    buf[5 + i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

function makeTx(overrides: Record<string, any> = {}) {
  const size = overrides.size ?? 1000000n;
  const tag = overrides.tag ?? 6; // TradeNoCpi
  const data = encodeBase58(buildTradeIxData(tag, 0, 0, size));
  return {
    signature: overrides.signature ?? "5abcdefghijklmnopqrstuvwxyz12345",
    instructions: overrides.instructions ?? [
      {
        programId: overrides.programId ?? PROGRAM_ID,
        accounts: overrides.accounts ?? [TRADER, LP, SLAB, CLOCK, ORACLE],
        data: overrides.data ?? data,
      },
    ],
    innerInstructions: overrides.innerInstructions ?? [],
    logMessages: overrides.logMessages ?? [
      "Program log: 1000000, 500000, 2000000, 100, 50",
    ],
    accountData: overrides.accountData ?? [
      { account: TRADER, nativeBalanceChange: -50000 },
    ],
  };
}

// ─── App Setup ───────────────────────────────────────────────────────────────

function createApp() {
  const app = new Hono();
  app.route("/", webhookRoutes());
  return app;
}

async function post(app: Hono, body: any, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/webhook/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return app.fetch(req);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /webhook/trades", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // Auth
  it("returns 401 when auth header is wrong", async () => {
    const res = await post(app, [makeTx()], { authorization: "wrong-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 200 when auth header matches", async () => {
    const res = await post(app, [makeTx()], { authorization: "test-secret" });
    expect(res.status).toBe(200);
  });

  // Invalid body
  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/webhook/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "test-secret" },
      body: "not-json{{{",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  // Valid processing
  it("returns 200 for valid enhanced transaction array", async () => {
    const res = await post(app, [makeTx()], { authorization: "test-secret" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(1);
  });

  // TradeNoCpi (tag=6)
  it("parses TradeNoCpi instruction correctly", async () => {
    const size = 5000000n;
    const tx = makeTx({ tag: 6, size });
    await post(app, [tx], { authorization: "test-secret" });

    expect(mockInsertTrade).toHaveBeenCalledOnce();
    const trade = mockInsertTrade.mock.calls[0][0];
    expect(trade.trader).toBe(TRADER);
    expect(trade.slab_address).toBe(SLAB);
    expect(trade.size).toBe(size.toString());
    expect(trade.side).toBe("long");
  });

  // TradeCpi (tag=10)
  it("parses TradeCpi instruction correctly", async () => {
    const tx = makeTx({
      tag: 10,
      size: 999n,
      accounts: [TRADER, LP, SLAB, CLOCK, ORACLE, PROGRAM_ID, TRADER, LP],
    });
    await post(app, [tx], { authorization: "test-secret" });

    expect(mockInsertTrade).toHaveBeenCalledOnce();
    const trade = mockInsertTrade.mock.calls[0][0];
    expect(trade.trader).toBe(TRADER);
    expect(trade.slab_address).toBe(SLAB);
    expect(trade.side).toBe("long");
    expect(trade.size).toBe("999");
  });

  // Negative i128 (short)
  it("handles negative i128 (short side) correctly", async () => {
    const negativeSize = -1000000n;
    const tx = makeTx({ size: negativeSize });
    await post(app, [tx], { authorization: "test-secret" });

    expect(mockInsertTrade).toHaveBeenCalledOnce();
    const trade = mockInsertTrade.mock.calls[0][0];
    expect(trade.side).toBe("short");
    expect(trade.size).toBe("1000000"); // absolute value
  });

  // Positive i128 (long)
  it("handles positive i128 (long side) correctly", async () => {
    const tx = makeTx({ size: 42n });
    await post(app, [tx], { authorization: "test-secret" });

    const trade = mockInsertTrade.mock.calls[0][0];
    expect(trade.side).toBe("long");
    expect(trade.size).toBe("42");
  });

  // Skips wrong program ID
  it("skips instructions with wrong program ID", async () => {
    const tx = makeTx({ programId: "11111111111111111111111111111111" });
    await post(app, [tx], { authorization: "test-secret" });
    expect(mockInsertTrade).not.toHaveBeenCalled();
  });

  // Skips short data
  it("skips instructions with data < 21 bytes", async () => {
    const shortData = encodeBase58(new Uint8Array([6, 0, 0, 0, 0])); // only 5 bytes
    const tx = makeTx({ data: shortData });
    await post(app, [tx], { authorization: "test-secret" });
    expect(mockInsertTrade).not.toHaveBeenCalled();
  });

  // Skips invalid pubkeys
  it("skips instructions with invalid base58 pubkeys", async () => {
    const tx = makeTx({ accounts: ["!!!invalid!!!", LP, SLAB, CLOCK, ORACLE] });
    await post(app, [tx], { authorization: "test-secret" });
    expect(mockInsertTrade).not.toHaveBeenCalled();
  });

  // Price extraction from logs
  it("extracts price from program logs", async () => {
    const tx = makeTx({
      logMessages: ["Program log: 1000000, 500000, 2000000, 100, 50"],
    });
    await post(app, [tx], { authorization: "test-secret" });

    const trade = mockInsertTrade.mock.calls[0][0];
    // 1000000 is in range [1000, 1e12] → price = 1000000/1e6 = 1.0
    expect(trade.price).toBe(1);
  });

  // No matching log → price=0
  it("returns price=0 when no matching log found", async () => {
    const tx = makeTx({ logMessages: ["Program log: some other log"] });
    await post(app, [tx], { authorization: "test-secret" });

    const trade = mockInsertTrade.mock.calls[0][0];
    expect(trade.price).toBe(0);
  });

  // Deduplication
  it("deduplicates trades within same transaction (same sig + trader + side)", async () => {
    const data = encodeBase58(buildTradeIxData(6, 0, 0, 1000n));
    const tx = makeTx({
      instructions: [
        { programId: PROGRAM_ID, accounts: [TRADER, LP, SLAB, CLOCK, ORACLE], data },
      ],
      innerInstructions: [
        {
          instructions: [
            { programId: PROGRAM_ID, accounts: [TRADER, LP, SLAB, CLOCK, ORACLE], data },
          ],
        },
      ],
    });
    await post(app, [tx], { authorization: "test-secret" });

    // Should only insert once (inner ix deduped against outer)
    expect(mockInsertTrade).toHaveBeenCalledOnce();
  });

  // Inner instructions processing
  it("processes inner instructions for TradeCpi via matcher", async () => {
    const data = encodeBase58(buildTradeIxData(10, 0, 0, 500n));
    const tx = makeTx({
      instructions: [], // no outer instructions
      innerInstructions: [
        {
          instructions: [
            {
              programId: PROGRAM_ID,
              accounts: [TRADER, LP, SLAB, CLOCK, ORACLE, PROGRAM_ID, TRADER, LP],
              data,
            },
          ],
        },
      ],
    });
    await post(app, [tx], { authorization: "test-secret" });

    expect(mockInsertTrade).toHaveBeenCalledOnce();
    const trade = mockInsertTrade.mock.calls[0][0];
    expect(trade.size).toBe("500");
  });

  // Empty array
  it("handles empty transaction array", async () => {
    const res = await post(app, [], { authorization: "test-secret" });
    expect(res.status).toBe(200);
    expect(mockInsertTrade).not.toHaveBeenCalled();
  });

  // Single tx (not array)
  it("handles single tx (not array) wrapping", async () => {
    const tx = makeTx();
    const res = await post(app, tx, { authorization: "test-secret" }); // not wrapped in array
    expect(res.status).toBe(200);
    expect(mockInsertTrade).toHaveBeenCalledOnce();
  });

  // Event bus
  it("publishes trade.executed event on successful insert", async () => {
    await post(app, [makeTx()], { authorization: "test-secret" });

    expect(mockPublish).toHaveBeenCalledWith(
      "trade.executed",
      SLAB,
      expect.objectContaining({
        trader: TRADER,
        side: "long",
      }),
    );
  });
});
