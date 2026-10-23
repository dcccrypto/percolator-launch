/**
 * #2643 — Custom(9) on a trade is ambiguous (limit-price slippage vs an unusable
 * market). The UI must distinguish them from PRE-TRADE STATE, not guess.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

const MATCHER = new PublicKey(new Uint8Array(32).fill(3));
const PROGRAM = new PublicKey(new Uint8Array(32).fill(4));
const SLAB = new PublicKey(new Uint8Array(32).fill(5));

const mocks = vi.hoisted(() => ({
  readiness: "ready" as "ready" | "not-ready" | "unknown",
  complete: true as boolean,
  slabIsV17: true,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ matcherProgramId: new PublicKey(new Uint8Array(32).fill(3)).toBase58() }),
}));
vi.mock("@/lib/matcherCaps", () => ({
  readMatcherContextReadiness: vi.fn(async () => mocks.readiness),
}));
vi.mock("@/lib/market-completeness", () => ({
  isMarketauthComplete: vi.fn(() => mocks.complete),
}));
// The diagnosis asks lib/v22/layout whether the slab is a wrapper market (flag off it delegates to the SDK isV17Account): stub that seam too.
vi.mock("@/lib/v22/layout", async (orig) => ({ ...(await orig<object>()), isWrapperAccount: () => mocks.slabIsV17 }));
vi.mock("@percolatorct/sdk", () => ({
  isV17Account: vi.fn(() => mocks.slabIsV17),
  parseWrapperConfigV17: vi.fn(() => ({ marketauth: new PublicKey(new Uint8Array(32).fill(9)) })),
  V17_HEADER_LEN: 16,
}));

import {
  isCustom9Error,
  classifyCustom9,
  custom9Message,
  diagnoseTradeRejection,
} from "@/lib/tradeRejectDiagnosis";

const conn = () =>
  ({ getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(64) })) }) as unknown as import("@solana/web3.js").Connection;

describe("isCustom9Error", () => {
  it("matches exactly code 9 in every error shape", () => {
    expect(isCustom9Error("Transaction failed: Custom(9)")).toBe(true);
    expect(isCustom9Error('{"InstructionError":[0,{"Custom":9}]}')).toBe(true);
    expect(isCustom9Error("custom program error: 0x9")).toBe(true);
  });
  it("does not match other codes that merely start with 9 / 0x9", () => {
    expect(isCustom9Error("Custom(90)")).toBe(false);
    expect(isCustom9Error('{"Custom":91}')).toBe(false);
    expect(isCustom9Error("custom program error: 0x90")).toBe(false);
    expect(isCustom9Error("custom program error: 0x21")).toBe(false);
  });
});

describe("classifyCustom9 / custom9Message", () => {
  it("proven matcher-not-ready wins, even if the market is otherwise complete", () => {
    expect(classifyCustom9({ complete: true, matcher: "not-ready" })).toBe("matcher-uninitialised");
  });
  it("incomplete market with a usable matcher is reported as unfinished, not as slippage", () => {
    const cause = classifyCustom9({ complete: false, matcher: "ready" });
    expect(cause).toBe("market-incomplete");
    expect(custom9Message(cause)).toMatch(/never finished being created/);
    expect(custom9Message(cause)).not.toMatch(/moved past your slippage/);
  });
  it("complete + ready, or unreadable state, stays undetermined (keeps generic text)", () => {
    expect(classifyCustom9({ complete: true, matcher: "ready" })).toBe("undetermined");
    expect(classifyCustom9({ complete: null, matcher: "unknown" })).toBe("undetermined");
    expect(custom9Message("undetermined")).toBeNull();
  });
});

describe("diagnoseTradeRejection", () => {
  beforeEach(() => {
    mocks.readiness = "ready";
    mocks.complete = true;
    mocks.slabIsV17 = true;
  });

  it("does nothing (and reads nothing) for a non-Custom(9) error", async () => {
    const c = conn();
    expect(await diagnoseTradeRejection("Custom(21)", c, PROGRAM, SLAB)).toBeNull();
    expect((c as unknown as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo).not.toHaveBeenCalled();
  });

  it("Custom(9) on an uninitialised-matcher market -> matcher message", async () => {
    mocks.readiness = "not-ready";
    const msg = await diagnoseTradeRejection("Custom(9)", conn(), PROGRAM, SLAB);
    expect(msg).toMatch(/matcher was never set up/);
  });

  it("Custom(9) on an incomplete market -> unfinished-market message", async () => {
    mocks.complete = false;
    const msg = await diagnoseTradeRejection("Custom(9)", conn(), PROGRAM, SLAB);
    expect(msg).toMatch(/never finished being created/);
  });

  it("Custom(9) on a complete, ready market -> null (generic slippage-or-param text stays)", async () => {
    expect(await diagnoseTradeRejection("Custom(9)", conn(), PROGRAM, SLAB)).toBeNull();
  });

  it("never throws when the slab read fails", async () => {
    const c = { getAccountInfo: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as import("@solana/web3.js").Connection;
    mocks.readiness = "unknown";
    expect(await diagnoseTradeRejection("Custom(9)", c, PROGRAM, SLAB)).toBeNull();
  });
});
