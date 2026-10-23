/**
 * AccountsCard PnL units. With no entry price (structurally 0n on v17/v18,
 * and flat/idle rows on any engine) the row falls back to the on-chain
 * `account.pnl`, which is COLLATERAL ATOMS (engine `account_haircut_equity`:
 * capital + pnl; SDK "P&L in atoms"). It used to be passed through
 * computeMarkPnlCollateral as if it were coin-native — multiplying it by the
 * mark. The pnl value here is the REAL on-chain pnl of devnet v18 portfolio
 * 2SewEcvf (fixture shared with entry-price-surfaces.test.tsx).
 */
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { AccountKind, parsePortfolioV17 } from "@percolatorct/sdk";

const MARK_E6 = 118_686_275n; // live SOL mark at capture ($118.69)

let account: Record<string, unknown> = {};
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [{ idx: 1, account }],
    config: { collateralMint: null, lastEffectivePriceE6: MARK_E6, invert: false },
    loading: false,
  }),
}));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ params: { maintenanceMarginBps: 500n } }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: MARK_E6 }) }));

import { AccountsCard } from "@/components/trade/AccountsCard";
import { formatPnl } from "@/lib/format";
import { computeMarkPnlCollateral, computeMarkPnlLinear } from "@/lib/trading";

const f = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../fixtures/2SewEcvf.portfolio.json"), "utf8"),
) as { dataBase64: string };
const portfolio = parsePortfolioV17(Buffer.from(f.dataBase64, "base64"));

afterEach(cleanup);

describe("AccountsCard — on-chain pnl fallback is collateral, not coin-native", () => {
  it("renders the real on-chain pnl as-is when no entry is known", () => {
    expect(portfolio.pnl).not.toBe(0n); // CONTROL: the fixture really carries a pnl
    account = {
      kind: AccountKind.User,
      owner: new PublicKey("11111111111111111111111111111111"),
      positionSize: -1_000_000n,
      entryPrice: 0n, // v17/v18: no entry on-chain
      capital: portfolio.capital,
      pnl: portfolio.pnl,
    };
    const { container } = render(<AccountsCard />);
    const text = container.textContent ?? "";
    expect(text).toContain(formatPnl(portfolio.pnl, 6));
    // The double-converted figure (×$118.69) must not appear.
    expect(text).not.toContain(formatPnl(computeMarkPnlCollateral(portfolio.pnl, MARK_E6), 6));
  });

  it("CONTROL: an entry-known row values the position at the mark (one division, as the engine does)", () => {
    account = {
      kind: AccountKind.User,
      owner: new PublicKey("11111111111111111111111111111111"),
      positionSize: 1_000_000n, // 1 token long
      entryPrice: 100_000_000n, // $100 entry
      capital: 1_000_000_000n,
      pnl: 0n,
    };
    const { container } = render(<AccountsCard />);
    const expected = computeMarkPnlLinear(1_000_000n, 100_000_000n, MARK_E6);
    expect(expected).toBe(18_686_275n); // 1 token, $100 -> $118.686275: +$18.686275
    expect(expected).toBeGreaterThan(0n);
    expect(container.textContent).toContain(formatPnl(expected, 6));
  });
});
