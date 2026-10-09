import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { endLaunchOnRejection, LAUNCH_CANCELLED_MESSAGE, type CreateMarketState } from "@/hooks/useCreateMarket";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import { EmbeddedBatchSignError, EMBEDDED_BATCH_SIGN_MESSAGE, EMBEDDED_BATCH_SIGN_MESSAGE_PARTIAL } from "@/lib/privy-batch-sign";
import { userFacingMessage } from "@/lib/errorMessages";

const src = readFileSync(resolve(process.cwd(), "hooks/useCreateMarket.ts"), "utf8");

describe("B3: a cancel before anything is sent ends the launch (no sequential re-prompts)", () => {
  it("a {code: 4001} rejection sets the idle/error state and reports it handled", () => {
    let state = { loading: true, error: null, step: 0, phase: "awaiting-signature" } as unknown as CreateMarketState;
    const setState = vi.fn((fn: (s: CreateMarketState) => CreateMarketState) => { state = fn(state); });
    expect(endLaunchOnRejection({ code: 4001 }, false, setState)).toBe(true);
    expect(state.error).toBe(LAUNCH_CANCELLED_MESSAGE);
    expect(LAUNCH_CANCELLED_MESSAGE).toBe("Transaction cancelled. Nothing was sent. Press Retry to try again.");
    expect(state).toMatchObject({ loading: false, step: 0, phase: "idle" });
  });
  it("is not taken once something was broadcast, or for a non-rejection", () => {
    const setState = vi.fn();
    expect(endLaunchOnRejection({ code: 4001 }, true, setState)).toBe(false);
    expect(endLaunchOnRejection(new Error("rpc exploded"), false, setState)).toBe(false);
    expect(endLaunchOnRejection(new Error("Transaction rejected by policy"), false, setState)).toBe(false);
    expect(setState).not.toHaveBeenCalled();
  });
  it("the catch returns fatal for it BEFORE the sequential-fallback return", () => {
    const catchStart = src.indexOf("if (!broadcastStarted && err instanceof PreFundRateLimitedError)");
    const end = src.indexOf('return { status: "fallback", reason };', catchStart);
    const cancel = src.indexOf("if (endLaunchOnRejection(err, broadcastStarted, setState)) return { status: \"fatal\" };", catchStart);
    expect(catchStart).toBeGreaterThan(0);
    expect(cancel).toBeGreaterThan(catchStart);
    expect(cancel).toBeLessThan(end);
  });
});

describe("B1: an embedded signing failure reads true in every flow", () => {
  it("fresh launch / single sign: nothing was sent", () => {
    const e = new EmbeddedBatchSignError(5);
    expect(e.message).toBe(EMBEDDED_BATCH_SIGN_MESSAGE);
    expect(userFacingMessage(e)).toBe(EMBEDDED_BATCH_SIGN_MESSAGE);
  });
  it("tail recovery (earlier steps landed): says part of the market exists and to press Retry", () => {
    const e = new EmbeddedBatchSignError(3, { sentBefore: true });
    expect(e.message).toBe("Signing didn't finish. Part of your market was already created. Press Retry to continue.");
    expect(e.message).toBe(EMBEDDED_BATCH_SIGN_MESSAGE_PARTIAL);
  });
  it("parseMarketCreationError passes it through unchanged, with no step prefix", () => {
    for (const e of [new EmbeddedBatchSignError(5), new EmbeddedBatchSignError(3, { sentBefore: true })]) {
      expect(parseMarketCreationError(e, { step: "create-market" as never, stepLabel: "Finishing up" })).toBe(e.message);
    }
  });
  it("recoverTailFrom re-marks the error as sentBefore", () => {
    expect(src).toContain("throw new EmbeddedBatchSignError(e.total, { cause: e.cause, sentBefore: true })");
  });
});
