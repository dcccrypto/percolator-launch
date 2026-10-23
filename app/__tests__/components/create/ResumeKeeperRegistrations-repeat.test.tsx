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
  pendingRegistrationSlabs: (store: Storage) => {
    const slabs: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith("perc.keeperProofTx.") || (store.getItem(key)?.length ?? 0) < 64) continue;
      const slab = key.slice("perc.keeperProofTx.".length);
      if (store.getItem(`perc.keeperRegistered.${slab}`) === null) slabs.push(slab);
    }
    return slabs;
  },
  resumePendingRegistrations: (d: unknown) => resume(d),
}));

const PROOF = "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY";
function persist(...slabs: string[]) {
  for (const slab of slabs) {
    localStorage.setItem(`perc.keeperProofTx.${slab}`, PROOF);
    localStorage.setItem(`perc.keeperPayload.${slab}`, JSON.stringify({ dex_pool_address: "POOL" }));
    localStorage.setItem(`perc.keeperRequest.${slab}`, JSON.stringify({ slabAddress: slab, dexPoolAddress: "POOL" }));
  }
}

async function mount() {
  vi.resetModules();
  const { ResumeKeeperRegistrations } = await import("@/components/create/ResumeKeeperRegistrations");
  return render(<ResumeKeeperRegistrations />);
}

beforeEach(() => {
  vi.useFakeTimers();
  resume.mockReset();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ResumeKeeperRegistrations", () => {
  it("passes once on load, then every minute for only the slabs still 'try again', and stops when none are", async () => {
    persist("A", "B");
    const counts = new Map<string, number>();
    resume.mockImplementation(async ({ only }: { only: string[] }) => {
      const slab = only[0];
      const n = (counts.get(slab) ?? 0) + 1;
      counts.set(slab, n);
      return slab === "A" && n >= 2 || slab === "B" && n >= 3
        ? { registered: [slab], retryLater: [], refused: [] }
        : { registered: [], retryLater: [slab], refused: [] };
    });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls.map(([d]) => d.only)).toEqual([["A"], ["B"]]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(5);
    expect(resume.mock.calls[4][0]).toMatchObject({ only: ["B"] });

    await vi.advanceTimersByTimeAsync(5 * 60_000); // nothing left: no more passes
    expect(resume).toHaveBeenCalledTimes(5);
  });

  it("CONTROL: nothing pending on load -> no scan or timer left running", async () => {
    resume.mockResolvedValue({ registered: [], retryLater: [], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(resume).not.toHaveBeenCalled();
  });

  it("a slab that fails retryably for ever stops after 30 passes (CONTROL: it would otherwise run all day)", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resume).toHaveBeenCalledTimes(30);
  });

  it("stops after 30 minutes even if fewer than 30 passes ran (Retry-After 300 s -> about 6 passes)", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [], retryAfterMs: 300_000 });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    const n = resume.mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(8); // not 30: the 300 s Retry-After is respected, not retried at 60 s
  });
});

// V22_PENDING_WAKEUP_REGRESSION
// Proposed event contract: new persisted keeper registration needs
// to wake the global scanner after its initial empty pass.
describe("V2.2 pending registration wake-up", () => {
  it("resumes scanning when a new pending registration is announced", async () => {
    resume.mockResolvedValue({ registered: ["NEW_MARKET"], retryLater: [], refused: [] });

    await mount();
    await vi.advanceTimersByTimeAsync(0);

    expect(resume).not.toHaveBeenCalled();

    // The initial scan was empty and stopped its timer.
    // A newly persisted registration should wake it.
    persist("NEW_MARKET");
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "NEW_MARKET" } }));

    await vi.advanceTimersByTimeAsync(0);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][0]).toMatchObject({ only: ["NEW_MARKET"] });
  });
});
// V22_STRICT_MODE_LIFECYCLE_REGRESSION
describe("V2.2 Strict Mode registration lifecycle", () => {
  it("keeps pending wake-up active after Strict Mode effect replay", async () => {
    resume.mockResolvedValue({
      registered: [],
      retryLater: [],
      refused: [],
    });

    vi.resetModules();

    const { ResumeKeeperRegistrations } =
      await import("@/components/create/ResumeKeeperRegistrations");

    const { StrictMode } = await import("react");

    render(
      <StrictMode>
        <ResumeKeeperRegistrations />
      </StrictMode>
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(resume).not.toHaveBeenCalled();

    persist("NEW_MARKET");
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "NEW_MARKET" } }));

    await vi.advanceTimersByTimeAsync(0);

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("removes the pending listener on unmount", async () => {
    resume.mockResolvedValue({ registered: [], retryLater: [], refused: [] });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const view = await mount();
      const listener = add.mock.calls.find(([type]) => type === "percolator:keeper-registration-pending")?.[1];
      expect(listener).toBeDefined();
      view.unmount();
      expect(remove).toHaveBeenCalledWith("percolator:keeper-registration-pending", listener);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
// V22_RETRY_BUDGET_NEGATIVE_CONTROL
describe("V2.2 retry budget protection", () => {
  it("does not restart an exhausted slab on repeated pending notification", async () => {
    persist("A");
    resume.mockResolvedValue({
      registered: [],
      retryLater: ["A"],
      refused: [],
    });

    await mount();
    await vi.advanceTimersByTimeAsync(0);

    // Existing guard allows at most 30 passes.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(resume).toHaveBeenCalledTimes(30);

    // A repeat announcement for the SAME pending slab
    // must not reset its exhausted retry budget.
    window.dispatchEvent(
      new CustomEvent("percolator:keeper-registration-pending", {
        detail: { slab: "A" },
      })
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(resume).toHaveBeenCalledTimes(30);
  });
});
// V22_NEW_SLAB_AFTER_EXHAUSTION
describe("V2.2 new market isolation", () => {
  it("processes new slab B without retrying exhausted slab A", async () => {
    persist("A");
    resume.mockImplementation(
      async (options: { only?: readonly string[] }) => {
        if (options.only?.includes("B")) {
          return {
            registered: ["B"],
            retryLater: [],
            refused: [],
          };
        }

        return {
          registered: [],
          retryLater: ["A"],
          refused: [],
        };
      }
    );

    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(resume).toHaveBeenCalledTimes(30);

    persist("B");
    window.dispatchEvent(
      new CustomEvent("percolator:keeper-registration-pending", {
        detail: { slab: "B" },
      })
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(resume).toHaveBeenCalledTimes(31);

    // The 31st scan is for NEW slab B, not exhausted slab A.
    expect(resume.mock.calls[30][0]).toMatchObject({
      only: ["B"],
    });
  });
});

describe("V2.2 Retry-After with a pending event", () => {
  it("does not retry an active slab early when its pending event repeats", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [], retryAfterMs: 300_000 });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "A" } }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(resume).toHaveBeenCalledTimes(2);
  });
});

