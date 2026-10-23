/**
 * UX WP-8 AC3 (audit §3.9): keeper-first. While a market is settled but not yet payable, the hook
 * re-reads on its own (every RESOLVED_POLL_MS) and flips to "ready" when the keeper has finished,
 * with no user action. A live market is read once and never polled; polling stops once ready.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { blankMarket } from "../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";

const h = vi.hoisted(() => ({ mode: 1, count: 1n, reads: 0 }));
const PROGRAM = Keypair.generate().publicKey;
const SLAB = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey;

function marketBytes(): Uint8Array {
  const d = blankMarket(); // the ACTIVE layout's market: VERSION 18 flag off, 19 flag on (helpers/v22-fixtures.ts)
  const v = new DataView(d.buffer);
  const M = marketOffsets(d);
  d[10] = C.KIND_MARKET_ACCOUNT;
  d[M.hdr(C.H_MODE)] = h.mode;
  v.setBigUint64(M.hdr(C.H_MATERIALIZED_PORTFOLIO_COUNT), h.count, true);
  v.setBigUint64(M.hdr(C.H_RESOLVED_SLOT), 100n, true);
  return d;
}
const connection = {
  getAccountInfo: vi.fn(async (pk: { toBase58(): string }) => {
    if (pk.toBase58() !== SLAB) return null;
    h.reads++;
    return { owner: PROGRAM, data: Buffer.from(marketBytes()) };
  }),
  getSlot: vi.fn(async () => 10_000),
  getProgramAccounts: vi.fn(async () => []),
};
// Stable objects, as the real providers return (memoized state).
const WALLET = { publicKey: null };
const CONN = { connection };
const SLAB_STATE = { programId: PROGRAM.toBase58(), config: { collateralMint: MINT } };
vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => CONN, useWalletCompat: () => WALLET }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => SLAB_STATE }));

// PDA derivation hashes under jsdom's cross-realm Uint8Array fail ("no viable program address"); the
// addresses are irrelevant to polling, so they are stubbed.
function PDA() {
  return [Keypair.generate().publicKey, 255] as const; // a function declaration: hoisted above the vi.mock factories that use it
}
vi.mock("@/lib/limits/p3-ix", async (orig) => ({ ...(await orig<object>()), deriveLpVaultRegistryPda: () => PDA()[0], deriveVaultLpState: () => PDA()[0] }));
vi.mock("@percolatorct/sdk", async (orig) => ({ ...(await orig<object>()), deriveVaultAuthority: PDA, deriveLpBackingLedger: PDA }));
// With the v2.1 flag on the loader also derives the VaultLpExt PDA (a PDA hash that fails under jsdom like the others): stub it the same way.
vi.mock("@/lib/v21/sdk", async (orig) => ({ ...(await orig<object>()), deriveVaultLpExt: () => PDA()[0] }));
vi.mock("@solana/spl-token", async (orig) => ({ ...(await orig<object>()), getAssociatedTokenAddressSync: () => PDA()[0] }));

const { useResolvedExit, RESOLVED_POLL_MS } = await import("@/hooks/useResolvedExit");

describe("AC3: settled -> ready with no user action", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h.reads = 0;
  });
  afterEach(() => vi.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  };

  it("polls while settling, flips to ready when the market is flat, then stops polling", async () => {
    h.mode = C.MARKET_MODE_RESOLVED;
    h.count = 1n;
    const { result } = renderHook(() => useResolvedExit(SLAB));
    await flush();
    expect(result.current.error).toBeNull();
    expect(result.current.plan?.phase).toBe("sweep");
    const first = h.reads;
    await act(async () => { vi.advanceTimersByTime(RESOLVED_POLL_MS); });
    await flush();
    expect(h.reads).toBeGreaterThan(first);
    h.count = 0n; // the keeper finished
    await act(async () => { vi.advanceTimersByTime(RESOLVED_POLL_MS); });
    await flush();
    expect(result.current.plan?.phase).toBe("ready");
    const atReady = h.reads;
    await act(async () => { vi.advanceTimersByTime(RESOLVED_POLL_MS * 3); });
    await flush();
    expect(h.reads).toBe(atReady);
  });

  it("a live market is read once and never polled", async () => {
    h.mode = 0;
    const { result } = renderHook(() => useResolvedExit(SLAB));
    await flush();
    expect(result.current.plan?.phase).toBe("not-resolved");
    const n = h.reads;
    await act(async () => { vi.advanceTimersByTime(RESOLVED_POLL_MS * 3); });
    await flush();
    expect(h.reads).toBe(n);
  });
});
