/**
 * The "LONG capacity left" row flickered on and off on an active market.
 *
 * `useMarketFillCap`'s effect resets its state before refetching:
 *
 *     setCaps(null);
 *     setInventoryBase(null);
 *
 * which is correct on a real market switch — market B must not validate
 * against market A's caps. But the effect depended on the `programId`
 * OBJECT, and SlabProvider rebuilds that object on every slab poll
 * (`programId: owner ?? s.programId`, where `owner` is a fresh PublicKey from
 * each getAccountInfo response). `parseSlab` only short-circuits when the
 * slab bytes are byte-identical, so on a market with any activity the state
 * updates every poll and the identity churns with it.
 *
 * Result: the effect re-ran on a 3s cadence, blanked both values, and
 * refetched. `getMatcherCaps` is served from a process-wide cache so the
 * "Max per trade" row came back almost instantly, while `inventoryBase`
 * needed a fresh network read — so the capacity row was the one that visibly
 * flickered.
 *
 * The repo already has the idiom for this (`programIdStr` in
 * usePositionNft.ts:354 and useUserAccount.ts:66, and the PERC-9204 note in
 * useInsuranceLP.ts:170 about SlabProvider rebuilding `config` every poll).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { PublicKey, Keypair } from "@solana/web3.js";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/matcherCaps", () => ({
  getMatcherCaps: vi.fn(),
  getLpInventoryState: vi.fn(),
}));

import { useMarketFillCap } from "../../hooks/useMarketFillCap";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getMatcherCaps, getLpInventoryState } from "@/lib/matcherCaps";

const PROGRAM_ID_B58 = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const SLAB_A = Keypair.generate().publicKey.toBase58();
const SLAB_B = Keypair.generate().publicKey.toBase58();

const CAPS = { maxFillAbs: 1_000_000n, maxInventoryAbs: 5_000_000n };
const INVENTORY = 123_456n;

/** A never-settling promise: pins whatever state the effect left behind. */
const pending = <T,>() => new Promise<T>(() => {});

describe("useMarketFillCap — slab-poll churn must not blank the capacity row", () => {
  const connection = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConnectionCompat).mockReturnValue({ connection });
    vi.mocked(getMatcherCaps).mockResolvedValue(CAPS);
    vi.mocked(getLpInventoryState).mockResolvedValue({ counterQ: INVENTORY, realQ: null, syncLive: false });
  });

  /** SlabProvider hands out a BRAND NEW PublicKey for the same program. */
  function setProgramId(b58: string) {
    vi.mocked(useSlabState).mockReturnValue({
      programId: new PublicKey(b58),
    } as never);
  }

  async function renderSettled(slab: string) {
    setProgramId(PROGRAM_ID_B58);
    const h = renderHook(({ s }) => useMarketFillCap(s), {
      initialProps: { s: slab },
    });
    await act(async () => {});
    return h;
  }

  it("premise: SlabProvider re-emits a NEW object with the SAME value", () => {
    // Both assertions below are NEGATIVE ("unchanged"), which is also what a
    // test that reproduces nothing reports. Pin the mechanism explicitly so
    // they cannot pass vacuously — e.g. after a future migration to
    // @solana/kit, whose addresses are opaque strings and never churn.
    const a = new PublicKey(PROGRAM_ID_B58);
    const b = new PublicKey(PROGRAM_ID_B58);
    expect(b).not.toBe(a);
    expect(b.toBase58()).toBe(a.toBase58());
  });

  it("keeps the capacity value when SlabProvider re-emits the same programId", async () => {
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    // A slab poll lands: same program, new object. Nothing may resolve after
    // this point, so whatever the effect does is what stays on screen.
    vi.mocked(getMatcherCaps).mockReturnValue(pending());
    vi.mocked(getLpInventoryState).mockReturnValue(pending());
    setProgramId(PROGRAM_ID_B58);
    await act(async () => {
      rerender({ s: SLAB_A });
    });

    // Pre-fix: the effect re-ran, blanked both, and the row unmounted.
    expect(result.current).not.toBeNull();
    expect(result.current?.inventoryBase).toBe(INVENTORY);
  });

  it("does not refetch on a same-value programId re-emit", async () => {
    const { rerender } = await renderSettled(SLAB_A);
    const capsCalls = vi.mocked(getMatcherCaps).mock.calls.length;

    for (let poll = 0; poll < 3; poll++) {
      setProgramId(PROGRAM_ID_B58);
      await act(async () => {
        rerender({ s: SLAB_A });
      });
    }

    // Pre-fix this was capsCalls + 3 — a full re-resolve every slab poll.
    expect(vi.mocked(getMatcherCaps).mock.calls.length).toBe(capsCalls);
  });

  it("CONTROL: a real market switch still resets, so B cannot inherit A", async () => {
    // Load-bearing. The reset exists to stop market B validating against
    // market A's caps; the fix must not turn it into "never reset".
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    vi.mocked(getMatcherCaps).mockReturnValue(pending());
    vi.mocked(getLpInventoryState).mockReturnValue(pending());
    await act(async () => {
      rerender({ s: SLAB_B });
    });

    expect(result.current).toBeNull();
  });

  it("CONTROL: ...and then loads market B's own values", async () => {
    // The other half of the reset contract, and the one that matters most:
    // "never refetch after the first mount" satisfies EVERY other test in this
    // file while leaving the row gone for the rest of the session — strictly
    // worse than the flicker this PR fixes. Resetting is only correct if a
    // reload follows.
    const INVENTORY_B = 999_000n;
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    vi.mocked(getLpInventoryState).mockResolvedValue({ counterQ: INVENTORY_B, realQ: null, syncLive: false });
    await act(async () => {
      rerender({ s: SLAB_B });
    });

    await waitFor(() => expect(result.current?.inventoryBase).toBe(INVENTORY_B));
  });

  it("CONTROL: a genuinely different programId still resets", async () => {
    // The stabilized dependency must track the program's VALUE, not merely
    // drop the dependency.
    const { result, rerender } = await renderSettled(SLAB_A);
    expect(result.current?.inventoryBase).toBe(INVENTORY);

    vi.mocked(getMatcherCaps).mockReturnValue(pending());
    vi.mocked(getLpInventoryState).mockReturnValue(pending());
    setProgramId(Keypair.generate().publicKey.toBase58());
    await act(async () => {
      rerender({ s: SLAB_A });
    });

    expect(result.current).toBeNull();
  });
});

