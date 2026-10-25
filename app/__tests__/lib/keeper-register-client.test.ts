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
  USER_FACING_REGISTRATION_REASONS,
  userFacingRegistrationReason,
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

describe("#3637: a final refusal is surfaced with its reason, never swallowed", () => {
  const notKeeper = () => res(403, { error: "Market is not ready for the live price: oracle-not-keeper", code: "oracle-not-keeper" });

  it("final 403 oracle-not-keeper -> failed status carrying final, the code and creator copy", async () => {
    const f = vi.fn().mockResolvedValue(notKeeper());
    const seen: Array<{ phase: string; message: string; final?: boolean; code?: string }> = [];
    const phase = await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, f as unknown as typeof fetch),
      onStatus: (s) => seen.push(s),
      sleep: async () => undefined,
    });
    expect(phase).toBe("failed");
    expect(f).toHaveBeenCalledTimes(1);
    const last = seen[seen.length - 1];
    expect(last.phase).toBe("failed");
    expect(last.final).toBe(true);
    expect(last.code).toBe("oracle-not-keeper");
    expect(last.message).toBe(KEEPER_REGISTER_COPY.oracleNotKeeper);
    expect(last.message).not.toMatch(/oracle-not-keeper|connecting|try again in a moment/i);
    expect(USER_FACING_REGISTRATION_REASONS).toContain(KEEPER_REGISTER_COPY.oracleNotKeeper);
  });

  it("any other non-retryable refusal is final too, with the non-jargon refusal line", async () => {
    const seen: Array<{ message: string; final?: boolean }> = [];
    await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(400, { error: "Invalid dexType" })) as unknown as typeof fetch),
      onStatus: (s) => seen.push(s),
      sleep: async () => undefined,
    });
    expect(seen[seen.length - 1]).toMatchObject({ final: true, message: KEEPER_REGISTER_COPY.refused });
    expect(KEEPER_REGISTER_COPY.refused).not.toMatch(/try again in a moment/i);
  });

  it("a 5xx keeps retrying: not final until the retry cap, then the retryable server-trouble line", async () => {
    const seen: Array<{ phase: string; message: string; final?: boolean }> = [];
    const f = vi.fn().mockResolvedValue(res(502, { error: "Bad Gateway" }));
    await runKeeperRegistration({
      attempt: () => postKeeperRegistration(REQ, f as unknown as typeof fetch),
      onStatus: (s) => seen.push(s),
      sleep: async () => undefined,
    });
    expect(f).toHaveBeenCalledTimes(KEEPER_REGISTER_MAX_SERVER_RETRIES + 1);
    expect(seen.slice(0, -1).every((s) => s.phase === "connecting" && !s.final)).toBe(true);
    expect(seen[seen.length - 1]).toMatchObject({ phase: "failed", message: KEEPER_REGISTER_COPY.serverTrouble });
    expect(seen[seen.length - 1].final).toBeFalsy();
  });

  it("the slow copy is true: retries only run while the page is open", () => {
    expect(KEEPER_REGISTER_COPY.slow).not.toMatch(/you can close this page/i);
    expect(KEEPER_REGISTER_COPY.slow).toMatch(/keep this page open/i);
    expect(KEEPER_REGISTER_COPY.slow).toMatch(/this browser/i);
  });

  it("no copy promises a refund or recovery of funds", () => {
    for (const c of Object.values(KEEPER_REGISTER_COPY)) expect(c).not.toMatch(/refund|recover|get your .* back|contact the team/i);
  });

  it("a non-allow-listed reason maps to the retry line only while retryable, else the final line", () => {
    expect(userFacingRegistrationReason("boom")).toBe(KEEPER_REGISTER_COPY.generic);
    expect(userFacingRegistrationReason("boom", undefined, false)).toBe(KEEPER_REGISTER_COPY.refused);
    expect(userFacingRegistrationReason("whatever", "oracle-not-keeper")).toBe(KEEPER_REGISTER_COPY.oracleNotKeeper);
  });

  it("a final refusal after retries of 5xx still ends final (a later 403 is not softened)", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(502, {})).mockResolvedValue(res(403, { error: "x", code: "oracle-not-keeper" }));
    const seen: Array<{ phase: string; final?: boolean }> = [];
    await runKeeperRegistration({ attempt: () => postKeeperRegistration(REQ, f as unknown as typeof fetch), onStatus: (s) => seen.push(s), sleep: async () => undefined });
    expect(seen[seen.length - 1]).toMatchObject({ phase: "failed", final: true });
  });
});
