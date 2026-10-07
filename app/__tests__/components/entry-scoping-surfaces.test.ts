/**
 * WIRING-ONLY (source-binding, NOT behaviour, not a negative control). The surfaces with a cheap render
 * harness have behaviour tests instead: PositionsDock (rows, PositionsDock.multi-portfolio.test.tsx),
 * ChartPnlBadge, useLiqPrice, usePortfolio, computePositionRowView. What remains here are the surfaces
 * that need their whole provider stack to render (PositionPanel, TradingChart, DepositWithdrawCard,
 * OrderTicket's Close tab); they thread the same pubkey into the same, behaviour-tested lookups.
 *
 * #2560 regression fix: EVERY entry-reading surface must scope its cached-entry
 * read by the displayed portfolio's pubkey, not the per-wallet legacy key —
 * otherwise, when useUserAccount's "primary" (lowest random pubkey) is an
 * isolated portfolio, the surface shows that position's size with the CROSS
 * entry (wrong PnL/liq). Source-binding (these surfaces each need the full
 * provider stack to render); assert the pubkey is threaded into each read.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");

describe("#2560 entry read is portfolio-scoped on every surface", () => {
  it("PositionPanel passes the portfolio pubkey (pnl + leverage)", () => {
    const s = read("../../components/trade/PositionPanel.tsx");
    expect(s).toMatch(/portfolio: userAccount\.pubkey\?\.toBase58\(\)/);
    expect(s).toMatch(/getEntryLeverage\(slabAddress, userAccount\.idx, account\.owner\.toBase58\(\), userAccount\.pubkey\?\.toBase58\(\)\)/);
  });
  it("TradingChart's entry line passes the portfolio pubkey", () => {
    expect(read("../../components/trade/TradingChart.tsx")).toMatch(/portfolio: ua\.pubkey\?\.toBase58\(\)/);
  });
  it("DepositWithdrawCard passes the portfolio pubkey", () => {
    expect(read("../../components/trade/DepositWithdrawCard.tsx")).toMatch(/getEntryPrice\(slabAddress, userAccount\.idx, publicKey\.toBase58\(\), userAccount\.pubkey\?\.toBase58\(\)\)/);
  });
  it("OrderTicket (Close-tab preview + locked margin) passes the portfolio pubkey", () => {
    const s = read("../../components/trade/OrderTicket.tsx");
    expect(s).toMatch(/getEntryPrice\(slabAddress, userAccount\.idx, publicKey\?\.toBase58\(\), userAccount\.pubkey\?\.toBase58\(\)\)/);
    expect(s).toMatch(/portfolio: userAccount\.pubkey\?\.toBase58\(\)/);
  });
});