describe("useMarketFillCap — a failed caps read must not disable the cap guards", () => {
  const connection = {} as never;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    vi.mocked(useConnectionCompat).mockReturnValue({ connection });
    vi.mocked(useSlabState).mockReturnValue({
      programId: new PublicKey(PROGRAM_ID_B58),
    } as never);
    vi.mocked(getLpInventoryState).mockResolvedValue({ counterQ: INVENTORY, realQ: null, syncLive: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the first caps resolve, so one 429 at mount is not fatal", async () => {
    // getMatcherCaps returns null for BOTH "no matcher config" and "the read
    // failed" (`.catch(() => null)` in lib/matcherCaps.ts). Before the retry,
    // a single rate-limited getProgramAccounts at mount left the ticket with
    // no per-trade cap and no inventory for the whole market visit — and
    // `exceedsFillCap`/`exceedsSideCapacity` both false, so it would happily
    // submit an order that reverts with a bare InvalidAccountData.
    vi.mocked(getMatcherCaps)
      .mockResolvedValueOnce(null) // the 429
      .mockResolvedValue(CAPS); // recovered

    const { result } = renderHook(() => useMarketFillCap(SLAB_A));
    await act(async () => {});
    expect(result.current).toBeNull(); // first attempt failed

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(result.current?.maxFillAbs).toBe(CAPS.maxFillAbs);
    expect(result.current?.inventoryBase).toBe(INVENTORY);
  });

  it("gives up after a bounded number of attempts on a genuinely cap-less market", async () => {
    // CONTROL on the retry. A v12/mock/broken market really has no matcher
    // config, and must not sit in an unbounded getProgramAccounts loop.
    vi.mocked(getMatcherCaps).mockResolvedValue(null);

    renderHook(() => useMarketFillCap(SLAB_A));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    // initial attempt + the three backoff retries, then silence
    expect(vi.mocked(getMatcherCaps).mock.calls.length).toBe(4);
  });

  it("re-reads caps on the poll tick, so the TTL and invalidation can land", async () => {
    // lib/matcherCaps.ts bounds staleness with a 300s TTL and exposes
    // invalidateMatcherCaps(), which useTrade.ts:714 calls after a failed
    // trade. Neither reaches this hook unless it asks again.
    vi.mocked(getMatcherCaps).mockResolvedValue(CAPS);

    renderHook(() => useMarketFillCap(SLAB_A));
    await act(async () => {});
    const afterMount = vi.mocked(getMatcherCaps).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(vi.mocked(getMatcherCaps).mock.calls.length).toBeGreaterThan(afterMount);
  });

  it("CONTROL: a failed re-read does not blank caps that are already good", async () => {
    // Load-bearing. Blanking on a transient failure would re-open the flicker
    // AND drop the guards; keeping the last good value fails safe, because the
    // ticket keeps BLOCKING over-cap orders instead of silently allowing them.
    vi.mocked(getMatcherCaps).mockResolvedValue(CAPS);
    const { result } = renderHook(() => useMarketFillCap(SLAB_A));
    await act(async () => {});
    expect(result.current?.maxFillAbs).toBe(CAPS.maxFillAbs);

    vi.mocked(getMatcherCaps).mockResolvedValue(null);
    vi.mocked(getLpInventoryState).mockResolvedValue({ counterQ: null, realQ: null, syncLive: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(result.current?.maxFillAbs).toBe(CAPS.maxFillAbs);
    expect(result.current?.inventoryBase).toBe(INVENTORY);
  });
});
