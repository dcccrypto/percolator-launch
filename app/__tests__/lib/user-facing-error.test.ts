/**
 * The app's own explanations for a refused close / withdraw / deposit ("close up to 40% now",
 * "you have an open position") are thrown as plain Errors, and humanizeError deliberately maps
 * free text to the unmapped line (18f85ba9: runtime / RPC / wallet text must not reach users).
 * UserFacingError is the explicit opt-in: those messages reach the user, nothing else does.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { humanizeError, UNMAPPED_MESSAGE, UserFacingError, userFacingMessage } from "@/lib/errorMessages";

const OPEN_POSITION =
  "You have an open position on this market. Close it (fully) before withdrawing — this market can't release collateral while a position is open.";
const CAPACITY =
  "The market can only absorb 40% of this close right now — its liquidity provider is at its exposure cap on your side. Close up to 40% now, or wait for other trades to free capacity.";

describe("UserFacingError", () => {
  it("humanizeError alone swallows the app's own copy (the reason the class exists)", () => {
    expect(humanizeError(OPEN_POSITION)).toBe(UNMAPPED_MESSAGE);
    expect(humanizeError(CAPACITY, "trade")).toBe(UNMAPPED_MESSAGE);
  });

  it("passes a UserFacingError's message through", () => {
    expect(userFacingMessage(new UserFacingError(OPEN_POSITION))).toBe(OPEN_POSITION);
    expect(userFacingMessage(new UserFacingError(CAPACITY))).toBe(CAPACITY);
    expect(new UserFacingError("x")).toBeInstanceOf(Error);
  });

  it("never passes runtime / RPC / wallet text: those stay unmapped", () => {
    for (const raw of ["TypeError: fetch failed", "Cannot read properties of undefined (reading 'x')", "User rejected the request."]) {
      expect(userFacingMessage(new Error(raw))).toBeNull();
      expect(userFacingMessage(raw)).toBeNull();
    }
    expect(humanizeError("TypeError: fetch failed")).toBe(UNMAPPED_MESSAGE);
  });

  it("close, withdraw and deposit show a UserFacingError before humanizing", () => {
    const src = (f: string) => fs.readFileSync(path.resolve(__dirname, "../../hooks", f), "utf8");
    expect(src("useClosePosition.ts")).toMatch(/setError\(userFacingMessage\(e\) \?\? safeExplainMarketTxError/);
    expect(src("useWithdraw.ts")).toMatch(/setError\(userFacingMessage\(e\) \?\?/);
    expect(src("useDeposit.ts")).toMatch(/setError\(userFacingMessage\(e\) \?\? humanizeError/);
    expect(src("useWithdraw.ts")).toMatch(/throw new UserFacingError\(OPEN_POSITION_WITHDRAW_MESSAGE\)/);
    expect(src("useClosePosition.ts")).toMatch(/throw new UserFacingError\(closeCapacityMessage\(/);
  });
});
