// @vitest-environment node
/**
 * UX WP-7 AC2: the price-feed registration retries by itself, with no user action and no prompt:
 * with the endpoint answering 503 twice then 200, the status goes "Connecting the live price…" ->
 * "Live price connected." Backoff 5, 10, 20, 40, 60, 60 s, then every 2 min; "slow" copy after 5 min;
 * a final refusal (403) stops the loop.
 */
import { describe, expect, it, vi } from "vitest";
import {
  KEEPER_REGISTER_BACKOFF_MS,
  KEEPER_REGISTER_COPY,
  KEEPER_REGISTER_MAX_SERVER_RETRIES,
  KEEPER_REGISTER_STEADY_MS,
  postKeeperRegistration,
  runKeeperRegistration,
} from "@/lib/keeper-register-client";

const REQ = { slabAddress: "S", dexPoolAddress: "P", proofTx: "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY" };
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("AC2: 503, 503, 200 -> connected, no user action", () => {
  it("statuses and the waits between attempts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503, { error: "down" }))
      .mockResolvedValueOnce(res(503, { error: "down" }))
      .mockResolvedValueOnce(res(200, { registered: true }));
    const statuses: string[] = [];
    const waits: number[] = [];
    const phase = await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, fetchImpl as unknown as typeof fetch),
      onStatus: (s) => statuses.push(`${s.phase}:${s.message}`),
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(phase).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([5_000, 10_000]);
    expect(statuses).toEqual([`connecting:${KEEPER_REGISTER_COPY.connecting}`, `connecting:${KEEPER_REGISTER_COPY.connecting}`, `ready:${KEEPER_REGISTER_COPY.ready}`]);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.proofTx).toBe(REQ.proofTx);
    expect(body.signature).toBeUndefined();
  });

  it("the schedule: 5, 10, 20, 40, 60, 60 s, then every 2 min; 'slow' after 5 minutes", async () => {
    let t = 0;
    const waits: number[] = [];
    const phases: string[] = [];
    let n = 0;
    await runKeeperRegistration({
      attempt: async () => ({ registered: ++n > 9, retryable: true, message: "x" }),
      onStatus: (s) => phases.push(s.phase),
      sleep: async (ms) => { waits.push(ms); t += ms; },
      now: () => t,
    });
    expect(waits).toEqual([...KEEPER_REGISTER_BACKOFF_MS, KEEPER_REGISTER_STEADY_MS, KEEPER_REGISTER_STEADY_MS, KEEPER_REGISTER_STEADY_MS]);
    expect(phases.slice(0, 6).every((p) => p === "connecting")).toBe(true);
    expect(phases).toContain("slow");
    expect(phases[phases.length - 1]).toBe("ready");
  });

  it("CONTROL: a final refusal (403) stops the loop; a 409 (not landed yet) keeps it going", async () => {
    const refused = vi.fn().mockResolvedValue(res(403, { error: "Registration proof refused: x" }));
    const phase = await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, refused as unknown as typeof fetch),
      onStatus: () => undefined,
      sleep: async () => undefined,
    });
    expect(phase).toBe("failed");
    expect(refused).toHaveBeenCalledTimes(1);
    expect((await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(409, { error: "not found" })) as unknown as typeof fetch)).retryable).toBe(true);
    expect((await postKeeperRegistration(REQ, vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch)).retryable).toBe(true);
  });

  it("abort stops it (the page closed / a new launch)", async () => {
    const ac = new AbortController();
    const attempt = vi.fn(async () => ({ registered: false, retryable: true, message: "x" }));
    const p = runKeeperRegistration({ attempt, onStatus: () => ac.abort(), sleep: async () => undefined, signal: ac.signal });
    await p;
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("memo v2: the bound payload survives a reload (security review 2026-09-30 M-1)", () => {
  it("saveProofPayload / loadProofPayload round-trip; garbage reads as none", async () => {
    const { saveProofPayload, loadProofPayload } = await import("@/lib/keeper-register-client");
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    try {
      const payload = { name: "Test Token", max_leverage: 6.666666666666667, trading_fee_bps: 30, initial_price_e6: "1000000" };
      saveProofPayload("SLAB", payload);
      expect(loadProofPayload("SLAB")).toEqual(payload);
      expect(loadProofPayload("OTHER")).toBeNull();
      store.set("perc.keeperPayload.BAD", "{not json");
      expect(loadProofPayload("BAD")).toBeNull();
      store.set("perc.keeperPayload.ARR", "[1,2]");
      expect(loadProofPayload("ARR")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("re-review I-R2: 'locked to another price source' is final", () => {
  it("422 -> not retryable, the reason is the message", async () => {
    const f = vi.fn(async () => res(422, { error: "This market is already registered with a different price source." }));
    const a = await postKeeperRegistration(REQ, f as unknown as typeof fetch);
    expect(a).toEqual({ registered: false, retryable: false, message: "This market is already registered with a different price source.", status: 422 });
  });
});

describe("5xx is retried a bounded number of times, then 'failed' with calm copy", () => {
  it("502 x4 -> failed after 3 retries (5, 10, 20 s); a 409 in between resets the count", async () => {
    const r502 = () => res(502, { error: "Bad Gateway" });
    const waits: number[] = [];
    const statuses: string[] = [];
    // Hard cap: a loop that never gives up on 5xx ends on a 403 here instead of spinning forever.
    const f = vi.fn(async () => (f.mock.calls.length > 10 ? res(403, { error: "cap reached" }) : r502()));
    const phase = await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, f as unknown as typeof fetch),
      onStatus: (s) => statuses.push(`${s.phase}:${s.message}`),
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(phase).toBe("failed");
    expect(KEEPER_REGISTER_MAX_SERVER_RETRIES).toBe(3);
    expect(f).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([5_000, 10_000, 20_000]);
    expect(statuses[statuses.length - 1]).toBe(`failed:${KEEPER_REGISTER_COPY.serverTrouble}`);

    const mixed = vi
      .fn()
      .mockResolvedValueOnce(r502())
      .mockResolvedValueOnce(r502())
      .mockResolvedValueOnce(res(409, { error: "not landed" }))
      .mockResolvedValueOnce(r502())
      .mockResolvedValueOnce(r502())
      .mockResolvedValueOnce(res(200, { registered: true }));
    const p2 = await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, mixed as unknown as typeof fetch),
      onStatus: () => undefined,
      sleep: async () => undefined,
    });
    expect(p2).toBe("ready");
  });
});
