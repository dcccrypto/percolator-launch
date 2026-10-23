/**
 * #47: "Wallet not connected or market not loaded" was one error for two conditions, and the
 * message resolver matches "wallet not connected" first, so a connected trader clicking before the
 * market loaded was told "Wallet locked: Unlock your wallet". The hooks now throw two errors.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError, MARKET_LOADING_MESSAGE, WALLET_LOCKED_MESSAGE } from "@/lib/errorMessages";

const HOOKS = ["useTrade", "useDeposit", "useWithdraw", "useInitUser", "useFirstTrade"];

describe("market not loaded vs wallet not connected", () => {
  it.each(HOOKS)("%s throws the two conditions apart", (hook) => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../hooks", `${hook}.ts`), "utf8");
    expect(src).not.toMatch(/Wallet not connected or market not loaded/);
    expect(src).toMatch(/throw new Error\("Wallet not connected"\)/);
    expect(src).toMatch(/throw new Error\("Market not loaded"\)/);
  });

  it("each one resolves to its own message on the ticket (resolveUserMessage)", () => {
    expect(resolveUserMessage(new Error("Market not loaded"), { surface: "trade" }).kind).toBe("market-loading");
    expect(resolveUserMessage(new Error("Wallet not connected"), { surface: "trade" }).kind).toBe("wallet-locked");
  });

  it("and on deposit / withdraw / account setup (humanizeError)", () => {
    expect(humanizeError("Market not loaded")).toBe(MARKET_LOADING_MESSAGE);
    expect(humanizeError("Wallet not connected")).toBe(WALLET_LOCKED_MESSAGE);
  });
});
