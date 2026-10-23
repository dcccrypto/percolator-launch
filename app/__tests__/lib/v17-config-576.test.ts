/**
 * Config-576 read verify — the offset/length cutover, pinned against a REAL
 * market on the fresh fee-split wrapper (DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj).
 *
 * The fixture (app/__tests__/fixtures/BPgSUbDs.market.json) is the raw account
 * bytes of market BPgSUbDsxZ9bkauWgd6eQ8oLHVx6pSsvfAjPGsS2Sso8 captured from
 * devnet. If the 576-byte config length or the derived offsets are wrong, these
 * reads produce garbage — so this locks in the cutover fixes:
 *   - WrapperConfigV16 = 576 bytes (fee split at 560/562/564),
 *   - V16ConfigAccount (engine margins) at absolute offset 624,
 *   - AssetOracleProfileV16 (insurance_operator) at absolute offset 1350.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWrapperConfigV17,
  parseAssetOracleProfileV17,
  v17MarketAccountLen,
  V17_HEADER_LEN,
  V17_WRAPPER_CONFIG_LEN,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";
import { parseV17RiskParams, V17_ENGINE_CONFIG_OFF } from "@/lib/v17-engine-config";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { v22MarketBytes } from "../helpers/v22-fixtures";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "BPgSUbDs.market.json"), "utf-8"),
) as { market: string; owner: string; dataLen: number; dataBase64: string };

const data = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));

describe("v17 layout constants (from SDK 4.2.0)", () => {
  it("config length is 576 and market-group offset is 592", () => {
    expect(V17_WRAPPER_CONFIG_LEN).toBe(576);
    expect(V17_HEADER_LEN).toBe(16);
    expect(V17_MARKET_GROUP_OFF).toBe(592); // 16 + 576
    expect(V17_MARKET_GROUP_LEN).toBe(758);
  });

  it("engine config offset derives to 624 (592 + 32-byte group header)", () => {
    expect(V17_ENGINE_CONFIG_OFF).toBe(624);
  });
});

describe("fixture is a real fresh-wrapper market", () => {
  it("is owned by the fresh fee-split wrapper", () => {
    expect(fixture.owner).toBe("DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj");
  });

  // The fixture predates v18: its asset slot is the v17 1,797 bytes. SDK 6+ (24d5d19d,
  // pinned 8.0.0) sizes markets with the v18 slot (V17_MARKET_ASSET_SLOT_LEN = 2,325), so
  // v17MarketAccountLen no longer describes this historical account — it describes the
  // deployed wrapper's. The header/config offsets this file pins are unchanged in v18.
  it("account length is the v17-era 4-asset size, 8538 (capacity solves exactly at 576)", () => {
    expect(data.length).toBe(fixture.dataLen);
    expect(data.length).toBe(8538);
    // The capacity only solves to an integer with the 576-byte config:
    const cap = (data.length - V17_MARKET_GROUP_OFF - V17_MARKET_GROUP_LEN) / 1797;
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBe(4);
  });

  it("SDK v17MarketAccountLen uses the v18 slot and matches the deployed wrapper's markets", () => {
    expect(V17_MARKET_ASSET_SLOT_LEN).toBe(2325);
    expect(v17MarketAccountLen(4)).toBe(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + 4 * 2325); // 10650
    // Devnet read 2026-10-02: all 12 sampled kind-1 accounts of wrapper ETDLAdi… are
    // 33,900 bytes, version 18 — exactly 14 v18 asset slots on the same 576-byte config.
    expect(v17MarketAccountLen(14)).toBe(33_900);
  });
});

describe("WrapperConfigV17 (576-byte config) fee split reads correctly", () => {
  const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);

  it("parses the fee split (on-chain defaults 1600 / 4800 / 1600)", () => {
    expect(cfg.creatorShareBps).toBe(1600);
    expect(cfg.lpShareBps).toBe(4800);
    expect(cfg.insuranceShareBps).toBe(1600);
    // sanity: shares sum to the 8000 post-protocol remainder
    expect(cfg.creatorShareBps + cfg.lpShareBps + cfg.insuranceShareBps).toBe(8000);
  });

  it("parses the base trade fee (30 bps) and marketauth", () => {
    expect(cfg.tradeFeeBps).toBe(30n);
    expect(cfg.marketauth.toBase58()).toBe("HLyBte5HgLjZRAfhXRXgzRFc4BXTqPVwadBHEUxY6ftD");
  });

  it("exposes the four-way fee-collection accrual counters", () => {
    // These live in the additive tail that only exists in the 576-byte layout.
    expect(typeof cfg.lpFeeAccruedAtoms).toBe("bigint");
    expect(typeof cfg.insuranceReserveAccruedAtoms).toBe("bigint");
    expect(cfg.protocolFeeAccruedAtoms >= 0n).toBe(true);
  });
});

describe("engine margins read at offset 624 (v17-engine-config)", () => {
  // Flag off: the historical v17-era BPgSUbDs account above (600 / 1200 bps, 4 slots). Flag on: that account is a layout the VERSION-keyed reader
  // refuses by design, so the same read is pinned on the captured v2.2 one-slot market. Expected values are read straight from the raw bytes at
  // the rustc offsets (V16ConfigAccount.maintenance_margin_bps @54, initial_margin_bps @62, v22-rust-layout-aca02ba6.json), not through the app.
  it("parseV17RiskParams decodes the margins at the engine-config offset", () => {
    const v22 = isDevnetV22Enabled();
    const d = v22 ? v22MarketBytes() : data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const cfg = 592 + 32;
    expect(dv.getBigUint64(cfg + 54, true)).toBe(600n); // independent read of the same bytes
    expect(dv.getBigUint64(cfg + 62, true)).toBe(v22 ? 1000n : 1200n);
    const params = parseV17RiskParams(d, 30n);
    expect(params).not.toBeNull();
    expect(params!.maintenanceMarginBps).toBe(600n);
    expect(params!.initialMarginBps).toBe(v22 ? 1000n : 1200n);
    expect(params!.maxAccounts).toBe(v22 ? 1n : 4n);
  });
  // Flag off the reader is length-based (the test above); the VERSION-keyed refusal only exists with the flag on.
  it.skipIf(!isDevnetV22Enabled())("a market of a layout the reader does not know reads as null, never with another layout's offsets", () => {
    expect(parseV17RiskParams(data, 30n)).toBeNull();
  });
});

describe("insurance_operator reads at profile offset 1350", () => {
  it("parses a real (non-zero) insurance_operator + insurance_authority", () => {
    const prof = parseAssetOracleProfileV17(data, V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN);
    const zero = "11111111111111111111111111111111";
    expect(prof.insuranceOperator.toBase58()).not.toBe(zero);
    expect(prof.insuranceAuthority.toBase58()).not.toBe(zero);
    // This market was bound: insurance_authority == the stake vault_auth PDA.
    expect(prof.insuranceOperator.toBase58()).toBe("FeDAMgMCs4RHoSmZg9egBKfQFyf4eZb98PLAqK88c2Ah");
  });
});
