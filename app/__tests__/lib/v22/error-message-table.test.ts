/**
 * Table pin for lib/v22/error-message.ts: every Custom code it maps is checked against the program tables.
 *
 * Wrapper: percolator-prog feat/v22-rc23-2026-10-22 @ d27f3d73, src/v16_program.rs `enum PercolatorError` (line numbers below
 * are the variant lines at that commit; ordinals were counted from the enum and cross-checked against its own
 * `assert!(PercolatorError::X as u32 == N)` lines, 0 mismatches over 137 variants 0..=136).
 * Stake: percolator-stake release/v22-stake @ 9712e3c src/error.rs (3..=45); 46..=48 come from the installed SDK table.
 * Custom 137 is only in prog #695 and is NOT counted here.
 */
import { describe, expect, it } from "vitest";
import { v22StakeMessage, v22WrapperMessage } from "@/lib/v22/error-message";
import type { UserMessage } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { WRAPPER_ERR_V21 } from "@/lib/v21/wrapper-errors";
import { STAKE_ERR_V5, WRAPPER_ERR_V22 } from "@/lib/v22/wrapper-errors";
import { STAKE_ERRORS_V5 } from "@/lib/v22/sdk";
import * as M from "@/lib/v22/error-message";

const build = (kind: string, variant: UserMessage["variant"], title: string, body: string, extra?: Partial<UserMessage>): UserMessage =>
  ({ kind, variant, title, body, ...extra }) as UserMessage;
const wrap = (code: number, ctx: Record<string, unknown> = { surface: "earn-deposit" }) => v22WrapperMessage(code, ctx as never, build);

/** [prog variant name, ordinal, v16_program.rs line] for every code error-message.ts maps. */
const PROG_WRAPPER: ReadonlyArray<readonly [string, number, number]> = [
  ["InvalidInstruction", 9, 1467],
  ["OracleConfTooWide", 28, 1486],
  ["InvalidOracleKey", 29, 1487],
  ["GrowthCapacityFull", 93, 1804],
  ["PriceBandPinned", 104, 1942],
  ["PriceBandConfigInvalid", 105, 1945],
  ["HoldingRentConfigInvalid", 106, 1948],
  ["BondTrancheImpaired", 107, 1897],
  ["BondCapacityLocked", 108, 1903],
  ["BondWithdrawCooldown", 109, 1906],
  ["BondConfigInvalid", 110, 1910],
  ["PriceBandPositionCap", 111, 1952],
  ["PriceBandTooNarrow", 112, 1955],
  ["PriceBandLegBelowMinNotional", 113, 1959],
  ["RescueRefused", 114, 1923],
  ["RescueNavFloor", 115, 1927],
  ["InsuranceBackstopRefused", 116, 1932],
  ["RedemptionBelowMinPayout", 117, 1880],
  ["ExitRequiresLossCurrent", 118, 1886],
  ["LotConfigInvalid", 119, 1890],
  ["BondDepositAboveCap", 123, 1913],
  ["BondSlippage", 124, 1915],
  ["G9AllowlistTimelock", 125, 1964],
  ["PositionCapReached", 126, 1977],
  ["CounterpartyPositionCapReached", 127, 1981],
  ["DepthInputInvalid", 128, 1989],
  ["DepthSourceInvalid", 129, 1997],
  ["GrowthTierConfigInvalid", 130, 2006],
  ["CreatorStakeBelowMinimum", 131, 2012],
  ["LevGuardRequired", 132, 2016],
  ["LevGuardRefused", 133, 2020],
  ["LevGuardInvalid", 134, 2023],
  ["LpStopNotTriggered", 135, 2026],
];

/** Wrapper code -> the message `kind` it must produce (the case in v22WrapperMessage, read per code). */
const WRAPPER_KIND: Readonly<Record<number, string>> = {
  28: "price-unsteady",
  29: "feed-mismatch",
  93: "growth-capacity-full",
  104: "band-catching-up",
  105: "band-config",
  106: "rent-config",
  107: "bond-impaired",
  108: "bond-locked",
  109: "bond-cooldown",
  110: "bond-config",
  111: "band-side-full",
  112: "band-close-only",
  113: "band-below-min",
  114: "rescue-refused",
  115: "rescue-floor",
  116: "backstop-refused",
  117: "exit-requote",
  118: "exit-refreshing",
  119: "lot-config",
  123: "bond-full",
  124: "bond-requote",
  125: "g9-timelock",
  126: "position-cap",
  127: "counterparty-cap",
  128: "depth-input",
  129: "depth-source",
  130: "tier-config",
  131: "lev-guard-creator-stake",
  132: "lev-guard-required",
  133: "lev-guard-refused",
  134: "lev-guard-invalid",
  135: "lp-stop-not-triggered",
};

