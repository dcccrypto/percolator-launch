import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSignInLoopRecovery, SESSION_DROP_WINDOW_MS } from "../../hooks/useSignInLoopRecovery";

function setup() {
  return renderHook((p: { authenticated: boolean }) => useSignInLoopRecovery({ ready: true, ...p }), {
    initialProps: { authenticated: false },
  });
}

describe("useSignInLoopRecovery clock handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  function signInThenDrop(elapsedMs: number, loggedOut = false) {
    const h = setup();
    act(() => h.result.current.noteConnectAttempt());
    h.rerender({ authenticated: true });
    if (loggedOut) act(() => h.result.current.noteUserLogout());
    vi.setSystemTime(Date.now() + elapsedMs);
    h.rerender({ authenticated: false });
    return h;
  }

  it("flags a drop within the window", () => {
    expect(signInThenDrop(500).result.current.needsReset).toBe(true);
    expect(signInThenDrop(SESSION_DROP_WINDOW_MS).result.current.needsReset).toBe(true);
  });
  it("does not flag a drop after the window", () => {
    expect(signInThenDrop(SESSION_DROP_WINDOW_MS + 1).result.current.needsReset).toBe(false);
  });
  it("does not flag when the clock stepped backwards (negative age)", () => {
    expect(signInThenDrop(-60_000).result.current.needsReset).toBe(false);
  });
  it("does not flag a user-requested logout", () => {
    expect(signInThenDrop(500, true).result.current.needsReset).toBe(false);
  });
});
