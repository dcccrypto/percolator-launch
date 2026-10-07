/**
 * Two launch failures seen together on devnet, 2026-10-06 (wallet 9sM73…, three launches):
 *
 * 1. The keeper hand-off tx landed in 4 s, but the step waited on
 *    `connection.confirmTransaction(sig)` and reported a confirmation timeout.
 * 2. The launch only reached that code because /api/devnet-pre-fund answered 429 and the
 *    batch fell back to the sequential path, which asks the same route at its deposit
 *    step. It would have created the market, locked its rent, and then been refused.
 *    The refusal is judged against what THIS launch needs (classifyPreFundRefusal): a
 *    wallet that already covers it proceeds, and only the claim window blocks.
 *
 * Source scans for the wiring (the code sits behind a wallet and a live connection, see
 * useCreateMarket-batch-fallback-wiring.test.ts), behaviour tests for the message.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PreFundRateLimitedError, preFundRateLimitedMessage, describeBatchFallback } from "@/hooks/useCreateMarket";
import {
  classifyPreFundRefusal, fullMarketRequirement, fundingRequirement, PREFUND_GATE_ERROR, PREFUND_WINDOW_MS,
} from "@/lib/prefund-requirement";
import { PREFUND_CLAIM_TTL_MS } from "@/lib/prefund-claim-store";

const src = readFileSync(resolve(process.cwd(), "hooks/useCreateMarket.ts"), "utf8");
const batchStart = src.indexOf("async function attemptFreshBatchedLaunch");
const batchEnd = src.indexOf("\nconst STEP_LABELS", batchStart);
const batch = src.slice(batchStart, batchEnd);
const sequential = src.slice(batchEnd);
const step0 = sequential.slice(
  sequential.indexOf("// Step 0: Create slab"),
  sequential.indexOf("// Step 1: Oracle setup"),
);
const step1 = sequential.slice(
  sequential.indexOf("// Step 1: Oracle setup"),
  sequential.indexOf("// Step 2: v17 LP init sequence"),
);

describe("the source scan is scanning something", () => {
  it("has locatable bounds", () => {
    expect(batchStart).toBeGreaterThan(-1);
    expect(batchEnd).toBeGreaterThan(batchStart);
    expect(step0.length).toBeGreaterThan(1_000);
    expect(step1.length).toBeGreaterThan(5_000);
  });
});

describe("keeper hand-off confirmation", () => {
  it("confirms by polling, never by the websocket-backed confirmTransaction", () => {
    expect(step1).toContain("const keeperDelegateSig = await broadcastSignedTx(connection, signedTx");
    expect(step1).not.toContain("connection.confirmTransaction(keeperDelegateSig");
  });
});

describe("classifyPreFundRefusal — what a refusal means for this launch", () => {
  const gate = { status: 429, body: { error: PREFUND_GATE_ERROR, nextClaimAt: "2026-10-07T00:23:09.569Z" } };
  const small = { lpCollateral: 100_000_000n, insuranceAmount: 10_000_000n };
  const smallNeed = fullMarketRequirement(small.lpCollateral, small.insuranceAmount);

  it("a wallet that already covers a small launch proceeds, though the route (floored at a default launch) refused", () => {
    // The route judges against fundingRequirement's default-launch floor; this launch needs far less.
    expect(smallNeed).toBeLessThan(fundingRequirement(small.lpCollateral, small.insuranceAmount));
    expect(classifyPreFundRefusal({ ...gate, ...small, balance: smallNeed })).toEqual({ kind: "proceed" });
    // ...and a non-429 failure is equally irrelevant to a wallet that needs nothing.
    expect(classifyPreFundRefusal({ status: 500, body: null, ...small, balance: smallNeed })).toEqual({ kind: "proceed" });
  });

  it("short and inside the claim window is blocked, with the time", () => {
    expect(classifyPreFundRefusal({ ...gate, ...small, balance: smallNeed - 1n })).toEqual({
      kind: "blocked",
      nextClaimAt: gate.body.nextClaimAt,
    });
    // The fallback claim store answers with the same text; a missing time must not unblock it.
    expect(classifyPreFundRefusal({ status: 429, body: { error: PREFUND_GATE_ERROR }, ...small, balance: 0n })).toEqual({
      kind: "blocked",
      nextClaimAt: null,
    });
  });

  it("the per-IP limiter and the edge limiter are 429s too, and are NOT the claim window", () => {
    const perIp = { status: 429, body: { error: "Too many requests. Please slow down and try again shortly." } };
    expect(classifyPreFundRefusal({ ...perIp, ...small, balance: 0n })).toEqual({ kind: "error" });
    expect(classifyPreFundRefusal({ status: 429, body: null, ...small, balance: 0n })).toEqual({ kind: "error" });
  });

  it("the claim-window text on another status is not treated as the gate", () => {
    expect(classifyPreFundRefusal({ status: 500, body: { error: PREFUND_GATE_ERROR }, ...small, balance: 0n })).toEqual({ kind: "error" });
  });

  it("the route really does send the text this keys on", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/devnet-pre-fund/route.ts"), "utf8");
    expect(route.split(`{ error: "${PREFUND_GATE_ERROR}", nextClaimAt`).length - 1).toBe(2);
  });
});

describe("the claim window is the faucet's hour, on both gates", () => {
  it("is one hour and shared by the Supabase gate and the fallback store", () => {
    expect(PREFUND_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(PREFUND_CLAIM_TTL_MS).toBe(PREFUND_WINDOW_MS);
    const route = readFileSync(resolve(process.cwd(), "app/api/devnet-pre-fund/route.ts"), "utf8");
    expect(route).toContain("tryFaucetGate(supabaseForGate, walletAddress, fundType, PREFUND_WINDOW_MS)");
    expect(route).toContain("reserveClaim(rateKey, PREFUND_CLAIM_TTL_MS)");
  });
});

describe("wiring: a blocked launch ends before anything is sent", () => {
  it("the batch path classifies against the real balance, and only 'blocked' is fatal", () => {
    expect(batch).toContain("const refusal = classifyPreFundRefusal({");
    expect(batch).toContain("balance: await collateralBalanceOf(connection, params.mint, walletPk)");
    expect(batch).toContain('if (refusal.kind === "blocked") throw new PreFundRateLimitedError(refusal.nextClaimAt);');
    const guard = batch.indexOf("if (!broadcastStarted && err instanceof PreFundRateLimitedError)");
    const fallback = batch.indexOf('return { status: "fallback", reason };');
    expect(guard).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(guard);
    const fatal = batch.slice(guard, fallback);
    expect(fatal).toContain('return { status: "fatal" };');
    expect(fatal).toContain('phase: "idle"');
  });

  it("the sequential path asks before it creates the market, on fresh launches only", () => {
    const gateAt = step0.indexOf("if (isDevnetEnv && retryFromStep === undefined) {");
    const refuse = step0.indexOf('if (refusal0.kind === "blocked") throw new PreFundRateLimitedError(');
    const persist = step0.indexOf("// Persist recovery state BEFORE sending TX0.");
    expect(gateAt).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(gateAt);
    expect(persist).toBeGreaterThan(refuse);
  });

  it("the sequential catch shows the refusal message rather than a step failure", () => {
    const at = sequential.indexOf("if (e instanceof PreFundRateLimitedError)");
    expect(at).toBeGreaterThan(-1);
    expect(sequential.slice(at, at + 200)).toContain("preFundRateLimitedMessage(e.nextClaimAt)");
  });

  it("no launch confirmation is left on the websocket-backed confirmTransaction", () => {
    expect(src).not.toMatch(/connection\.confirmTransaction\(\w+, "confirmed"\)/);
    expect(src.split("await confirmSignatureByPolling(connection, airdropSig").length - 1).toBe(2);
  });
});

describe("preFundRateLimitedMessage", () => {
  it("says nothing was sent and gives a time, without a raw ISO timestamp", () => {
    const iso = "2026-10-07T23:23:09.569Z";
    const msg = preFundRateLimitedMessage(iso);
    expect(msg).toContain("Nothing was sent.");
    expect(msg).toContain("More arrive after");
    expect(msg).not.toContain(iso);
  });

  it("omits the time when there is none or it is unparseable", () => {
    expect(preFundRateLimitedMessage(null)).not.toContain("More arrive after");
    expect(preFundRateLimitedMessage("not-a-date")).not.toContain("More arrive after");
  });

  it("the typed error still reads as a pre-fund refusal to the fallback describer", () => {
    expect(describeBatchFallback(new PreFundRateLimitedError(null))).toContain("Already pre-funded recently");
  });
});
