/**
 * lib/userAccountScan.ts — the shared v17 scan store behind useUserAccount /
 * usePositionNft / useNftWrappedPosition (see that file's header for the
 * full "why"). These tests exercise the module directly (mirrors
 * __tests__/lib/priceStore-poll.test.ts's approach) rather than through a
 * hook, so they can assert the three properties the frontend-bugfix sweep
 * cared about without needing a full React render tree:
 *
 *   1. Dedup — concurrent triggers for the identical `raw` reference issue
 *      exactly ONE getProgramAccounts call, whether they come from the same
 *      hook mounted twice or two different hooks needing the same query.
 *   2. Equality bail-out — an unchanged result keeps the SAME object
 *      reference across scans (required for useSyncExternalStore to skip
 *      re-renders).
 *   3. Keep-last-good — a transient scan error never blanks the cache; only
 *      a successful scan that finds nothing publishes null/empty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({
  parsePortfolioV17: vi.fn(),
}));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    parsePortfolioV17: mocks.parsePortfolioV17,
  };
});

import {
  makePortfolioScanKey,
  triggerPortfolioScan,
  getPortfolioUserAccountSnapshot,
  getPortfolioRawSnapshot,
  subscribePortfolioScan,
  makeHeldNftScanKey,
  triggerHeldNftScan,
  getHeldNftSnapshot,
  subscribeHeldNftScan,
} from "@/lib/userAccountScan";

// The scan store is module-level (Map keyed by program/slab/wallet), so its
// cache persists across tests in this file. Every test below regenerates a
// FRESH, unique identity (via `nextByte()`) instead of sharing one constant
// set — otherwise an earlier test's cached (and, by design, equality-bailed-
// out) result would silently satisfy/interfere with a later test's
// assertions purely because they happened to hash to the same store key.
let byteCounter = 0;
function nextByte(): number {
  byteCounter += 1;
  return byteCounter % 256;
}
function uniquePubkey(): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(nextByte()));
}

let programId: PublicKey;
let wallet: PublicKey;
let slabAddress: string;
let portfolioPubkey: PublicKey;
let nftProgramId: PublicKey;

beforeEach(() => {
  programId = uniquePubkey();
  wallet = uniquePubkey();
  slabAddress = uniquePubkey().toBase58();
  portfolioPubkey = uniquePubkey();
  nftProgramId = uniquePubkey();
});

/** Minimal parsed-portfolio double — only the fields `userAccountScan.ts`
 *  actually reads (economics + owner + one active leg) need to be real. */
function makePortfolio(overrides: Record<string, unknown> = {}) {
  return {
    marketGroupId: new PublicKey(slabAddress),
    portfolioAccountId: portfolioPubkey,
    provenanceOwner: wallet,
    owner: wallet,
    capital: 1_000n,
    pnl: 0n,
    reservedPnl: 0n,
    residualCrystallizedLossAtomsTotal: 0n,
    residualSpentPrincipalAtomsTotal: 0n,
    residualReceivedAtomsTotal: 0n,
    feeCredits: 0n,
    cancelDepositEscrow: 0n,
    lastFeeSlot: 0n,
    activeBitmap: 1n,
    legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 5n }],
    sourceDomains: [],
    ...overrides,
  };
}

/** A fake Connection exposing typed mock handles for `getProgramAccounts` /
 *  `getMultipleAccountsInfo`, cast once to the real `Connection` type so
 *  every call site below stays `any`-free. */
function makeConnection() {
  const getProgramAccounts = vi.fn();
  const getMultipleAccountsInfo = vi.fn();
  const connection = { getProgramAccounts, getMultipleAccountsInfo } as unknown as Connection;
  return { connection, getProgramAccounts, getMultipleAccountsInfo };
}