/** Stake code -> [percolator-stake error.rs variant, line, message kind]. 3..=45 from release/v22-stake @ 9712e3c. */
const PROG_STAKE: ReadonlyArray<readonly [number, string, number, string]> = [
  [3, "CooldownNotElapsed", 13, "stake-cooldown"],
  [8, "MarketResolved", 23, "stake-market-settled"],
  [9, "DepositCapExceeded", 25, "stake-cap"],
  [19, "TrancheNotEnabled", 45, "stake-no-tiers"],
  [21, "WrongTranche", 49, "stake-wrong-tier"],
  [28, "DepositBelowMinimumLiquidity", 87, "stake-min-first-deposit"],
  [29, "NoRealLpHolders", 93, "stake-no-holders"],
  [33, "ConsentRequired", 113, "stake-consent"],
  [34, "DeprecatedV5", 116, "stake-DeprecatedV5"],
  [35, "InsuranceUnitsInvalid", 120, "stake-InsuranceUnitsInvalid"],
  [36, "LiquidityBufferExhausted", 123, "stake-liquidity"],
  [37, "SyncCooldownActive", 125, "stake-sync"],
  [38, "InvalidDeployConfig", 128, "stake-InvalidDeployConfig"],
  [39, "NotProtocolAuthority", 131, "stake-NotProtocolAuthority"],
  [40, "NoPendingDeployTarget", 133, "stake-NoPendingDeployTarget"],
  [41, "NotSupportedOnFirstLoss", 136, "stake-NotSupportedOnFirstLoss"],
  [42, "AssetAdminNotBurned", 139, "stake-AssetAdminNotBurned"],
  [43, "NothingToSync", 141, "stake-sync"],
  [44, "InsuranceReadingsDiverged", 146, "stake-lent"],
  [45, "InsuranceUnitsMismatch", 149, "stake-InsuranceUnitsMismatch"],
  [46, "CreatorAccountRequired", 0, "stake-CreatorAccountRequired"],
  [47, "InsuranceCustodyNotBound", 0, "stake-InsuranceCustodyNotBound"],
  [48, "MultiAssetMarketNotSupported", 0, "stake-MultiAssetMarketNotSupported"],
];

