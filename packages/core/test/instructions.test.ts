import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  encodeInitMarket, encodeInitUser, encodeInitLP,
  encodeDepositCollateral, encodeWithdrawCollateral,
  encodeKeeperCrank, encodeTradeNoCpi, encodeTradeCpi,
  encodeLiquidateAtOracle, encodeCloseAccount,
  encodeTopUpInsurance, encodeSetRiskThreshold, encodeUpdateAdmin,
  encodeCloseSlab, encodeUpdateConfig, encodeSetMaintenanceFee,
  encodeSetOracleAuthority, encodePushOraclePrice, encodeSetOraclePriceCap,
  encodeResolveMarket, encodeWithdrawInsurance,
  encodeFundMarketInsurance, encodeSetInsuranceIsolation,
  encodeAdvanceOraclePhase, encodeTopUpKeeperFund,
  encodeSlashCreationDeposit, encodeInitSharedVault,
  encodeAllocateMarket, encodeQueueWithdrawalSV,
  encodeClaimEpochWithdrawal, encodeAdvanceEpoch,
  IX_TAG,
} from "../src/abi/instructions.js";

describe("IX_TAG values", () => {
  it("has correct tags", () => {
    expect(IX_TAG.InitMarket).toBe(0);
    expect(IX_TAG.InitUser).toBe(1);
    expect(IX_TAG.InitLP).toBe(2);
    expect(IX_TAG.DepositCollateral).toBe(3);
    expect(IX_TAG.WithdrawCollateral).toBe(4);
    expect(IX_TAG.KeeperCrank).toBe(5);
    expect(IX_TAG.TradeNoCpi).toBe(6);
    expect(IX_TAG.TradeCpi).toBe(10);
    expect(IX_TAG.ResolveMarket).toBe(19);
    expect(IX_TAG.WithdrawInsurance).toBe(20);
  });
});

