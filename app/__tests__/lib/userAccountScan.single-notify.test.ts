/**
 * #2560 review: runPortfolioScan publishes the single snapshot AND the full owned-portfolio
 * list from ONE scan, and must notify subscribers exactly ONCE per scan (a second notify
 * doubles every useUserAccount consumer's re-render). The pre-existing listener-count tests in
 * userAccountScan.test.ts / userAccountScan.pending.test.ts cover the one-portfolio shapes; this
 * file covers the multi-portfolio shapes the list publish adds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";

const mocks = vi.hoisted(() => ({ parsePortfolioV17: vi.fn() }));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return { ...actual, parsePortfolioV17: mocks.parsePortfolioV17 };
});

import {
  makePortfolioScanKey,
  triggerPortfolioScan,
  subscribePortfolioScan,
  getPortfolioListSnapshot,
} from "@/lib/userAccountScan";

let counter = 100;
const uniquePubkey = () => new PublicKey(new Uint8Array(32).fill(++counter % 256));

let programId: PublicKey;
let wallet: PublicKey;
let slabAddress: string;

beforeEach(() => {
  vi.clearAllMocks();
  programId = uniquePubkey();
  wallet = uniquePubkey();
  slabAddress = uniquePubkey().toBase58();
});

function portfolio(basisPosQ: bigint) {
  return {
    marketGroupId: new PublicKey(slabAddress),
    provenanceOwner: wallet,
    owner: wallet,
    capital: 1_000n,
    pnl: 0n,
    reservedPnl: 0n,
    feeCredits: 0n,
    lastFeeSlot: 0n,
    legs: [{ active: true, assetIndex: 0, marketId: 1n, side: 0, basisPosQ }],
    sourceDomains: [],
  };
}

function setup(sizes: Record<string, bigint>) {
  const getProgramAccounts = vi.fn();
  const connection = { getProgramAccounts } as unknown as Connection;
  const pks = Object.keys(sizes).map((k) => new PublicKey(new Uint8Array(32).fill(Number(k))));
  const run = (next: Record<string, bigint>) => {
    getProgramAccounts.mockResolvedValue(pks.map((pk, i) => ({ pubkey: pk, account: { data: Buffer.from([i]) } })));
    // parsePortfolioV17 is called with each account's data buffer: first byte = index.
    mocks.parsePortfolioV17.mockImplementation((d: Buffer) => portfolio(next[Object.keys(next)[d[0]]]));
  };
  return { connection, pks, run };
}

describe("runPortfolioScan notifies once per scan", () => {
  it("first scan of a wallet with TWO portfolios: exactly one notification", async () => {
    const { connection, run } = setup({ "1": 5n, "200": 7n });
    run({ "1": 5n, "200": 7n });
    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    expect(getPortfolioListSnapshot(key)).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("only the NON-primary portfolio changed: one notification, primary snapshot identity kept", async () => {
    const { connection, run } = setup({ "1": 5n, "200": 7n });
    run({ "1": 5n, "200": 7n });
    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    const before = getPortfolioListSnapshot(key);
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);
    run({ "1": 5n, "200": 9n });
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });
    expect(listener).toHaveBeenCalledTimes(1);
    const after = getPortfolioListSnapshot(key);
    expect(after[0]).toBe(before[0]); // unchanged row keeps identity
    expect(after[1]).not.toBe(before[1]);
  });

  it("an unchanged re-scan notifies nobody", async () => {
    const { connection, run } = setup({ "1": 5n, "200": 7n });
    run({ "1": 5n, "200": 7n });
    const key = makePortfolioScanKey(programId, slabAddress, wallet);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([1]) });
    const listener = vi.fn();
    subscribePortfolioScan(key, listener);
    await triggerPortfolioScan({ connection, programId, slabAddress, publicKey: wallet, raw: new Uint8Array([2]) });
    expect(listener).not.toHaveBeenCalled();
  });
});