describe("v22WrapperMessage: every case matches the prog enum", () => {
  const appCode: Record<string, number> = { ...WRAPPER_ERR_V22, ...WRAPPER_ERR_V21, InvalidInstruction: WRAPPER_ERR.InvalidInstruction, OracleConfTooWide: WRAPPER_ERR.OracleConfTooWide, InvalidOracleKey: WRAPPER_ERR.InvalidOracleKey };

  it.each(PROG_WRAPPER)("%s is Custom(%i) (v16_program.rs:%i) in the app's constants", (name, code) => {
    expect(appCode[name]).toBe(code);
  });

  it.each(Object.entries(WRAPPER_KIND).map(([c, k]) => [Number(c), k] as const))("Custom(%i) produces %s", (code, kind) => {
    const r = wrap(code);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe(kind);
    expect(r?.body.length).toBeGreaterThan(0);
  });

  it("maps the prog name to the right kind (name and code agree, not just the code)", () => {
    for (const [name, code] of PROG_WRAPPER) {
      if (code === 9) continue; // the bare 9 is covered below
      expect(wrap(code), `${name} (${code})`).not.toBeNull();
    }
  });

  it("a bare Custom(9) off the ticket is refused plainly; on the trade ticket it stays unmapped on purpose", () => {
    expect(wrap(9, { surface: "earn-deposit" })?.kind).toBe("request-refused");
    expect(wrap(9, { surface: "trade" })).toBeNull();
  });

  it("codes outside the table are unmapped, including 120..=122 (v2.1 path), 136 (rc23 CreatorFeePayeeInvalid) and 137 (#695 only)", () => {
    for (const c of [0, 1, 8, 10, 27, 30, 92, 94, 99, 100, 101, 102, 103, 120, 121, 122, 136, 137, 999]) {
      expect(wrap(c, { surface: "earn-deposit" }), `Custom(${c})`).toBeNull();
    }
  });

  it("lock/wait-style errors never tell the user to add margin or collateral", () => {
    for (const code of [104, 108, 109, 111, 112, 118, 124, 125, 132, 133]) {
      const r = wrap(code);
      expect(`${r?.title} ${r?.body}`, `Custom(${code})`).not.toMatch(/add (more )?(margin|collateral|funds)|top up|deposit more/i);
    }
  });

  it("variants: 104 waits (not an error), 117/124 re-quote, 118 retries itself, 117 does not", () => {
    expect(wrap(104)?.variant).toBe("wait");
    expect(wrap(117)).toMatchObject({ requote: true, autoRetry: true });
    expect(wrap(124)?.requote).toBe(true);
    expect(wrap(124)?.autoRetry).toBeUndefined();
    expect(wrap(118)?.autoRetry).toBe(true);
  });

  it("113 names the market minimum when it is known, and falls back when not", () => {
    expect(wrap(113, { surface: "trade", minPositionLabel: "$5" })?.body).toContain("$5");
    expect(wrap(113)?.body).toContain("market minimum");
  });

  it("133 reads the lev-guard reason from the logs and picks wait vs error", () => {
    const withLogs = (why: string) => wrap(133, { surface: "trade", levGuardLogs: [`Program log: lev_guard_refused ${why}`] });
    expect(withLogs("age_under_6h")?.variant).toBe("wait");
    expect(withLogs("lp_stop_round")?.variant).toBe("wait");
    expect(wrap(133, { surface: "trade" })?.variant).toBe("paused");
  });
});

describe("v22StakeMessage: every case matches the stake error enum", () => {
  const m = build;

  it.each(PROG_STAKE)("Custom(%i) is %s (percolator-stake error.rs:%i) and shows %s", (code, name, _line, kind) => {
    const r = v22StakeMessage(code, m);
    expect(r?.kind).toBe(kind);
    if (code >= 33) expect(STAKE_ERRORS_V5[code]?.name).toBe(name);
  });

  it("the named constants carry the prog ordinals", () => {
    expect(M.STAKE_ERR_COOLDOWN_NOT_ELAPSED).toBe(3);
    expect(M.STAKE_ERR_MARKET_RESOLVED).toBe(8);
    expect(M.STAKE_ERR_DEPOSIT_CAP_EXCEEDED).toBe(9);
    expect(M.STAKE_ERR_TRANCHE_NOT_ENABLED).toBe(19);
    expect(M.STAKE_ERR_WRONG_TRANCHE).toBe(21);
    expect(M.STAKE_ERR_NO_REAL_HOLDERS).toBe(29);
    expect(STAKE_ERR_V5.ConsentRequired).toBe(33);
    expect(STAKE_ERR_V5.LiquidityBufferExhausted).toBe(36);
    expect(STAKE_ERR_V5.SyncCooldownActive).toBe(37);
    expect(STAKE_ERR_V5.NothingToSync).toBe(43);
    expect(STAKE_ERR_V5.InsuranceReadingsDiverged).toBe(44);
  });

  it("unmapped stake codes return null (so the generic line shows instead of a wrong specific one)", () => {
    for (const c of [0, 1, 2, 4, 5, 6, 7, 10, 18, 20, 22, 27, 30, 31, 32, 49, 50, 999]) expect(v22StakeMessage(c, m), `Custom(${c})`).toBeNull();
  });

  it("consent asks the user to review; the deposit-cap line is honest about both causes", () => {
    expect(v22StakeMessage(33, m)).toMatchObject({ variant: "wait", action: { id: "refresh", label: "Review" } });
    expect(v22StakeMessage(9, m)?.body).toMatch(/deposit limit/);
    expect(v22StakeMessage(8, m)?.body).toMatch(/can still withdraw/);
  });
});