describe("instruction encoders", () => {
  it("encodeInitUser produces 9 bytes", () => {
    const data = encodeInitUser({ feePayment: "1000000" });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.InitUser);
  });

  it("encodeDepositCollateral produces 11 bytes", () => {
    const data = encodeDepositCollateral({ userIdx: 5, amount: "1000000" });
    expect(data.length).toBe(11);
    expect(data[0]).toBe(IX_TAG.DepositCollateral);
  });

  it("encodeWithdrawCollateral produces 11 bytes", () => {
    const data = encodeWithdrawCollateral({ userIdx: 10, amount: "500000" });
    expect(data.length).toBe(11);
    expect(data[0]).toBe(IX_TAG.WithdrawCollateral);
  });

  it("encodeKeeperCrank produces 4 bytes", () => {
    const data = encodeKeeperCrank({ callerIdx: 1, allowPanic: true });
    expect(data.length).toBe(4);
    expect(data[0]).toBe(IX_TAG.KeeperCrank);
    expect(data[3]).toBe(1);
  });

  it("encodeTradeNoCpi produces 21 bytes", () => {
    const data = encodeTradeNoCpi({ lpIdx: 0, userIdx: 1, size: "1000000" });
    expect(data.length).toBe(21);
    expect(data[0]).toBe(IX_TAG.TradeNoCpi);
  });

  it("encodeTradeNoCpi with negative size", () => {
    const data = encodeTradeNoCpi({ lpIdx: 0, userIdx: 1, size: "-1000000" });
    expect(data.length).toBe(21);
    expect(data[5]).toBe(192); // -1000000 LE first byte
  });

  it("encodeTradeCpi produces 21 bytes", () => {
    const data = encodeTradeCpi({ lpIdx: 2, userIdx: 3, size: "-500" });
    expect(data.length).toBe(21);
    expect(data[0]).toBe(IX_TAG.TradeCpi);
  });

  it("encodeLiquidateAtOracle produces 3 bytes", () => {
    const data = encodeLiquidateAtOracle({ targetIdx: 42 });
    expect(data.length).toBe(3);
    expect(data[0]).toBe(IX_TAG.LiquidateAtOracle);
  });

  it("encodeCloseAccount produces 3 bytes", () => {
    const data = encodeCloseAccount({ userIdx: 100 });
    expect(data.length).toBe(3);
    expect(data[0]).toBe(IX_TAG.CloseAccount);
  });

  it("encodeTopUpInsurance produces 9 bytes", () => {
    const data = encodeTopUpInsurance({ amount: "5000000" });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.TopUpInsurance);
  });

  it("encodeSetRiskThreshold produces 17 bytes", () => {
    const data = encodeSetRiskThreshold({ newThreshold: "1000000000000" });
    expect(data.length).toBe(17);
    expect(data[0]).toBe(IX_TAG.SetRiskThreshold);
  });

  it("encodeUpdateAdmin produces 33 bytes", () => {
    const data = encodeUpdateAdmin({ newAdmin: new PublicKey("11111111111111111111111111111111") });
    expect(data.length).toBe(33);
    expect(data[0]).toBe(IX_TAG.UpdateAdmin);
  });

  it("encodeInitLP produces 73 bytes", () => {
    const data = encodeInitLP({ matcherProgram: PublicKey.unique(), matcherContext: PublicKey.unique(), feePayment: "1000000" });
    expect(data.length).toBe(73);
    expect(data[0]).toBe(IX_TAG.InitLP);
  });

  it("encodeInitMarket produces 360 bytes (v12.15 wire format)", () => {
    const data = encodeInitMarket({
      admin: PublicKey.unique(), collateralMint: PublicKey.unique(),
      indexFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      maxStalenessSecs: "60", confFilterBps: 50, invert: 0, unitScale: 0, initialMarkPriceE6: "0",
      hMin: "1000", hMax: "2000", maintenanceMarginBps: "500", initialMarginBps: "1000",
      tradingFeeBps: "10", maxAccounts: "1000", newAccountFee: "1000000",
      maintenanceFeePerSlot: "100",
      maxCrankStalenessSlots: "50", liquidationFeeBps: "100", liquidationFeeCap: "10000000",
      liquidationBufferBps: "50", minLiquidationAbs: "1000000",
      minInitialDeposit: "500000", minNonzeroMmReq: "100000", minNonzeroImReq: "200000",
    });
    expect(data.length).toBe(360);
    expect(data[0]).toBe(IX_TAG.InitMarket);
  });

  it("encodeCloseSlab produces 1 byte", () => {
    expect(encodeCloseSlab().length).toBe(1);
    expect(encodeCloseSlab()[0]).toBe(IX_TAG.CloseSlab);
  });

  it("encodePushOraclePrice produces 17 bytes", () => {
    const data = encodePushOraclePrice({ priceE6: "50000000", timestamp: "1700000000" });
    expect(data.length).toBe(17);
    expect(data[0]).toBe(IX_TAG.PushOraclePrice);
  });

  it("encodeResolveMarket produces 1 byte", () => {
    expect(encodeResolveMarket()[0]).toBe(IX_TAG.ResolveMarket);
  });

  it("encodeWithdrawInsurance produces 1 byte", () => {
    expect(encodeWithdrawInsurance()[0]).toBe(IX_TAG.WithdrawInsurance);
  });
});

// ============================================================================
// PERC-608: Settlement tag integrity and ClearPendingSettlement guard
// ============================================================================

describe("PERC-608 settlement tag integrity", () => {
  it("ChallengeSettlement is tag 43 (not ExecuteAdl)", () => {
    expect(IX_TAG.ChallengeSettlement).toBe(43);
  });

  it("ResolveDispute is tag 44", () => {
    expect(IX_TAG.ResolveDispute).toBe(44);
  });

  it("no ClearPendingSettlement tag exists in IX_TAG", () => {
    expect((IX_TAG as Record<string, number>)["ClearPendingSettlement"]).toBeUndefined();
  });

  it("no clearPendingSettlement tag exists (case-insensitive check)", () => {
    const keys = Object.keys(IX_TAG);
    const match = keys.find((k) => k.toLowerCase() === "clearpendingsettlement");
    expect(match).toBeUndefined();
  });

  it("tag 43 is exclusively ChallengeSettlement — no duplicate assignment", () => {
    const entries = Object.entries(IX_TAG).filter(([, v]) => v === 43);
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("ChallengeSettlement");
  });

  it("tag 44 is exclusively ResolveDispute — no duplicate assignment", () => {
    const entries = Object.entries(IX_TAG).filter(([, v]) => v === 44);
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("ResolveDispute");
  });

  it("all IX_TAG values are unique (no tag collision)", () => {
    const values = Object.values(IX_TAG);
    expect(new Set(values).size).toBe(values.length);
  });

  it("settlement-adjacent tags have correct sequence (41-46)", () => {
    expect(IX_TAG.FundMarketInsurance).toBe(41);
    expect(IX_TAG.SetInsuranceIsolation).toBe(42);
    expect(IX_TAG.ChallengeSettlement).toBe(43);
    expect(IX_TAG.ResolveDispute).toBe(44);
    expect(IX_TAG.DepositLpCollateral).toBe(45);
    expect(IX_TAG.WithdrawLpCollateral).toBe(46);
  });

  it("permissionless crank tags are in expected range (56-63)", () => {
    expect(IX_TAG.AdvanceOraclePhase).toBe(56);
    expect(IX_TAG.TopUpKeeperFund).toBe(57);
    expect(IX_TAG.SlashCreationDeposit).toBe(58);
    expect(IX_TAG.InitSharedVault).toBe(59);
    expect(IX_TAG.AllocateMarket).toBe(60);
    expect(IX_TAG.QueueWithdrawalSV).toBe(61);
    expect(IX_TAG.ClaimEpochWithdrawal).toBe(62);
    expect(IX_TAG.AdvanceEpoch).toBe(63);
  });
});

