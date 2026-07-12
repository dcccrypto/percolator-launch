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
  applyConfirmedFill,
  makeHeldNftScanKey,
  triggerHeldNftScan,
  getHeldNftSnapshot,
  subscribeHeldNftScan,
  isLpPortfolio,
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

describe("userAccountScan — applyConfirmedFill (instant reflection of a confirmed trade)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the signed size delta immediately, publishing once with no RPC call", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 5n }] }));

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });

    const listener = vi.fn();
    subscribePortfolioScan(key, listener);
    getProgramAccounts.mockClear();

    const applied = applyConfirmedFill(key, 10n);

    expect(applied).toBe(true);
    expect(getProgramAccounts).not.toHaveBeenCalled(); // instant local patch, no re-scan
    expect(listener).toHaveBeenCalledTimes(1); // publishes exactly once
    const snapshot = getPortfolioUserAccountSnapshot(key);
    expect(snapshot?.account.positionSize).toBe(15n); // 5n (existing) + 10n (confirmed delta)
    // Capital is left untouched by design — the real scan reconciles it.
    expect(snapshot?.account.capital).toBe(1_000n);
    expect(snapshot?.provisional).toBe(true);
  });

  it("supports a negative delta (a close), including reducing a leg to flat", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 20n }] }));

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });

    // useClosePosition passes trade() a size that's already the signed
    // closing delta (negative to reduce/flatten a long) — applying it here
    // must subtract, not add magnitude.
    const applied = applyConfirmedFill(key, -20n);

    expect(applied).toBe(true);
    expect(getPortfolioUserAccountSnapshot(key)?.account.positionSize).toBe(0n);
  });

  it("a subsequent real scan ALWAYS replaces the provisional patch, even when it computes an equal value (equality bail-out doesn't stick)", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 5n }] }));

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    expect(listener).toHaveBeenCalledTimes(1);

    applyConfirmedFill(key, 10n); // -> basisPosQ 15n, provisional
    expect(listener).toHaveBeenCalledTimes(2);
    const patchedSnapshot = getPortfolioUserAccountSnapshot(key);
    expect(patchedSnapshot?.account.positionSize).toBe(15n);

    // The "real" scan lands and independently computes the SAME basisPosQ
    // (15n) the provisional patch guessed — a value-equality bail-out would
    // normally keep the OLD object reference and skip the notify entirely.
    // Because the entry is still provisional, this publish must go through
    // anyway: scans are the source of truth and must always be able to
    // supersede a locally-guessed patch.
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 15n }] }));
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });

    const rescannedSnapshot = getPortfolioUserAccountSnapshot(key);
    expect(rescannedSnapshot).not.toBe(patchedSnapshot); // new reference, not the stale patch
    expect(rescannedSnapshot?.account.positionSize).toBe(15n);
    expect(rescannedSnapshot?.provisional).toBeUndefined(); // real scan clears the provisional flag
    expect(listener).toHaveBeenCalledTimes(3); // the bail-out did NOT suppress this publish
  });

  it("a later scan (post-provisional-window) that finds a genuinely unchanged result still bails out as normal", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 5n }] }));

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);

    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    // No applyConfirmedFill call here — the entry was never made provisional,
    // so ordinary equality bail-out behaviour (asserted elsewhere in this
    // file) is untouched by this feature.
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio({ legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 5n }] }));
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });

    expect(listener).toHaveBeenCalledTimes(1); // second (unchanged) scan bailed out, as before
  });

  it("is a no-op for a key with no cached scan result yet", () => {
    const bogusKey = makePortfolioScanKey(uniquePubkey(), uniquePubkey().toBase58(), uniquePubkey());
    expect(() => applyConfirmedFill(bogusKey, 10n)).not.toThrow();
    expect(applyConfirmedFill(bogusKey, 10n)).toBe(false);
    expect(getPortfolioUserAccountSnapshot(bogusKey)).toBeNull();
  });

  it("is a no-op when the cached snapshot has no active leg to apply the delta to", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([{ pubkey: portfolioPubkey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue(
      makePortfolio({ legs: [{ active: false, assetIndex: 0, marketId: 1n, side: 0, basisPosQ: 0n }] }),
    );

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    const before = getPortfolioUserAccountSnapshot(key);

    const applied = applyConfirmedFill(key, 10n);

    expect(applied).toBe(false);
    expect(getPortfolioUserAccountSnapshot(key)).toBe(before); // untouched
  });
});

