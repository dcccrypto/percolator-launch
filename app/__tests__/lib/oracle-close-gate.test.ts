/**
 * Closes are blocked only when the chain would refuse them (wrapper 7c906e45
 * v16_program.rs: OracleStale only when `global_or_profile_resolve_matured_at_slot`;
 * feed modes also enforce their own max_staleness_secs; AUTH_MARK has no push-age
 * check). A price merely older than the app's 60 s display rule must not trap a user.
 * Opening keeps the 60 s rule.
 */
import fs from "fs";
import path from "path";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, type WrapperConfigV17 } from "@percolatorct/sdk";
import {
  deriveCloseChainFacts,
  isOracleStaleBlocking,
  isResolveMatured,
  oracleCloseGate,
  type CloseChainFacts,
} from "@/lib/oracle-stale-gate";

let slabState: Record<string, unknown> = {};
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slabState }));
const mocks = vi.hoisted(() => ({ getSlot: vi.fn() }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: { getSlot: mocks.getSlot } }),
}));
import { useOracleFreshness } from "@/hooks/useOracleFreshness";

const PUSH_MANAGED: CloseChainFacts = { chainRuleKnown: true, resolveMatured: false, feedMaxStalenessSecs: null };
const stale = { level: "stale" as const, mode: "keeper" as const, ready: true, elapsedSecs: 300 };

describe("oracleCloseGate", () => {
  it("AUTH_MARK stale 5 minutes, not matured: close allowed, with the note", () => {
    expect(oracleCloseGate({ ...stale, facts: PUSH_MANAGED })).toEqual({ blocked: false, behind: true });
  });
  it("matured: blocked, no note", () => {
    expect(oracleCloseGate({ ...stale, facts: { ...PUSH_MANAGED, resolveMatured: true } })).toEqual({ blocked: true, behind: false });
    // matured blocks even while the 60 s level still reads fresh
    expect(oracleCloseGate({ level: "fresh", mode: "keeper", ready: true, facts: { ...PUSH_MANAGED, resolveMatured: true } }).blocked).toBe(true);
  });
  it("unavailable: blocked", () => {
    expect(oracleCloseGate({ level: "unavailable", mode: "keeper", ready: false, facts: PUSH_MANAGED }).blocked).toBe(true);
  });
  it("fresh / aging: allowed, no note", () => {
    for (const level of ["fresh", "aging"] as const) {
      expect(oracleCloseGate({ level, mode: "keeper", ready: true, facts: PUSH_MANAGED })).toEqual({ blocked: false, behind: false });
    }
  });
  it("feed mode: within its own max staleness allowed, past it blocked", () => {
    const feed: CloseChainFacts = { chainRuleKnown: true, resolveMatured: false, feedMaxStalenessSecs: 120 };
    expect(oracleCloseGate({ level: "stale", mode: "pyth-pinned", ready: true, elapsedSecs: 90, facts: feed })).toEqual({ blocked: false, behind: true });
    expect(oracleCloseGate({ level: "stale", mode: "pyth-pinned", ready: true, elapsedSecs: 121, facts: feed }).blocked).toBe(true);
    // a feed mode with no readable limit is not guessed at
    expect(oracleCloseGate({ level: "stale", mode: "pyth-pinned", ready: true, elapsedSecs: 90, facts: { ...feed, feedMaxStalenessSecs: 0 } }).blocked).toBe(true);
  });
  it("unknown chain rules (legacy slab / no facts): keeps the old 60 s block", () => {
    expect(oracleCloseGate({ ...stale }).blocked).toBe(true);
    expect(oracleCloseGate({ ...stale, facts: deriveCloseChainFacts(null, null, 1n) }).blocked).toBe(true);
  });
  it("opening trades keep the 60 s rule", () => {
    expect(isOracleStaleBlocking("stale", "keeper", true)).toBe(true); // 61 s+ still blocks opening
  });
});

describe("isResolveMatured mirrors the chain (threshold read from the market)", () => {
  const cfg = { permissionlessResolveStaleSlots: 9000n, lastGoodOracleSlot: 1000n, oracleMode: 3 };
  it("global last-good slot", () => {
    expect(isResolveMatured(cfg, null, 9999n)).toBe(false);
    expect(isResolveMatured(cfg, null, 10_000n)).toBe(true);
  });
  it("per-asset profile slot (price-managed modes only, non-zero)", () => {
    const c = { ...cfg, lastGoodOracleSlot: 9990n };
    expect(isResolveMatured(c, { oracleMode: 3, lastGoodOracleSlot: 100n }, 10_000n)).toBe(true);
    expect(isResolveMatured(c, { oracleMode: 0, lastGoodOracleSlot: 100n }, 10_000n)).toBe(false);
    expect(isResolveMatured(c, { oracleMode: 3, lastGoodOracleSlot: 0n }, 10_000n)).toBe(false);
  });
  it("threshold 0 disables it; unknown cluster slot cannot show maturity", () => {
    expect(isResolveMatured({ ...cfg, permissionlessResolveStaleSlots: 0n }, null, 10n ** 12n)).toBe(false);
    expect(isResolveMatured(cfg, null, null)).toBe(false);
  });
});

describe("useOracleFreshness().closeFacts on real v18 bytes (TRUMP, AUTH_MARK)", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../fixtures/CdN8r7FB.freshness.market.json"), "utf8"),
  ) as { contextSlot: number; dataBase64: string };
  const CAPTURE = BigInt(fixture.contextSlot);
  const live: WrapperConfigV17 = parseWrapperConfigV17(new Uint8Array(Buffer.from(fixture.dataBase64, "base64")));
  const slab = (w: WrapperConfigV17) => ({
    config: {
      oracleAuthority: new PublicKey("Sysvar1111111111111111111111111111111111112"),
      indexFeedId: PublicKey.default,
      authorityTimestamp: 0n,
      authorityPriceE6: w.markEwmaE6,
      lastEffectivePriceE6: w.markEwmaE6,
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
    },
    engine: null,
    wrapperConfigV17: w,
    assetProfile: null,
  });
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());

  it("5 minutes without a push (750 slots): stale, not matured -> close allowed with the note", async () => {
    slabState = slab({ ...live, permissionlessResolveStaleSlots: 9000n });
    mocks.getSlot.mockResolvedValue(Number(CAPTURE + 750n));
    const { result, unmount } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    await waitFor(() => expect(result.current.level).toBe("stale"));
    expect(result.current.closeFacts.resolveMatured).toBe(false);
    expect(oracleCloseGate({ ...result.current, facts: result.current.closeFacts })).toEqual({ blocked: false, behind: true });
    unmount();
  });

  it("past the market's own resolve-stale threshold: matured -> close blocked", async () => {
    slabState = slab({ ...live, permissionlessResolveStaleSlots: 9000n });
    mocks.getSlot.mockResolvedValue(Number(CAPTURE + 9000n));
    const { result, unmount } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    await waitFor(() => expect(result.current.closeFacts.resolveMatured).toBe(true));
    expect(oracleCloseGate({ ...result.current, facts: result.current.closeFacts }).blocked).toBe(true);
    unmount();
  });

  it("the live market's threshold is 0 (maturity disabled): never matured however old", async () => {
    expect(live.permissionlessResolveStaleSlots).toBe(0n);
    slabState = slab(live);
    mocks.getSlot.mockResolvedValue(Number(CAPTURE + 1_000_000n));
    const { result, unmount } = renderHook(() => useOracleFreshness({ trackSeconds: true }));
    await waitFor(() => expect(result.current.level).toBe("stale"));
    expect(result.current.closeFacts.resolveMatured).toBe(false);
    unmount();
  });
});
