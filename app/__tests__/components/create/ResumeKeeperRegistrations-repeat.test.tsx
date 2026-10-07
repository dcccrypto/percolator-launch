/**
 * percolator-indexer#223: an unfinished registration resumes on the next visit to ANY page (the
 * component lives in app/providers.tsx) and is then retried every minute while the page stays open,
 * for as long as a slab is still "try again" (ceiling full, server busy, tx not visible yet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const resume = vi.fn();
vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet" }) }));
vi.mock("@/lib/keeper-register-client", () => ({
  RESUME_REPEAT_MS: 60_000,
  RESUME_MAX_PASSES: 30,
  RESUME_MAX_MS: 30 * 60_000,
  resumePendingRegistrations: (d: unknown) => resume(d),
}));

async function mount() {
  vi.resetModules();
  const { ResumeKeeperRegistrations } = await import("@/components/create/ResumeKeeperRegistrations");
  return render(<ResumeKeeperRegistrations />);
}

beforeEach(() => {
  vi.useFakeTimers();
  resume.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ResumeKeeperRegistrations", () => {
  it("passes once on load, then every minute for only the slabs still 'try again', and stops when none are", async () => {
    resume
      .mockResolvedValueOnce({ registered: [], retryLater: ["A", "B"], refused: [] })
      .mockResolvedValueOnce({ registered: ["A"], retryLater: ["B"], refused: [] })
      .mockResolvedValueOnce({ registered: ["B"], retryLater: [], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][0]).not.toHaveProperty("only");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[1][0]).toMatchObject({ only: ["A", "B"] });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(3);
    expect(resume.mock.calls[2][0]).toMatchObject({ only: ["B"] });

    await vi.advanceTimersByTimeAsync(5 * 60_000); // nothing left: no more passes
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it("CONTROL: nothing pending on load -> a single pass, no timer left running", async () => {
    resume.mockResolvedValue({ registered: [], retryLater: [], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("a slab that fails retryably for ever stops after 30 passes (CONTROL: it would otherwise run all day)", async () => {
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resume).toHaveBeenCalledTimes(30);
  });

  it("stops after 30 minutes even if fewer than 30 passes ran (Retry-After 300 s -> about 6 passes)", async () => {
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [], retryAfterMs: 300_000 });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    const n = resume.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(8); // not 30: the 300 s Retry-After is respected, not retried at 60 s
  });
});
