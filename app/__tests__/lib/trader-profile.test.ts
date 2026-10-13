import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTraderWallet, shortWallet, traderPath } from "@/lib/trader-profile";

const W = "843GV9RaunrXm9tU82tpScMHLieDiP3BQizGkxyM7ko8";

describe("parseTraderWallet", () => {
  it("accepts a Solana address (also as the first of a repeated segment)", () => {
    expect(parseTraderWallet(W)).toBe(W);
    expect(parseTraderWallet([W, "x"])).toBe(W);
    expect(parseTraderWallet(` ${W} `)).toBe(W);
  });

  it("rejects anything else before it can reach an RPC filter or an API path", () => {
    for (const bad of [undefined, "", "0x1234", "../../api/admin", `${W}0`, "O".repeat(44), "%2e%2e%2f", "<script>"]) {
      expect(parseTraderWallet(bad)).toBeNull();
    }
  });
});

describe("shortWallet / traderPath", () => {
  it("matches the leaderboard's short form and builds the profile path", () => {
    expect(shortWallet(W)).toBe("843GV9…7ko8");
    expect(shortWallet("short")).toBe("short");
    expect(traderPath(W)).toBe(`/trader/${W}`);
  });
});

describe("leaderboard links each trader to their profile", () => {
  it("renders the trader cell as a Link to traderPath(entry.trader)", () => {
    const src = readFileSync(join(__dirname, "../../app/leaderboard/page.tsx"), "utf8");
    expect(src).toContain('import { traderPath } from "@/lib/trader-profile";');
    expect(src).toContain("href={traderPath(entry.trader)}");
  });
});
