/**
 * Pins the wrapper-code / refusal -> user message mapping in lib/limits/user-message.ts.
 * Codes come from the generated WRAPPER_ERR table (rc23), never literals, so a table
 * renumbering shows up here as a changed message, not a silent mismatch.
 * Flags are forced off: this is the plain-wrapper (v2.0 table) path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import {
  keepAppMessage,
  parseFailure,
  plainMessage,
  resolveUserMessage,
  type MessageContext,
} from "@/lib/limits/user-message";

const W = WRAPPER_ERR;
const ids = resolveDevnetProgramIds();
const fail = (code: number, program: string | null = ids.wrapper) =>
  new Error(`${program ? `Program ${program} failed: ` : ""}custom program error: 0x${code.toString(16)}`);
const res = (code: number, ctx: Partial<MessageContext> = {}) => resolveUserMessage(fail(code), { surface: "trade", ...ctx });

beforeEach(() => {
  __setDevnetV21ForTest(false);
  __setDevnetV22ForTest(false);
});
afterEach(() => {
  __setDevnetV21ForTest(null);
  __setDevnetV22ForTest(null);
});

type Row = [string, number, Partial<MessageContext>, string, string]; // name, code, ctx, kind, body fragment
const rows: Row[] = [
  ["EngineNonProgress", W.EngineNonProgress, {}, "nothing-to-do", "already up to date"],
  ["LpVaultNoFeesToCrank", W.LpVaultNoFeesToCrank, {}, "earn-fees-collected", "Fees were just collected"],
  ["EngineInsufficientInitialMargin", W.EngineInsufficientInitialMargin, {}, "insufficient-margin", "Add collateral"],
  ["EngineInsufficientInitialMargin floor", W.EngineInsufficientInitialMargin, { imFloorLabel: "$2" }, "insufficient-margin", "at least $2 of margin"],
  ["EngineInsufficientInitialMargin lpDepleted", W.EngineInsufficientInitialMargin, { health: { lpDepleted: true } }, "lp-depleted", "Closing works normally"],
  ["ExecPriceOutsideOracleBand", W.ExecPriceOutsideOracleBand, {}, "price-moved", "Try a smaller size"],
  ["ExecPriceOutsideOracleBand max", W.ExecPriceOutsideOracleBand, { maxNow: "41.88", symbol: "SOL" }, "price-moved", "Most you can open now: 41.88 SOL."],
  ["SameOwnerTrade", W.SameOwnerTrade, {}, "same-owner", "only close positions"],
  ["LpExposureCapExceeded", W.LpExposureCapExceeded, {}, "too-large", "Try a smaller size"],
  ["ProtocolSideOiCapExceeded", W.ProtocolSideOiCapExceeded, { maxNow: "5" }, "too-large", "Most you can open now: 5."],
  ["VaultLpExposureCapExceeded", W.VaultLpExposureCapExceeded, {}, "too-large", "too large"],
  ["LpFloorHalt trade long", W.LpFloorHalt, { side: "long" }, "side-paused", "no room for more long exposure. Shorts and closes work."],
  ["LpFloorHalt trade short", W.LpFloorHalt, { side: "short" }, "side-paused", "more short exposure. Longs"],
  ["LpFloorHalt close", W.LpFloorHalt, { surface: "close" }, "close-paused", "reopens as other positions close."],
  ["LpFloorHalt close max", W.LpFloorHalt, { surface: "close", maxNow: "3" }, "close-paused", "close 3 now"],
  ["CloseSlabFeesOutstanding", W.CloseSlabFeesOutstanding, {}, "fees-collecting", "Close again in a minute"],
  ["VaultLpAlreadyBound", W.VaultLpAlreadyBound, {}, "setup-not-allowed", "doesn't allow that"],
  ["VaultLpNotBound", W.VaultLpNotBound, {}, "setup-not-allowed", "doesn't allow that"],
  ["VaultLpBoundCannotClose", W.VaultLpBoundCannotClose, {}, "setup-not-allowed", "doesn't allow that"],
  ["VaultLpMatcherNotApproved", W.VaultLpMatcherNotApproved, {}, "setup-not-allowed", "doesn't allow that"],
  ["VaultLpUseSettleResolved", W.VaultLpUseSettleResolved, {}, "setup-not-allowed", "doesn't allow that"],
  ["VaultLpMultiAssetMarket", W.VaultLpMultiAssetMarket, {}, "setup-not-allowed", "doesn't allow that"],
  ["VaultLpSeniorImpaired", W.VaultLpSeniorImpaired, {}, "earn-deposits-paused", "Withdrawals still work"],
  ["VaultLpJuniorWithdrawRefused", W.VaultLpJuniorWithdrawRefused, {}, "stake-locked", "Locked while traders"],
  ["VaultLpRecallRefused", W.VaultLpRecallRefused, {}, "try-later", "Nothing was sent"],
  ["VaultLpExclusiveCounterparty", W.VaultLpExclusiveCounterparty, {}, "route-unavailable", "route isn't available"],
  ["VaultLpLeverageStepDown", W.VaultLpLeverageStepDown, {}, "lower-leverage", "Leverage for new longs is lower"],
  ["VaultLpLeverageStepDown cap", W.VaultLpLeverageStepDown, { maxLeverage: 5, side: "short" }, "lower-leverage", "Up to 5× for new shorts"],
  ["VaultLpReleaseRefused", W.VaultLpReleaseRefused, {}, "stake-nothing", "Nothing to withdraw above"],
  ["VaultLpHarvestPending", W.VaultLpHarvestPending, {}, "earn-fees-collecting", "Collecting the vault's latest fees"],
  ["VaultLpValuationStale", W.VaultLpValuationStale, {}, "earn-value-updating", "Updating the vault's value"],
  ["VaultLpSeniorDrawRequired", W.VaultLpSeniorDrawRequired, {}, "earn-booking-move", "booking a recent market move"],
  ["VaultLpRedeemNeedsRecall", W.VaultLpRedeemNeedsRecall, {}, "earn-in-use", "The rest is available once"],
  ["VaultLpRedeemNeedsRecall max", W.VaultLpRedeemNeedsRecall, { maxNow: "7" }, "earn-in-use", "up to 7 now"],
  ["EngineCounterUnderflow withdraw", W.EngineCounterUnderflow, { surface: "earn-withdraw" }, "earn-payout-split", "other side"],
  ["EngineCounterUnderflow deposit", W.EngineCounterUnderflow, { surface: "earn-deposit" }, "earn-deposit-settling", "can't take new deposits"],
  ["EngineCounterUnderflow elsewhere", W.EngineCounterUnderflow, { surface: "trade" }, "unmapped", "Something went wrong"],
  ["LpVaultTargetPotImpaired withdraw", W.LpVaultTargetPotImpaired, { surface: "earn-withdraw" }, "earn-withdraw-retry", "couldn't go through just now"],
  ["LpVaultTargetPotImpaired deposit", W.LpVaultTargetPotImpaired, { surface: "earn-deposit" }, "earn-pot-impaired", "Earn deposits are paused"],
  ["VaultLpBindRequiresFlatAsset", W.VaultLpBindRequiresFlatAsset, {}, "setup-not-allowed", "open positions"],
  ["VaultLpPausedForSeniorDraw", W.VaultLpPausedForSeniorDraw, {}, "paused-earn-covers-loss", "Earn covers a loss"],
  ["LpVaultCooldownActive", W.LpVaultCooldownActive, {}, "earn-cooldown", "Ready in a moment."],
  ["LpVaultCooldownActive 75s", W.LpVaultCooldownActive, { cooldownSecs: 75 }, "earn-cooldown", "Ready in 1:15."],
  ["LpVaultOiReservationViolated", W.LpVaultOiReservationViolated, {}, "earn-partial-now", "Part of this is available now"],
  ["LpVaultOiReservationViolated max", W.LpVaultOiReservationViolated, { maxNow: "9" }, "earn-partial-now", "up to 9 now"],
  ["LpVaultZeroAmount", W.LpVaultZeroAmount, {}, "amount-zero", "greater than zero"],
  ["LpVaultInsufficientShares", W.LpVaultInsufficientShares, {}, "amount-too-large", "more than your Earn balance"],
  ["LpVaultZeroSharesMinted", W.LpVaultZeroSharesMinted, {}, "amount-too-small", "too small"],
  ["LpVaultDepositBelowMinimumLiquidity", W.LpVaultDepositBelowMinimumLiquidity, {}, "amount-too-small", "too small"],
  ["CreatorFeeOverClaim", W.CreatorFeeOverClaim, {}, "claim-too-much", "fees available to claim"],
  ["Unauthorized", W.Unauthorized, {}, "wrong-wallet", "Switch to the wallet"],
  ["unlisted wrapper code", 9999, {}, "unmapped", "nothing was sent"],
];

describe("wrapper code -> message (v2.0 table)", () => {
  it.each(rows)("%s", (_n, code, ctx, kind, frag) => {
    const u = res(code, ctx);
    expect(u.kind).toBe(kind);
    expect(u.body).toContain(frag);
    expect(u.details.code).toBe(code);
    expect(`${u.title} ${u.body}`).not.toMatch(/Custom|0x[0-9a-f]+|error \d+/i);
  });

  it("use-max actions carry the formatted amount", () => {
    expect(res(W.ExecPriceOutsideOracleBand, { maxNow: "4" }).action).toEqual({ id: "use-max", label: "Use 4" });
    expect(res(W.VaultLpRedeemNeedsRecall, { maxNow: "7" }).action).toEqual({ id: "use-max", label: "Withdraw 7" });
    expect(res(W.LpFloorHalt, { surface: "close", maxNow: "3" }).action?.id).toBe("use-max");
    expect(res(W.SameOwnerTrade).action).toBeUndefined();
  });

  it("a code is only decoded when the wrapper raised it", () => {
    for (const program of [null, ids.matcher]) {
      const u = resolveUserMessage(fail(W.SameOwnerTrade, program), { surface: "trade" });
      expect(u.kind).toBe("unmapped");
      expect(u.details.name).toBeNull();
    }
    expect(res(W.SameOwnerTrade).details.name).toBe("SameOwnerTrade");
  });
});

describe("stale family (19/20/21/26/27)", () => {
  it("trade waits and auto-retries; other surfaces do not", () => {
    for (const code of [W.EngineStale, W.EngineBStale]) {
      const t = res(code);
      expect([t.kind, t.autoRetry]).toEqual(["engine-catching-up", true]);
      expect(t.body).toContain("goes through automatically");
      const c = res(code, { surface: "close" });
      expect([c.kind, c.autoRetry]).toEqual(["engine-catching-up", undefined]);
      expect(c.body).not.toContain("automatically");
    }
  });

  it("a catch-up wait longer than the hold budget drops the automatic promise", () => {
    expect(res(W.EngineStale, { catchUpMs: 9 * 60_000 }).body).not.toContain("automatically");
    expect(res(W.EngineStale, { catchUpMs: 60_000 }).body).toContain("automatically");
  });

  it("oracle stale / invalid wait for a fresh price", () => {
    for (const code of [W.OracleStale, W.OracleInvalid]) {
      const u = res(code);
      expect([u.kind, u.autoRetry]).toEqual(["price-wait", true]);
    }
  });

  it("a settled market is final for every member of the family", () => {
    for (const code of [W.EngineStale, W.EngineBStale, W.EngineLockActive, W.OracleStale, W.OracleInvalid]) {
      expect(res(code, { health: { resolved: true } }).kind).toBe("market-settled");
    }
  });

  it("a long price stall is not 'a few seconds'", () => {
    expect(res(W.EngineStale, { priceAgeSecs: 100_000 }).kind).toBe("price-stalled");
  });
});

describe("EngineLockActive (21) by surface and health", () => {
  const cases: Array<[string, Partial<MessageContext>, string]> = [
    ["earn-withdraw p3Bound", { surface: "earn-withdraw", p3Bound: true }, "earn-payout-wait"],
    ["earn-withdraw", { surface: "earn-withdraw" }, "earn-in-use"],
    ["earn-deposit", { surface: "earn-deposit" }, "earn-deposit-wait"],
    ["trade adl", { health: { adlReduceOnly: true } }, "adl-reduce-only"],
    ["trade lpDepleted", { health: { lpDepleted: true, lpIsVault: true } }, "lp-depleted"],
    ["trade lossStale", { health: { lossStale: true } }, "loss-stale"],
    ["trade plain", {}, "engine-catching-up"],
    ["close plain", { surface: "close" }, "engine-catching-up"],
    ["close adl does not apply", { surface: "close", health: { adlReduceOnly: true } }, "engine-catching-up"],
  ];
  it.each(cases)("%s", (_n, ctx, kind) => {
    expect(res(W.EngineLockActive, ctx).kind).toBe(kind);
  });
  it("trade waits, close does not", () => {
    expect(res(W.EngineLockActive).autoRetry).toBe(true);
    expect(res(W.EngineLockActive, { surface: "close" }).autoRetry).toBeUndefined();
  });
});

describe("one-shot form of waitable lines", () => {
  it("never promises an automatic send", () => {
    const u = res(W.EngineStale, { oneShot: true });
    expect(u.autoRetry).toBe(false);
    expect(u.body).toMatch(/Nothing was sent/);
    expect(u.body).not.toMatch(/automatically/);
    const p = resolveUserMessage(new Error("live mark price unavailable"), { surface: "trade", oneShot: true });
    expect(p.body).toContain("Try again in a few seconds");
  });
  it("leaves non-waitable and still-confirming lines alone", () => {
    expect(res(W.SameOwnerTrade, { oneShot: true }).kind).toBe("same-owner");
    const c = resolveUserMessage(new Error("confirmation timeout"), { surface: "trade", oneShot: true });
    expect([c.kind, c.autoRetry]).toEqual(["still-confirming", true]);
  });
});

describe("matcher codes", () => {
  const matcher = (code: number, program = ids.matcher) =>
    resolveUserMessage(new Error(`Program ${program} failed: custom program error: 0x${code.toString(16)}`), { surface: "trade" });
  it("8002 / 8003 wait for a price; 8004 is unavailable", () => {
    for (const c of [8002, 8003]) expect([matcher(c).kind, matcher(c).autoRetry]).toEqual(["price-wait", true]);
    expect(matcher(8004).kind).toBe("market-unavailable");
  });
  it("matcher numbers from another program are not decoded", () => {
    expect(matcher(8004, ids.wrapper).kind).toBe("unmapped");
  });
});

describe("errors with no program code", () => {
  const kindOf = (e: unknown, ctx: Partial<MessageContext> = {}) => resolveUserMessage(e, { surface: "trade", ...ctx });
  const named = (name: string, message = "m") => Object.assign(new Error(message), { name });

  const textRows: Array<[string, string, string]> = [
    ["user rejected the request", "cancelled", "Cancelled."],
    ["wallet is locked", "wallet-locked", "Unlock your wallet"],
    ["insufficient lamports", "insufficient-sol", "little SOL"],
    ["NotEnoughAccountKeys", "out-of-date", "out of date"],
    ["Blockhash not found", "network-slow", "network was slow"],
    ["Wallet did not say whether this transaction was sent", "still-confirming", "may still have gone through"],
    ["confirmation timeout", "still-confirming", "Still confirming"],
    ["429 rate limit exceeded", "network-busy", "busy"],
    ["failed to fetch", "rpc-unreachable", "Couldn't reach Solana"],
    ["slippage exceeded", "price-moved", "price moved while you"],
    ["No LP portfolio with an active matcher config", "market-not-ready", "isn't taking trades"],
    ["Couldn't reach Solana to check this order", "rpc-unreachable", "check this order"],
    ["No portfolio account found for your wallet", "no-account", "Deposit once"],
    ["Failed to scan LP portfolio", "rpc-unreachable", "read the market"],
    ["Account not found: AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr", "out-of-date", "Part of this market"],
    ["Trade already in progress", "in-progress", "still being sent"],
    ["not the recognized percolator matcher", "unsupported-market", "isn't supported"],
    ["does not support signAllTransactions or signTransaction", "wallet-unsupported", "can't sign"],
    ["Market not loaded", "market-loading", "still loading"],
    ["Deposit amount exceeds your wallet balance", "amount-too-large", "wallet holds"],
    ["Earn payout above what the vault can pay now", "earn-max-now", "Withdraw the max"],
    ["live mark price unavailable", "price-wait", "live price"],
    ["something nobody mapped", "unmapped", "nothing was sent"],
  ];
  it.each(textRows)("%s", (text, kind, frag) => {
    const u = kindOf(new Error(text));
    expect(u.kind).toBe(kind);
    expect(u.body).toContain(frag);
  });

  it("cancellation is quiet; stop is quiet", () => {
    expect(kindOf(new Error("User rejected the request")).quiet).toBe(true);
    const s = kindOf(named("WaitStoppedError"));
    expect([s.kind, s.quiet]).toEqual(["stopped", true]);
  });

  it("insufficient SOL names rent and the shortfall when the message does", () => {
    const u = kindOf(new Error("Not enough SOL: ~0.0153 SOL account rent. Please add at least 0.0042 SOL"));
    expect(u.title).toBe("Need SOL for account rent");
    expect(u.body).toContain("~0.02 SOL"); // >= 0.01 rounds to 2 places
    expect(u.body).toContain("0.005 SOL"); // shortfall rounded up to the next 0.001
    expect(kindOf(new Error("insufficient sol ~0.0021 SOL account rent add at least 0.002 SOL")).body).toContain("~0.0021 SOL");
    expect(u.action?.id).toBe("get-funds");
    const big = kindOf(new Error("insufficient sol ~0.5 SOL account rent add at least 0.0001 SOL"));
    expect(big.body).toContain("~0.50 SOL");
    expect(big.body).toContain("0.001 SOL");
  });

  it("wallet-locked uses the wallet name", () => {
    expect(kindOf(new Error("wallet is locked"), { walletName: "Phantom" }).body).toBe("Unlock Phantom and try again.");
  });

  const namedRows: Array<[string, string, string]> = [
    ["EarnDepositsPausedError", "earn-pot-impaired", "Deposits paused"],
    ["MarketTailMismatchError", "market-tail", "Not available yet"],
    ["WalletRequestClosedError", "wallet-request-closed", "Try again"],
    ["FeeChangedAfterReviewError", "fee-changed-after-review", "Fee changed"],
    ["BusyFeeRoseError", "busy-fee-rose", "Fee changed"],
    ["BusyFeeUnreadableError", "busy-fee-unreadable", "Not sent"],
    ["UtilFeeOverMaxError", "side-too-busy", "Side too busy"],
    ["HealthCheckStaleError", "health-check-stale", "Not sent"],
    ["WaitExhaustedError", "wait-exhausted", "Not sent"],
    ["WrongClusterError", "wrong-cluster", "Wrong network"],
    ["FeedDisagreementError", "prices-out-of-sync", ""],
  ];
  it.each(namedRows)("%s", (name, kind, title) => {
    const u = kindOf(named(name, "custom text"));
    expect(u.kind).toBe(kind);
    if (title) expect(u.title).toBe(title);
  });
  it("typed errors pass their own message through where the copy is theirs", () => {
    expect(kindOf(named("BusyFeeRoseError", "fee rose to 9 bps")).body).toBe("fee rose to 9 bps");
    expect(kindOf(named("WrongClusterError", "switch to devnet")).action?.id).toBe("refresh");
  });
});

describe("parseFailure", () => {
  it("reads hex, JSON and paren code shapes, and the failing program", () => {
    expect(parseFailure(new Error("custom program error: 0x1f")).code).toBe(31);
    expect(parseFailure(new Error('{"InstructionError":[0,{"Custom":77}]}')).code).toBe(77);
    expect(parseFailure(new Error("Custom(12)")).code).toBe(12);
    expect(parseFailure(new Error(`Program ${ids.wrapper} failed: x`)).programId).toBe(ids.wrapper);
    expect(parseFailure({ message: "m", logs: [1, "b"] }).logs).toEqual(["1", "b"]);
    expect(parseFailure("plain").raw).toBe("plain");
    expect(parseFailure({ name: "SimulationRefusal", code: 5, programId: "P" })).toMatchObject({ code: 5, programId: "P" });
  });
  it("serialises odd inputs without throwing", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(typeof parseFailure(cyc).raw).toBe("string");
    expect(parseFailure(undefined).raw).toBe("undefined");
    expect(() => resolveUserMessage(null, { surface: "any" })).not.toThrow();
  });
});

describe("plainMessage / keepAppMessage", () => {
  it("returns the resolver body, or the fallback only when unmapped", () => {
    expect(plainMessage(fail(W.SameOwnerTrade), { surface: "trade" }, () => "fb")).toContain("only close");
    expect(plainMessage(new Error("odd"), { surface: "trade" }, (r) => `fb:${r}`)).toBe("fb:odd");
    expect(plainMessage(new Error("odd"), { surface: "trade" })).toContain("nothing was sent");
  });
  it("keeps plain app text and hides raw chain text", () => {
    expect(keepAppMessage("Enter an amount greater than zero.")).toBe("Enter an amount greater than zero.");
    for (const raw of ["", "custom program error: 0x1", "Custom(5)", "InstructionError"]) {
      expect(keepAppMessage(raw)).toBe("Something went wrong and nothing was sent.");
    }
  });
});
