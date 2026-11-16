import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock("gsap"));

describe("withGsap", () => {
  it("runs once gsap has loaded, then synchronously on later calls", async () => {
    const fake = { to: vi.fn() };
    vi.doMock("gsap", () => ({ default: fake }));
    const { withGsap } = await import("@/lib/gsap-lazy");
    const first = vi.fn();
    withGsap(first);
    expect(first).not.toHaveBeenCalled();
    await flush();
    expect(first).toHaveBeenCalledWith(fake);
    const second = vi.fn();
    withGsap(second);
    expect(second).toHaveBeenCalledWith(fake); // no await: already loaded
  });

  it("a cancelled call never runs (effect cleanup before the chunk arrives)", async () => {
    vi.doMock("gsap", () => ({ default: { to: vi.fn() } }));
    const { withGsap } = await import("@/lib/gsap-lazy");
    const run = vi.fn();
    const onErr = vi.fn();
    const cancel = withGsap(run, onErr);
    cancel();
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(onErr).not.toHaveBeenCalled();
  });

  it("a failed load runs the end-state fallback instead", async () => {
    vi.doMock("gsap", () => {
      throw new Error("chunk load failed");
    });
    const { withGsap } = await import("@/lib/gsap-lazy");
    const run = vi.fn();
    const onErr = vi.fn();
    withGsap(run, onErr);
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(onErr).toHaveBeenCalledTimes(1);
  });
});