// ============================================================================
// PERC-306 / PERC-622 / PERC-623 / PERC-628 / PERC-629: Newer encoders
// ============================================================================

describe("newer instruction encoders", () => {
  // --- PERC-306: FundMarketInsurance ---
  it("encodeFundMarketInsurance produces 9 bytes with correct tag", () => {
    const data = encodeFundMarketInsurance({ amount: 1_000_000n });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.FundMarketInsurance);
  });

  it("encodeFundMarketInsurance encodes zero amount", () => {
    const data = encodeFundMarketInsurance({ amount: 0n });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.FundMarketInsurance);
    // bytes 1-8 should be all zeros for amount=0
    for (let i = 1; i < 9; i++) {
      expect(data[i]).toBe(0);
    }
  });

  it("encodeFundMarketInsurance encodes max u64", () => {
    const data = encodeFundMarketInsurance({ amount: 18_446_744_073_709_551_615n });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.FundMarketInsurance);
    // All amount bytes should be 0xFF for max u64
    for (let i = 1; i < 9; i++) {
      expect(data[i]).toBe(0xFF);
    }
  });

  // --- PERC-306: SetInsuranceIsolation ---
  it("encodeSetInsuranceIsolation produces 3 bytes with correct tag", () => {
    const data = encodeSetInsuranceIsolation({ bps: 5000 });
    expect(data.length).toBe(3);
    expect(data[0]).toBe(IX_TAG.SetInsuranceIsolation);
  });

  it("encodeSetInsuranceIsolation encodes zero bps", () => {
    const data = encodeSetInsuranceIsolation({ bps: 0 });
    expect(data.length).toBe(3);
    expect(data[1]).toBe(0);
    expect(data[2]).toBe(0);
  });

  it("encodeSetInsuranceIsolation encodes 10000 bps (100%)", () => {
    const data = encodeSetInsuranceIsolation({ bps: 10000 });
    expect(data.length).toBe(3);
    // 10000 = 0x2710 LE → [0x10, 0x27]
    expect(data[1]).toBe(0x10);
    expect(data[2]).toBe(0x27);
  });

  // --- PERC-622: AdvanceOraclePhase ---
  it("encodeAdvanceOraclePhase produces 1 byte with correct tag", () => {
    const data = encodeAdvanceOraclePhase();
    expect(data.length).toBe(1);
    expect(data[0]).toBe(IX_TAG.AdvanceOraclePhase);
  });

  // --- PERC-623: TopUpKeeperFund ---
  it("encodeTopUpKeeperFund produces 9 bytes with correct tag", () => {
    const data = encodeTopUpKeeperFund({ amount: "5000000" });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.TopUpKeeperFund);
  });

  it("encodeTopUpKeeperFund encodes zero amount", () => {
    const data = encodeTopUpKeeperFund({ amount: "0" });
    expect(data.length).toBe(9);
    for (let i = 1; i < 9; i++) {
      expect(data[i]).toBe(0);
    }
  });

  // --- PERC-629: SlashCreationDeposit ---
  it("encodeSlashCreationDeposit produces 1 byte with correct tag", () => {
    const data = encodeSlashCreationDeposit();
    expect(data.length).toBe(1);
    expect(data[0]).toBe(IX_TAG.SlashCreationDeposit);
  });

  // --- PERC-628: InitSharedVault ---
  it("encodeInitSharedVault produces 11 bytes with correct tag", () => {
    const data = encodeInitSharedVault({
      epochDurationSlots: "100000",
      maxMarketExposureBps: 2500,
    });
    expect(data.length).toBe(11);
    expect(data[0]).toBe(IX_TAG.InitSharedVault);
  });

  it("encodeInitSharedVault zero epoch duration and zero exposure", () => {
    const data = encodeInitSharedVault({
      epochDurationSlots: "0",
      maxMarketExposureBps: 0,
    });
    expect(data.length).toBe(11);
    expect(data[0]).toBe(IX_TAG.InitSharedVault);
    // All payload bytes should be zero
    for (let i = 1; i < 11; i++) {
      expect(data[i]).toBe(0);
    }
  });

  // --- PERC-628: AllocateMarket ---
  it("encodeAllocateMarket produces 17 bytes with correct tag", () => {
    const data = encodeAllocateMarket({ amount: "50000000000" });
    expect(data.length).toBe(17);
    expect(data[0]).toBe(IX_TAG.AllocateMarket);
  });

  // --- PERC-628: QueueWithdrawalSV ---
  it("encodeQueueWithdrawalSV produces 9 bytes with correct tag", () => {
    const data = encodeQueueWithdrawalSV({ lpAmount: "1000000" });
    expect(data.length).toBe(9);
    expect(data[0]).toBe(IX_TAG.QueueWithdrawalSV);
  });

  // --- PERC-628: ClaimEpochWithdrawal ---
  it("encodeClaimEpochWithdrawal produces 1 byte with correct tag", () => {
    const data = encodeClaimEpochWithdrawal();
    expect(data.length).toBe(1);
    expect(data[0]).toBe(IX_TAG.ClaimEpochWithdrawal);
  });

  // --- PERC-628: AdvanceEpoch ---
  it("encodeAdvanceEpoch produces 1 byte with correct tag", () => {
    const data = encodeAdvanceEpoch();
    expect(data.length).toBe(1);
    expect(data[0]).toBe(IX_TAG.AdvanceEpoch);
  });
});

