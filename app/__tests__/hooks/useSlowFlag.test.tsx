import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_LOADING_COPY, SLOW_ACCOUNT_SCAN_MS, useSlowFlag } from "@/hooks/useSlowFlag";

describe("useSlowFlag: a first portfolio scan that is slow gets one calm line", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is false at first, true after 15 s of continuous loading", () => {
    const { result } = renderHook(({ on }) => useSlowFlag(on), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(SLOW_ACCOUNT_SCAN_MS - 1));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("never fires for a scan that finishes in time, and restarts the clock on the next load", () => {
    const { result, rerender } = renderHook(({ on }) => useSlowFlag(on), { initialProps: { on: true } });
    act(() => void vi.advanceTimersByTime(10_000));
    rerender({ on: false });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(false);
    rerender({ on: true });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it("copy is one calm line and the ticket button uses it while the scan is pending", () => {
    expect(ACCOUNT_LOADING_COPY.slow).toBe("Still loading your account. Retrying…");
    const src = readFileSync(join(__dirname, "../../components/trade/OrderTicket.tsx"), "utf8");
    expect(src).toContain("useSlowFlag(accountPending)");
    expect(src).toMatch(/accountScanSlow\s*\?\s*ACCOUNT_LOADING_COPY\.slow\s*:\s*ACCOUNT_LOADING_COPY\.loading/);
    expect(src).not.toContain('"Loading account…"');
  });
});