describe("userAccountScan — portfolio scan store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dedupes concurrent triggers for the identical `raw` reference (single RPC call)", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const raw = new Uint8Array([1, 2, 3]);
    // Simulate useUserAccount AND usePositionNft both firing in the same
    // React commit with the same `raw` reference.
    const [a, b] = await Promise.all([
      triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw }),
      triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw }),
    ]);

    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // same published reference
    expect(a?.pubkey.equals(portfolioPubkey)).toBe(true);
  });

  it("re-scans when `raw` changes to a new reference", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });

    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it("keeps the SAME object reference when the published result hasn't changed (equality bail-out)", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    const first = getPortfolioUserAccountSnapshot(key);
    expect(listener).toHaveBeenCalledTimes(1);

    // A second scan (new `raw`) returns economically-identical data.
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });
    const second = getPortfolioUserAccountSnapshot(key);

    expect(second).toBe(first); // no new object — consumers skip re-render
    expect(listener).toHaveBeenCalledTimes(1); // no extra notify
  });

  it("publishes a NEW reference when the position size actually changes", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    const first = getPortfolioUserAccountSnapshot(key);

    mocks.parsePortfolioV17.mockReturnValue(
      makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 999n }] }),
    );
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });
    const second = getPortfolioUserAccountSnapshot(key);

    expect(second).not.toBe(first);
    expect(second?.account.positionSize).toBe(999n);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps last-good data on a transient RPC error instead of publishing null", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValueOnce([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    const goodResult = getPortfolioUserAccountSnapshot(key);
    expect(goodResult).not.toBeNull();

    getProgramAccounts.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const resolved = await triggerPortfolioScan({
      connection,
      programId,
      slabAddress,
      publicKey: wallet,
      raw: new Uint8Array([2]),
    });

    // The failed scan resolves with the last-good raw result (not a throw, not null).
    expect(resolved).not.toBeNull();
    expect(getPortfolioUserAccountSnapshot(key)).toBe(goodResult); // untouched
  });

  it("publishes null only when a scan SUCCEEDS and finds zero matching accounts", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([]);

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });

    expect(getPortfolioUserAccountSnapshot(key)).toBeNull();
    expect(getPortfolioRawSnapshot(key)).toBeNull();
  });

  it("M10: sorts multiple matches deterministically by pubkey regardless of RPC order", async () => {
    const pkLow = new PublicKey(new Uint8Array(32).fill(1));
    const pkHigh = new PublicKey(new Uint8Array(32).fill(200));
    const canonical = [pkLow, pkHigh].sort((a, b) => a.toBase58().localeCompare(b.toBase58()))[0];

    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([
      { pubkey: pkHigh, account: { data: Buffer.alloc(1) } },
      { pubkey: pkLow, account: { data: Buffer.alloc(1) } },
    ]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const result = await triggerPortfolioScan({
      connection,
      programId,
      slabAddress,
      publicKey: wallet,
      raw: new Uint8Array([1]),
    });

    expect(result?.pubkey.equals(canonical)).toBe(true);
  });

  it("does not publish when the re-verified owner doesn't match (memcmp is advisory only)", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    const someoneElse = new PublicKey(new Uint8Array(32).fill(9));
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ owner: someoneElse }));

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });

    expect(getPortfolioUserAccountSnapshot(key)).toBeNull();
  });
});

describe("userAccountScan — held-NFT scan store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function nftAccount(pubkey: PublicKey, data = new Uint8Array(199)) {
    return { pubkey, account: { data } };
  }

  it("dedupes concurrent triggers for the identical `raw` reference", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    const nftPk = new PublicKey(new Uint8Array(32).fill(7));
    getProgramAccounts.mockResolvedValue([nftAccount(nftPk)]);

    const raw = new Uint8Array([1]);
    const [a, b] = await Promise.all([
      triggerHeldNftScan({ connection, nftProgramId, wallet, raw }),
      triggerHeldNftScan({ connection, nftProgramId, wallet, raw }),
    ]);

    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toHaveLength(1);
  });

  it("keeps the same array reference when nothing changed", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    const nftPk = new PublicKey(new Uint8Array(32).fill(7));
    getProgramAccounts.mockResolvedValue([nftAccount(nftPk)]);

    const key = makeHeldNftScanKey(nftProgramId, wallet);
    const listener = vi.fn();
    subscribeHeldNftScan(key, listener);

    await triggerHeldNftScan({ connection, nftProgramId, wallet, raw: new Uint8Array([1]) });
    const first = getHeldNftSnapshot(key);

    getProgramAccounts.mockResolvedValue([nftAccount(nftPk)]);
    await triggerHeldNftScan({ connection, nftProgramId, wallet, raw: new Uint8Array([2]) });
    const second = getHeldNftSnapshot(key);

    expect(second).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps last-good NFT list on a transient error instead of an empty array", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    const nftPk = new PublicKey(new Uint8Array(32).fill(7));
    getProgramAccounts.mockResolvedValueOnce([nftAccount(nftPk)]);

    const key = makeHeldNftScanKey(nftProgramId, wallet);
    await triggerHeldNftScan({ connection, nftProgramId, wallet, raw: new Uint8Array([1]) });
    expect(getHeldNftSnapshot(key)).toHaveLength(1);

    getProgramAccounts.mockRejectedValueOnce(new Error("timeout"));
    const resolved = await triggerHeldNftScan({ connection, nftProgramId, wallet, raw: new Uint8Array([2]) });

    expect(resolved).toHaveLength(1); // last-good, not []
    expect(getHeldNftSnapshot(key)).toHaveLength(1);
  });
});
