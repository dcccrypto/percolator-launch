/**
 * #2560 (review of #3138, blocking): a wallet with a CROSS portfolio opens an ISOLATED one whose
 * freshly generated keypair sorts LOWER than the cross account. Before the fix the isolated
 * portfolio then became the wallet's "primary" (lowest pubkey), so useUserAccount, deposits and
 * plain Cross trades moved into it. This drives the real useFirstTrade -> real owner scan ->
 * real shared scan store -> real useTrade resolver and asserts everything stays on the ORIGINAL
 * cross account, and that the isolated account is still reachable by an explicit target.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Keypair, PublicKey, TransactionInstruction, type Signer } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";

const PROGRAM = new PublicKey(new Uint8Array(32).fill(12));
const MARKET = new PublicKey(new Uint8Array(32).fill(33));
const owner = Keypair.generate().publicKey;
const sendTx = vi.fn();

const mocks = vi.hoisted(() => ({ accounts: [] as { pubkey: PublicKey; account: { data: Buffer } }[], armed: false }));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: owner, signTransaction: vi.fn() }),
  useConnectionCompat: () => ({ connection }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: { collateralMint: new PublicKey(new Uint8Array(32).fill(5)) },
    programId: PROGRAM,
    wrapperConfigV17: { tradeFeeBps: 5n },
    refresh: vi.fn(),
  }),
}));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  // The first thing fundAndTrade does: arm the keypair queue (nothing else generates a keypair
  // between here and the portfolio keypair, so the next draws are the hook's own).
  getAta: vi.fn(async () => {
    mocks.armed = true;
    return new PublicKey(new Uint8Array(32).fill(6));
  }),
  deriveVaultAuthority: vi.fn(() => [new PublicKey(new Uint8Array(32).fill(7)), 255]),
  // owner @116, market_group_id @16: the same layout the owner scan filters on.
  parsePortfolioV17: (d: Uint8Array) => ({
    owner: new PublicKey(d.slice(116, 148)),
    marketGroupId: new PublicKey(d.slice(16, 48)),
    provenanceOwner: new PublicKey(d.slice(116, 148)),
    capital: 1_000n,
    pnl: 0n,
    reservedPnl: 0n,
    feeCredits: 0n,
    lastFeeSlot: 0n,
    legs: [],
    sourceDomains: [],
  }),
}));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: vi.fn(), isKnownProgram: () => true, assertCanonicalMatcher: vi.fn() }));
vi.mock("@/lib/deposit-guard", () => ({ assertDepositWithinBalance: vi.fn() }));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchAssetMarketId: vi.fn(async () => 1n),
  fetchPortfolioIdentity: vi.fn(async () => ({ portfolioId: 7n, matcherSequence: 3n, positionEpoch: 1n })),
}));
vi.mock("@/lib/market-lp", () => ({
  resolveMarketLp: vi.fn(async () => ({
    pubkey: new PublicKey(new Uint8Array(32).fill(13)),
    data: new Uint8Array(0),
    owner: new PublicKey(new Uint8Array(32).fill(14)),
    portfolioId: 1n,
    matcherProg: new PublicKey(new Uint8Array(32).fill(15)),
    matcherCtx: new PublicKey(new Uint8Array(32).fill(16)),
    matcherDelegate: new PublicKey(new Uint8Array(32).fill(17)),
    reason: "asset-admin",
  })),
}));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/first-trade", async (orig) => {
  const real = await orig<typeof import("@/lib/first-trade")>();
  const ix = (tag: number, k: PublicKey) => new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: k, isSigner: false, isWritable: true }], data: Buffer.from([tag]) });
  return {
    ...real,
    readNextPortfolioId: () => 2n,
    buildFirstTradeInitIxs: (p: { portfolio: PublicKey }) => [ix(1, p.portfolio), ix(2, p.portfolio)],
    buildFundAndTradeIxs: (p: { portfolio: PublicKey }) => [ix(3, p.portfolio), ix(4, p.portfolio)],
  };
});
vi.mock("@/lib/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/tx")>()), sendTx: (...a: unknown[]) => sendTx(...a), prewarmTxLanding: vi.fn() }));

const connection = {
  getAccountInfo: vi.fn(async (pk: PublicKey) => {
    const hit = mocks.accounts.find((a) => a.pubkey.equals(pk));
    if (hit) return { owner: PROGRAM, data: hit.account.data };
    return { owner: PROGRAM, data: Buffer.alloc(8192) }; // ATA / market placeholder
  }),
  getMinimumBalanceForRentExemption: vi.fn(async () => 1_000_000),
  getProgramAccounts: vi.fn(async () => mocks.accounts),
};

import { useFirstTrade } from "@/hooks/useFirstTrade";
import { resolveV17TradeAccounts } from "@/hooks/useTrade";
import { findOwnerPortfolio, listOwnerPortfolios } from "@/lib/owner-portfolio";
import {
  getPortfolioListSnapshot,
  getPortfolioRawSnapshot,
  getPortfolioUserAccountSnapshot,
  makePortfolioScanKey,
  triggerPortfolioScan,
} from "@/lib/userAccountScan";

function acct(pubkey: PublicKey) {
  const d = Buffer.alloc(V17_PORTFOLIO_ACCOUNT_LEN);
  MARKET.toBuffer().copy(d, 16);
  owner.toBuffer().copy(d, 116);
  return { pubkey, account: { data: d } };
}
const lt = (a: PublicKey, b: PublicKey) => a.toBase58() < b.toBase58();

describe("an isolated open whose random keypair sorts LOWER must not displace the cross account", () => {
  let realGenerate: typeof Keypair.generate;
  let cross: PublicKey;
  let lowKp: Keypair;
  let highKp: Keypair;
  let queue: Keypair[];

  beforeEach(() => {
    sendTx.mockReset();
    sendTx.mockResolvedValue("sigIso");
    realGenerate = Keypair.generate.bind(Keypair);
    // cross in the lower part of the alphabet so a higher key is found fast
    do { cross = realGenerate().publicKey; } while (cross.toBase58()[0] > "k");
    do { lowKp = realGenerate(); } while (!lt(lowKp.publicKey, cross));
    do { highKp = realGenerate(); } while (!lt(cross, highKp.publicKey));
    mocks.accounts = [acct(cross)];
    queue = [lowKp, highKp];
    // Only the hook's keypair generation is steered: the queue arms when fundAndTrade starts.
    vi.spyOn(Keypair, "generate").mockImplementation(() => (mocks.armed && queue.length ? queue.shift()! : realGenerate()));
    mocks.armed = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.armed = false;
  });

  async function openIsolated() {
    const { result } = renderHook(() => useFirstTrade(MARKET.toBase58()));
    let out!: Awaited<ReturnType<typeof result.current.fundAndTrade>>;
    await act(async () => {
      out = await result.current.fundAndTrade({ size: 1_000n, depositAtoms: 5_000_000n, limitPriceE6: 3_700n, amountLabel: "5 USDC", forceNewPortfolio: true });
    });
    return out;
  }

  it("the isolated portfolio is created at a keypair that sorts AFTER the cross account (the low draw is skipped)", async () => {
    const out = await openIsolated();
    const signer = (sendTx.mock.calls[0][0] as { signers: Signer[] }).signers[0];
    expect(signer.publicKey.equals(highKp.publicKey)).toBe(true);
    expect(signer.publicKey.equals(lowKp.publicKey)).toBe(false);
    expect(out.portfolio.equals(highKp.publicKey)).toBe(true);
    expect(out.created).toBe(true);
  });

  it("afterwards deposits, cross trades and the shared store all still resolve the ORIGINAL cross account", async () => {
    const out = await openIsolated();
    // The chain now holds both; RPC returns the isolated account FIRST.
    mocks.accounts = [acct(out.portfolio), acct(cross)];

    // deposit / first-trade / init all resolve through findOwnerPortfolio
    expect((await findOwnerPortfolio(connection as never, PROGRAM, MARKET, owner))?.equals(cross)).toBe(true);
    // a plain cross trade (no explicit target)
    const plain = await resolveV17TradeAccounts(connection as never, PROGRAM, MARKET, owner);
    expect(plain.accountA.equals(cross)).toBe(true);
    // an explicit isolated target still reaches the isolated account
    const explicit = await resolveV17TradeAccounts(connection as never, PROGRAM, MARKET, owner, out.portfolio);
    expect(explicit.accountA.equals(out.portfolio)).toBe(true);

    // the shared scan store (useUserAccount, DepositWithdrawCard, the dock's Cross/Isolated badges)
    const key = makePortfolioScanKey(PROGRAM, MARKET.toBase58(), owner);
    await triggerPortfolioScan({ connection: connection as never, programId: PROGRAM, slabAddress: MARKET.toBase58(), publicKey: owner, raw: new Uint8Array([1]) });
    expect(getPortfolioRawSnapshot(key)?.pubkey.equals(cross)).toBe(true);
    expect(getPortfolioUserAccountSnapshot(key)?.pubkey?.equals(cross)).toBe(true);
    const list = getPortfolioListSnapshot(key);
    expect(list.map((p) => p.pubkey?.toBase58())).toEqual([cross.toBase58(), out.portfolio.toBase58()]);
    expect(listOwnerPortfolios(mocks.accounts, owner)[0].pubkey.equals(cross)).toBe(true);
  });

  it("an isolated open with NO main account is refused before anything is signed (it would become the cross account)", async () => {
    mocks.accounts = [];
    const { result } = renderHook(() => useFirstTrade(MARKET.toBase58()));
    await act(async () => {
      await expect(
        result.current.fundAndTrade({ size: 1_000n, depositAtoms: 5_000_000n, limitPriceE6: 3_700n, amountLabel: "5 USDC", forceNewPortfolio: true }),
      ).rejects.toThrow(/next to your main account/);
    });
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("CONTROL: a plain (cross) first trade keeps the unconstrained random keypair", async () => {
    mocks.accounts = [];
    const { result } = renderHook(() => useFirstTrade(MARKET.toBase58()));
    queue = [lowKp];
    await act(async () => {
      await result.current.fundAndTrade({ size: 1_000n, depositAtoms: 5_000_000n, limitPriceE6: 3_700n, amountLabel: "5 USDC" });
    });
    const signer = (sendTx.mock.calls[0][0] as { signers: Signer[] }).signers[0];
    expect(signer.publicKey.equals(lowKp.publicKey)).toBe(true);
  });
});