describe("per-slab retry isolation", () => {
  it("gives B a fresh budget when it arrives on A's 29th attempt", async () => {
    persist("A");
    resume.mockImplementation(async (options: { only?: readonly string[] }) => ({
      registered: [],
      retryLater: options.only?.includes("B") ? ["B"] : ["A"],
      refused: [],
    }));
    await mount();
    await vi.advanceTimersByTimeAsync(28 * 60_000);
    expect(resume).toHaveBeenCalledTimes(29);
    persist("B");
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "B" } }));
    await vi.advanceTimersByTimeAsync(60_000);
    const bAttempts = () => resume.mock.calls.filter(([d]) => d.only?.includes("B")).length;
    expect(bAttempts()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(bAttempts()).toBe(30);
  });

  it("does not let A's Retry-After delay a new B", async () => {
    persist("A");
    resume.mockImplementation(async (options: { only?: readonly string[] }) => ({
      registered: [],
      retryLater: options.only?.includes("B") ? ["B"] : ["A"],
      refused: [],
      retryAfterMs: options.only?.includes("B") ? undefined : 300_000,
    }));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    persist("B");
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "B" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resume.mock.calls.some(([d]) => d.only?.includes("B"))).toBe(true);
    expect(resume.mock.calls.filter(([d]) => !d.only || d.only.includes("A"))).toHaveLength(1);
  });

  it("keeps A exhausted across an effect unmount and remount", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [] });
    vi.resetModules();
    const { ResumeKeeperRegistrations } = await import("@/components/create/ResumeKeeperRegistrations");
    const first = render(<ResumeKeeperRegistrations />);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resume).toHaveBeenCalledTimes(30);
    first.unmount();
    render(<ResumeKeeperRegistrations />);
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(30);
  });

  it("preserves A's Retry-After across an effect remount", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [], retryAfterMs: 300_000 });
    vi.resetModules();
    const { ResumeKeeperRegistrations } = await import("@/components/create/ResumeKeeperRegistrations");
    const first = render(<ResumeKeeperRegistrations />);
    await vi.advanceTimersByTimeAsync(0);
    first.unmount();
    render(<ResumeKeeperRegistrations />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("coalesces two A events while A is in flight", async () => {
    persist("A");
    let finish!: (value: { registered: string[]; retryLater: string[]; refused: string[] }) => void;
    resume.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ registered: [], retryLater: ["A"], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    const event = () => window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "A" } }));
    event();
    event();
    expect(resume).toHaveBeenCalledTimes(1);
    finish({ registered: [], retryLater: ["A"], refused: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct slabs on their own Retry-After schedules", async () => {
    persist("A", "B");
    resume.mockImplementation(async ({ only }: { only: string[] }) => ({
      registered: [], retryLater: only, refused: [], retryAfterMs: only[0] === "A" ? 300_000 : 60_000,
    }));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(resume.mock.calls.map(([d]) => d.only)).toEqual([["A"], ["B"]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resume.mock.calls.filter(([d]) => d.only[0] === "A")).toHaveLength(1);
    expect(resume.mock.calls.filter(([d]) => d.only[0] === "B")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(resume.mock.calls.filter(([d]) => d.only[0] === "A")).toHaveLength(2);
  });

  it("ignores malformed and duplicate events after A is exhausted", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: ["A"], refused: [] });
    await mount();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    window.dispatchEvent(new Event("percolator:keeper-registration-pending"));
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: 42 } }));
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "A" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(30);
  });

  it("stops its polling timer if an in-flight request never settles past the time limit", async () => {
    persist("A");
    resume.mockImplementation(() => new Promise(() => undefined));
    await mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying a terminal refusal, including after a duplicate event", async () => {
    persist("A");
    resume.mockResolvedValue({ registered: [], retryLater: [], refused: ["A"] });
    await mount();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    window.dispatchEvent(new CustomEvent("percolator:keeper-registration-pending", { detail: { slab: "A" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
