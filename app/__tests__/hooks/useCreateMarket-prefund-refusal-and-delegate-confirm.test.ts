/**
 * Two launch failures seen together on devnet, 2026-10-06 (wallet 9sM73…, three launches):
 *
 * 1. The keeper hand-off tx landed in 4 s, but the step waited on
 *    `connection.confirmTransaction(sig)` and reported a confirmation timeout.
 * 2. The launch only reached that code because /api/devnet-pre-fund answered 429 and the
 *    batch fell back to the sequential path, which asks the same route at its deposit
 *    step. It would have created the market, locked its rent, and then been refused.
 *
 * Source scans for the wiring (the code sits behind a wallet and a live connection, see
 * useCreateMarket-batch-fallback-wiring.test.ts), behaviour tests for the message.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PreFundRateLimitedError, preFundRateLimitedMessage, describeBatchFallback } from "@/hooks/useCreateMarket";

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

describe("a rate-limited pre-fund ends the launch before anything is sent", () => {
  it("the batch path raises the typed refusal on 429 and returns fatal, not fallback", () => {
    expect(batch).toContain("if (preFundResp.status === 429) throw new PreFundRateLimitedError(");
    const guard = batch.indexOf("if (!broadcastStarted && err instanceof PreFundRateLimitedError)");
    const fallback = batch.indexOf('return { status: "fallback", reason };');
    expect(guard).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(guard);
    expect(batch.slice(guard, fallback)).toContain('return { status: "fatal" };');
  });

  it("the sequential path asks for funding before it creates the market", () => {
    const fund = step0.indexOf('fetch("/api/devnet-pre-fund"');
    const refuse = step0.indexOf("throw new PreFundRateLimitedError(");
    const persist = step0.indexOf("// Persist recovery state BEFORE sending TX0.");
    expect(fund).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(fund);
    expect(persist).toBeGreaterThan(refuse);
  });

  it("the sequential catch shows the refusal message rather than a step failure", () => {
    const at = sequential.indexOf("if (e instanceof PreFundRateLimitedError)");
    expect(at).toBeGreaterThan(-1);
    expect(sequential.slice(at, at + 200)).toContain("preFundRateLimitedMessage(e.nextClaimAt)");
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
