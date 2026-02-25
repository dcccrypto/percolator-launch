import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  parseHeader, parseConfig, parseEngine, parseAllAccounts, parseParams,
} from "../src/solana/slab.js";

/** Build a minimal valid slab buffer for header + config + engine (no accounts).
 *  Updated for PERC-120/121/122 struct changes:
 *    HEADER_LEN = 104, CONFIG_OFFSET = 104, ENGINE_OFF = 456
 *    ENGINE_BITMAP_OFF = 576, ACCOUNT_SIZE = 248
 *    RESERVED_OFF = 80 (nonce at 80, lastThrUpdateSlot at 88)
 */
function buildMockSlab(): Uint8Array {
  const size = 1_025_568; // large tier (4096 accounts) with new ACCOUNT_SIZE=248
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);

  // Header: PERCOLAT magic as u64 LE (0x504552434f4c4154 stored little-endian)
  const magic = [0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50];
  for (let i = 0; i < 8; i++) buf[i] = magic[i];
  // version = 1
  dv.setUint32(8, 1, true);
  // bump = 255
  buf[12] = 255;
  // admin (32 bytes of 1s at offset 16)
  for (let i = 16; i < 48; i++) buf[i] = 1;
  // pending_admin (32 bytes at offset 48, zeros)
  // _reserved: nonce at offset 80, lastThrUpdateSlot at offset 88

  // Config at offset 104
  // collateralMint (32 bytes of 2s)
  for (let i = 104; i < 136; i++) buf[i] = 2;
  // vaultPubkey (32 bytes of 3s)
  for (let i = 136; i < 168; i++) buf[i] = 3;

  // Engine at offset 456
  const engineBase = 456;
  // vault = 1000000 (U128)
  dv.setBigUint64(engineBase + 0, 1000000n, true);
  // insurance balance = 500000
  dv.setBigUint64(engineBase + 16, 500000n, true);
  // totalOpenInterest = 100000 (at engine offset 416)
  dv.setBigUint64(engineBase + 416, 100000n, true);
  // cTot = 800000 (at engine offset 432)
  dv.setBigUint64(engineBase + 432, 800000n, true);
  // numUsedAccounts at bitmap(576) + bitmap_words(64*8=512) = offset 1088
  dv.setUint16(engineBase + 1088, 0, true);
  // nextAccountId at aligned offset after numUsedAccounts: ceil((1088+2)/8)*8 = 1096
  dv.setBigUint64(engineBase + 1096, 1n, true);

  // RiskParams at engine offset 48
  const paramsBase = engineBase + 48;
  dv.setBigUint64(paramsBase + 8, 500n, true);  // maintenanceMarginBps
  dv.setBigUint64(paramsBase + 16, 1000n, true); // initialMarginBps
  dv.setBigUint64(paramsBase + 24, 10n, true);   // tradingFeeBps

  return buf;
}

describe("parseHeader", () => {
  it("parses valid header", () => {
    const buf = buildMockSlab();
    const h = parseHeader(buf);
    expect(h.magic).toBe(0x504552434f4c4154n);
    expect(h.version).toBe(1);
    expect(h.bump).toBe(255);
    expect(h.resolved).toBe(false);
  });

  it("throws on invalid magic", () => {
    const buf = new Uint8Array(992_560);
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
    // collateralMint should be 32 bytes of 2s
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
