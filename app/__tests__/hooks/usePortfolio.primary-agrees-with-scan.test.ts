/**
 * #2560 (review of #3138): TWO orderings decided "primary" (cross). usePortfolio used a code-unit
 * `pk < cur`; the shared selector (owner-portfolio.ts) used localeCompare. On mixed-case base58
 * they disagree ('aX..' before 'BX..' under localeCompare, after it by code unit), so the portfolio
 * page and the dock could pick different primaries and different legacy-entry fallbacks.
 * Both now use one code-unit comparator; this asserts the two surfaces agree on mixed-case keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  discoverMarketsViaProgramDirectory: vi.fn(),
  getNetwork: vi.fn(),
  isV17Account: vi.fn(),
  parseWrapperConfigV17: vi.fn(),
  parsePortfolioV17: vi.fn(),
  parsePositionNftAccount: vi.fn(),
  parseV17RiskParams: vi.fn(),
}));

vi.mock("@/lib/market-directory-discovery", () => ({ discoverMarketsViaProgramDirectory: mocks.discoverMarketsViaProgramDirectory }));
vi.mock("@/lib/config", () => ({ getAllProgramIds: vi.fn(() => []), getNetwork: mocks.getNetwork }));
vi.mock("@/lib/v17-engine-config", () => ({ parseV17RiskParams: mocks.parseV17RiskParams }));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    isV17Account: mocks.isV17Account,
    parseWrapperConfigV17: mocks.parseWrapperConfigV17,
    parsePortfolioV17: mocks.parsePortfolioV17,
    parsePositionNftAccount: mocks.parsePositionNftAccount,
  };
});

import { fetchPortfolioSnapshot } from "@/hooks/usePortfolio";
import { pickOwnerPortfolio } from "@/lib/owner-portfolio";
import { saveEntryPrice } from "@/lib/entry-price";

const keypairStartingWith = (pred: (c: string) => boolean): Keypair => {
  for (;;) {
    const kp = Keypair.generate();
    if (pred(kp.publicKey.toBase58()[0])) return kp;
  }
};

describe("portfolio page and shared selector agree on the primary (mixed-case base58)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNetwork.mockReturnValue("devnet");
    mocks.isV17Account.mockReturnValue(true);
    mocks.parseWrapperConfigV17.mockReturnValue({ markEwmaE6: 1_000_000n, tradeFeeBps: 30n });
    mocks.parseV17RiskParams.mockReturnValue({ maintenanceMarginBps: 600n, initialMarginBps: 1_000n });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ markets: [] }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("only the code-unit-lowest portfolio reads the legacy (cross) entry; the other row does not", async () => {
    const wallet = Keypair.generate().publicKey;
    const wrapperProgram = Keypair.generate().publicKey;
    const slab = Keypair.generate().publicKey;
    const collateralMint = Keypair.generate().publicKey;
    // 'H'..'Z' sorts BEFORE 'a'..'f' by code unit, AFTER it alphabetically (localeCompare).
    const upper = keypairStartingWith((c) => c >= "H" && c <= "Z").publicKey;
    const lower = keypairStartingWith((c) => c >= "a" && c <= "f").publicKey;
    expect(upper.toBase58() < lower.toBase58()).toBe(true);

    mocks.discoverMarketsViaProgramDirectory.mockResolvedValue([{ slabAddress: slab, config: { collateralMint }, configV17: { collateralMint } }]);
    // capital tells the rows apart: upper = 111, lower = 222
    mocks.parsePortfolioV17.mockImplementation((d: Uint8Array) => ({
      owner: wallet, marketGroupId: slab, capital: d[0] === 1 ? 111n : 222n, pnl: 0n, reservedPnl: 0n, feeCredits: 0n, lastFeeSlot: 0n,
      legs: [{ active: true, side: 0, basisPosQ: 5_000_000n, aBasis: 1_000_000_000_000_000n, epochSnap: 0n }],
    }));
    mocks.parsePositionNftAccount.mockReturnValue({ portfolioAccount: Keypair.generate().publicKey });
    const tag = (n: number) => Buffer.from([n, ...new Array(299).fill(0)]);
    const owned = [
      { pubkey: lower, account: { data: tag(2) } }, // RPC order: lowercase first
      { pubkey: upper, account: { data: tag(1) } },
    ];
    const getProgramAccounts = vi.fn(async (programId: PublicKey) => (programId.equals(wrapperProgram) ? owned : []));
    const getMultipleAccountsInfo = vi.fn().mockResolvedValueOnce([{ data: Buffer.alloc(256), owner: wrapperProgram }]);
    const connection = { getMultipleAccountsInfo, getProgramAccounts } as unknown as Parameters<typeof fetchPortfolioSnapshot>[0];

    // The shared selector's primary...
    expect(pickOwnerPortfolio(owned, wallet)?.pubkey.equals(upper)).toBe(true);

    // ...is the portfolio-page row that resolves the legacy (cross) entry.
    saveEntryPrice(slab.toBase58(), 0, 1_000_000n, 3, wallet.toBase58()); // legacy, portfolio-less key
    const snap = await fetchPortfolioSnapshot(connection, wallet, [Keypair.generate().publicKey.toBase58()]);
    const byCapital = (c: bigint) => snap.positions.find((p) => p.account.capital === c)!;
    expect(byCapital(111n).entryPriceSource).not.toBe("unknown"); // primary: legacy fallback resolved
    expect(byCapital(222n).entryPriceSource).toBe("unknown"); // isolated: never reads the cross entry
  });
});
