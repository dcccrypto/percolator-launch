import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  parseHeader, parseConfig, parseEngine, parseAllAccounts, parseParams,
  detectSlabLayout,
} from "../src/solana/slab.js";

/**
 * Build a valid V0 slab buffer (deployed devnet layout):
 *   HEADER_LEN = 72, CONFIG_LEN = 408, ENGINE_OFF = 480
 *   ACCOUNT_SIZE = 240, ENGINE_BITMAP_OFF = 320
 *
 * Using medium tier (1024 accounts): total = 248,760 bytes
 */
function buildMockSlab(): Uint8Array {
  const size = 248_760; // V0 medium tier
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);

  // Header: PERCOLAT magic as u64 LE
  const magic = [0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50];
  for (let i = 0; i < 8; i++) buf[i] = magic[i];
  // version = 1
  dv.setUint32(8, 1, true);
  // bump = 255
  buf[12] = 255;
  // admin (32 bytes of 1s at offset 16)
  for (let i = 16; i < 48; i++) buf[i] = 1;
  // _reserved at offset 48: nonce=42, lastThrUpdateSlot=12345
  dv.setBigUint64(48, 42n, true);
  dv.setBigUint64(56, 12345n, true);

  // Config at offset 72 (V0 HEADER_LEN = 72)
  // collateralMint (32 bytes of 2s)
  for (let i = 72; i < 104; i++) buf[i] = 2;
  // vaultPubkey (32 bytes of 3s)
  for (let i = 104; i < 136; i++) buf[i] = 3;

  // Engine at offset 480 (V0 ENGINE_OFF)
  const engineBase = 480;
  // vault = 1000000 (U128, lo 8 bytes)
  dv.setBigUint64(engineBase + 0, 1000000n, true);
  // insurance balance = 500000 (at engine+16)
  dv.setBigUint64(engineBase + 16, 500000n, true);

  // RiskParams at engine+48 (V0: InsuranceFund=32 bytes, params at 48)
  const paramsBase = engineBase + 48;
  dv.setBigUint64(paramsBase + 0, 100n, true);   // warmupPeriodSlots
  dv.setBigUint64(paramsBase + 8, 500n, true);    // maintenanceMarginBps
  dv.setBigUint64(paramsBase + 16, 1000n, true);  // initialMarginBps
  dv.setBigUint64(paramsBase + 24, 10n, true);    // tradingFeeBps

  // Engine runtime state at engine+104 (V0: params=56 bytes, 48+56=104)
  dv.setBigUint64(engineBase + 104, 400000000n, true); // currentSlot
  // last_crank_slot at engine+144
  dv.setBigUint64(engineBase + 144, 399999900n, true);
  // max_crank_staleness at engine+152
  dv.setBigUint64(engineBase + 152, 400n, true);
  // totalOpenInterest at engine+160 (U128)
  dv.setBigUint64(engineBase + 160, 100000n, true);
  // cTot at engine+176 (U128)
  dv.setBigUint64(engineBase + 176, 800000n, true);

  // Bitmap at engine+320, for 1024 accounts: 16 bitmap words
  // numUsedAccounts at engine + 320 + 16*8 = engine+448
  dv.setUint16(engineBase + 448, 0, true);
  // nextAccountId at ceil((448+2)/8)*8 = 456
  dv.setBigUint64(engineBase + 456, 1n, true);

  return buf;
}

describe("detectSlabLayout", () => {
  it("detects V0 medium tier", () => {
    const layout = detectSlabLayout(248_760);
    expect(layout).not.toBeNull();
    expect(layout!.version).toBe(0);
    expect(layout!.maxAccounts).toBe(1024);
    expect(layout!.engineOff).toBe(480);
    expect(layout!.accountSize).toBe(240);
  });

  it("returns null for unknown size", () => {
    expect(detectSlabLayout(12345)).toBeNull();
  });
});

describe("parseHeader", () => {
  it("parses valid header", () => {
    const buf = buildMockSlab();
    const h = parseHeader(buf);
    expect(h.magic).toBe(0x504552434f4c4154n);
    expect(h.version).toBe(1);
    expect(h.bump).toBe(255);
    expect(h.resolved).toBe(false);
    expect(h.nonce).toBe(42n);
    expect(h.lastThrUpdateSlot).toBe(12345n);
  });

  it("throws on invalid magic", () => {
    const buf = new Uint8Array(248_760);
    expect(() => parseHeader(buf)).toThrow("Invalid slab magic");
  });

  it("throws on too-short data", () => {
    expect(() => parseHeader(new Uint8Array(10))).toThrow("too short");
  });
});

describe("parseConfig", () => {
  it("parses valid config", () => {
    const buf = buildMockSlab();
    const c = parseConfig(buf);
    expect(c.collateralMint.toBytes()[0]).toBe(2);
    expect(c.vaultPubkey.toBytes()[0]).toBe(3);
  });
});

describe("parseEngine", () => {
  it("parses engine state", () => {
    const buf = buildMockSlab();
    const e = parseEngine(buf);
    expect(e.vault).toBe(1000000n);
    expect(e.insuranceFund.balance).toBe(500000n);
    expect(e.currentSlot).toBe(400000000n);
    expect(e.lastCrankSlot).toBe(399999900n);
    expect(e.maxCrankStalenessSlots).toBe(400n);
    expect(e.totalOpenInterest).toBe(100000n);
    expect(e.cTot).toBe(800000n);
    expect(e.numUsedAccounts).toBe(0);
    expect(e.nextAccountId).toBe(1n);
  });
});

describe("parseParams", () => {
  it("parses risk params", () => {
    const buf = buildMockSlab();
    const p = parseParams(buf);
    expect(p.warmupPeriodSlots).toBe(100n);
    expect(p.maintenanceMarginBps).toBe(500n);
    expect(p.initialMarginBps).toBe(1000n);
    expect(p.tradingFeeBps).toBe(10n);
  });
});

describe("parseAllAccounts", () => {
  it("returns empty for no used accounts", () => {
    const buf = buildMockSlab();
    const accounts = parseAllAccounts(buf);
    expect(accounts).toEqual([]);
  });
});