describe("userAccountScan — isLpPortfolio (GH bug: market creator's LP mistaken for own trading account)", () => {
  /** Builds a portfolio-account-shaped buffer whose trailing 104-byte
   *  PortfolioMatcherConfigV16 has `enabled` set (or not) at the correct
   *  offset — mirrors useTrade.v17-portfolio-selection.test.ts's
   *  createLpPortfolioData helper, trimmed to just what isLpPortfolio reads. */
  function makePortfolioBuffer(enabled: boolean, totalLen = 200): Buffer {
    const buf = Buffer.alloc(totalLen);
    const matcherConfigOffset = buf.length - 104;
    buf.writeBigUInt64LE(enabled ? 1n : 0n, matcherConfigOffset + 96);
    return buf;
  }

  it("returns true when the trailing PortfolioMatcherConfigV16.enabled == 1", () => {
    expect(isLpPortfolio(makePortfolioBuffer(true))).toBe(true);
  });

  it("returns false when the trailing PortfolioMatcherConfigV16.enabled == 0", () => {
    expect(isLpPortfolio(makePortfolioBuffer(false))).toBe(false);
  });

  it("returns false for a buffer shorter than the trailing config (can't be an LP)", () => {
    expect(isLpPortfolio(Buffer.alloc(1))).toBe(false);
    expect(isLpPortfolio(Buffer.alloc(103))).toBe(false);
  });

  it("also accepts a plain Uint8Array (not just Buffer)", () => {
    const buf = makePortfolioBuffer(true);
    const plain = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(isLpPortfolio(plain)).toBe(true);
  });

  it("runPortfolioScan excludes an LP-shaped match — a creator who owns ONLY the market's LP resolves to null, not the LP", async () => {
    const { connection, getProgramAccounts } = makeConnection();
    // The LP's mutable owner (offset 116) is the CREATOR's wallet — same
    // memcmp match as any normal owned portfolio would produce.
    getProgramAccounts.mockResolvedValue([
      { pubkey: portfolioPubkey, account: { data: makePortfolioBuffer(true) } },
    ]);
    // parsePortfolioV17 is mocked independently of the raw bytes above (as in
    // every other test in this file) — the owner re-verify would otherwise
    // pass, which is exactly why the isLpPortfolio check must run first.
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });

    expect(getPortfolioUserAccountSnapshot(key)).toBeNull();
    expect(getPortfolioRawSnapshot(key)).toBeNull();
  });

  it("runPortfolioScan selects the non-LP portfolio when both an LP and a genuine trading portfolio match the owner filter", async () => {
    const lpPubkey = uniquePubkey();
    const ownPubkey = uniquePubkey();
    const { connection, getProgramAccounts } = makeConnection();
    getProgramAccounts.mockResolvedValue([
      { pubkey: lpPubkey, account: { data: makePortfolioBuffer(true) } },
      { pubkey: ownPubkey, account: { data: makePortfolioBuffer(false) } },
    ]);
    mocks.parsePortfolioV17.mockReturnValue(makePortfolio());

    const result = await triggerPortfolioScan({
      connection,
      programId,
      slabAddress,
      publicKey: wallet,
      raw: new Uint8Array([1]),
    });

    expect(result?.pubkey.equals(ownPubkey)).toBe(true);
    expect(result?.pubkey.equals(lpPubkey)).toBe(false);
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