// GH#1988: encodeFeedId strict hex validation tests
describe("encodeFeedId (GH#1988 — strict hex validation)", () => {
  // Access via encodeInitMarket which calls encodeFeedId internally
  const ZERO_KEY = new PublicKey(new Uint8Array(32));
  const validFeedId = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
  const validFeedId_0x = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

  // Minimal valid InitMarketArgs using the actual interface fields (v12.15 format)
  const baseArgs = {
    admin: ZERO_KEY, collateralMint: ZERO_KEY,
    maxStalenessSecs: "60", confFilterBps: 50, invert: 0, unitScale: 0, initialMarkPriceE6: "0",
    hMin: "1000", hMax: "2000", maintenanceMarginBps: "500", initialMarginBps: "1000",
    tradingFeeBps: "10", maxAccounts: "1000", newAccountFee: "1000000",
    maintenanceFeePerSlot: "100",
    maxCrankStalenessSlots: "50", liquidationFeeBps: "100", liquidationFeeCap: "10000000",
    liquidationBufferBps: "50", minLiquidationAbs: "1000000",
    minInitialDeposit: "500000", minNonzeroMmReq: "100000", minNonzeroImReq: "200000",
  };

  it("accepts a valid 64-char hex feedId", () => {
    expect(() =>
      encodeInitMarket({ ...baseArgs, indexFeedId: validFeedId })
    ).not.toThrow();
  });

  it("accepts a valid feedId with 0x prefix", () => {
    expect(() =>
      encodeInitMarket({ ...baseArgs, indexFeedId: validFeedId_0x })
    ).not.toThrow();
  });

  it("throws on non-hex characters (GH#1988 — was silently coercing to 0)", () => {
    // A feedId with 'z' in it — was previously accepted, NaN coerced to 0
    const badFeedId = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b4z";
    expect(() =>
      encodeInitMarket({ ...baseArgs, indexFeedId: badFeedId })
    ).toThrow(/must contain only hex characters/);
  });

  it("throws on feedId with spaces", () => {
    const badFeedId = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b4 ";
    expect(() =>
      encodeInitMarket({ ...baseArgs, indexFeedId: badFeedId })
    ).toThrow(/must contain only hex characters/);
  });

  it("throws on feedId that is too short", () => {
    expect(() =>
      encodeInitMarket({ ...baseArgs, indexFeedId: "abcd" })
    ).toThrow(/Invalid feed ID length/);
  });

  it("encodes valid feedId to correct first byte", () => {
    const result = encodeInitMarket({ ...baseArgs, indexFeedId: validFeedId });
    // bytes[65..96] = feedId bytes (after tag(1) + admin(32) + mint(32))
    // First feedId byte = 0xe6 = 230
    expect(result[65]).toBe(0xe6);
  });
});
