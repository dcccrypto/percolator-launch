// @vitest-environment node
/**
 * UX WP-7 AC2: the price-feed registration retries by itself, with no user action and no prompt:
 * with the endpoint answering 503 twice then 200, the status goes "Connecting the live price…" ->
 * "Live price connected." Backoff 5, 10, 20, 40, 60, 60 s, then every 2 min; "slow" copy after 5 min;
 * a final refusal (403) stops the loop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  KEEPER_REGISTER_BACKOFF_MS,
  KEEPER_REGISTER_COPY,
  KEEPER_REGISTER_MAX_SERVER_RETRIES,
  KEEPER_REGISTER_STEADY_MS,
  USER_FACING_REGISTRATION_REASONS,
  userFacingRegistrationReason,
  isFinalRegistrationRefusal,
  PERMANENT_PROOF_REFUSALS,
  KEEPER_NO_PROOF_STATE,
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
    const refused = vi.fn().mockResolvedValue(res(403, { error: "Registration proof refused: the memo's signer is not this market's creator" }));
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
    expect(a).toEqual({ registered: false, retryable: false, transient: false, message: "This market is already registered with a different price source.", status: 422 });
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

  it("#3637 B1: an unlisted 4xx is NOT final: retried, then a non-final failure that keeps Retry (never 'never')", async () => {
    for (const [status, error] of [[400, "Slab account does not exist on-chain"], [400, "Invalid dexType"], [403, "Registration proof refused: no matching registration memo signed in the proof transaction"]] as const) {
      const f = vi.fn().mockResolvedValue(res(status, { error }));
      const seen: Array<{ phase: string; message: string; final?: boolean }> = [];
      await runKeeperRegistration({ attempt: () => postKeeperRegistration(REQ, f as unknown as typeof fetch), onStatus: (s) => seen.push(s), sleep: async () => undefined });
      expect(f).toHaveBeenCalledTimes(KEEPER_REGISTER_MAX_SERVER_RETRIES + 1);
      expect(seen.every((s) => !s.final)).toBe(true);
      const last = seen[seen.length - 1];
      expect(last.phase).toBe("failed");
      expect(last.message).toBe(KEEPER_REGISTER_COPY.generic);
      expect(last.message).not.toMatch(/won't change that|will not show a price/i);
    }
  });

  it("#3637 B1: a one-slot RPC lag ('Slab account does not exist') that clears is registered, not given up on", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(400, { error: "Slab account does not exist on-chain" })).mockResolvedValue(res(200, { registered: true }));
    const phase = await runKeeperRegistration({ attempt: () => postKeeperRegistration(REQ, f as unknown as typeof fetch), onStatus: () => undefined, sleep: async () => undefined });
    expect(phase).toBe("ready");
  });

  it("#3637 B1: the allowlist is exactly the permanent refusals", () => {
    const f = (status: number, message: string, code?: string) => isFinalRegistrationRefusal({ status, message, code });
    expect(f(403, "Market is not ready for the live price: oracle-not-keeper", "oracle-not-keeper")).toBe(true);
    expect(f(403, "x", "per-creator-cap")).toBe(true);
    expect(f(422, "This market is already registered with a different price source.")).toBe(true);
    expect(f(403, "This market's live price was turned off by a maintainer.")).toBe(true);
    for (const r of PERMANENT_PROOF_REFUSALS) expect(f(403, `Registration proof refused: ${r}`)).toBe(true);
    expect(f(403, "Registration proof refused: no matching registration memo signed in the proof transaction")).toBe(false);
    expect(f(409, "Registration proof refused: proof transaction not found")).toBe(false);
    expect(f(400, "Slab account does not exist on-chain")).toBe(false);
    expect(f(400, "Slab account is not a market of this deployment's program")).toBe(false);
    expect(f(503, "x")).toBe(false);
  });

  it("the proof-refusal texts match lib/keeper-register-memo.ts", () => {
    const src = readFileSync(join(__dirname, "../../lib/keeper-register-memo.ts"), "utf8");
    for (const r of PERMANENT_PROOF_REFUSALS) expect(src).toContain(r);
    expect(src).toContain("no matching registration memo signed in the proof transaction");
  });

  it("the final refusal line never says 'try again in a moment'", () => {
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

  it("#3637: an attempt in flight when the loop is aborted (a manual retry ended it) never overwrites the status", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    type Attempt = Awaited<ReturnType<typeof postKeeperRegistration>>;
    let release: (v: Attempt) => void = () => undefined;
    const blip = new Promise<Attempt>((r) => { release = r; });
    const p = runKeeperRegistration({ attempt: () => blip, signal: ac.signal, onStatus: (s) => seen.push(s.phase), sleep: async () => undefined });
    ac.abort();
    release({ registered: false, retryable: true, message: "Failed to fetch" });
    await p;
    expect(seen).toEqual([]);
  });

  it("#3637: no creation tx on this device is a final failure state", () => {
    expect(KEEPER_NO_PROOF_STATE).toMatchObject({ keeperPhase: "failed", keeperFinal: true, keeperMessage: KEEPER_REGISTER_COPY.noProof });
  });
});

describe("#3637: markRegistrationRefused records a live final refusal", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { m, s: { get length() { return m.size; }, key: () => null, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
  };
  it("writes the marker the resume pass writes, and never downgrades a registered market", async () => {
    const { markRegistrationRefused, isRegistrationRefused } = await import("@/lib/keeper-register-client");
    const a = store();
    markRegistrationRefused("S", a.s);
    expect(isRegistrationRefused("S", a.s)).toBe(true);
    const b = store();
    b.m.set("perc.keeperRegistered.S", "1");
    markRegistrationRefused("S", b.s);
    expect(b.m.get("perc.keeperRegistered.S")).toBe("1");
  });
});

describe("#3637: isRegistrationRefused reads the resume pass's final marker", () => {
  const mem = (v: string | null) => ({ length: 0, key: () => null, getItem: () => v, setItem: () => undefined });
  it("only 'refused' counts (registered '1' and absent do not)", async () => {
    const { isRegistrationRefused } = await import("@/lib/keeper-register-client");
    expect(isRegistrationRefused("S", mem("refused"))).toBe(true);
    expect(isRegistrationRefused("S", mem("1"))).toBe(false);
    expect(isRegistrationRefused("S", mem(null))).toBe(false);
  });
});

// ── Coverage: transport edge cases, loop pacing, local persistence, resume pass ─────────────────
import {
  KEEPER_REGISTER_NOT_YET_BACKOFF_MS,
  PER_CREATOR_LIMIT_ROW_COPY,
  isPerCreatorCapRefusal,
  loadProofTx,
  saveProofTx,
  saveProofPayload,
  saveRegisterRequest,
  loadRegisterRequest,
  markRegistered,
  announceMarketRegistered,
  markRegistrationRefused,
  registrationCandidates,
  pendingRegistrationSlabs,
  resumePendingRegistrations,
  MARKET_REGISTERED_EVENT,
  type KeyStore,
  type KeeperRegisterAttempt,
  type KeeperRegisterRequest,
} from "@/lib/keeper-register-client";
import { PER_CREATOR_CAP_COPY } from "@/lib/keeper-enrollment-guard";
import type { MarketRegistrationPayload } from "@/lib/market-registration-auth";

const SIG = REQ.proofTx;
const memStore = (): KeyStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};
const withHeaders = (status: number, body: unknown, headers: Record<string, string>) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k: string) => headers[k] ?? null } }) as unknown as Response;

describe("postKeeperRegistration: what the caller sees on transport failures", () => {
  it("rejects a non-signature proofTx without calling fetch", async () => {
    const f = vi.fn();
    const a = await postKeeperRegistration({ ...REQ, proofTx: "nope" }, f as unknown as typeof fetch);
    expect(a).toMatchObject({ registered: false, retryable: false, status: 400 });
    expect(f).not.toHaveBeenCalled();
  });

  it("malformed JSON on a 500 falls back to 'HTTP 500' and stays transient + retryable", async () => {
    const bad = { ok: false, status: 500, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response;
    const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(bad) as unknown as typeof fetch);
    expect(a).toEqual({ registered: false, retryable: true, transient: true, message: "HTTP 500", status: 500 });
  });

  it("malformed JSON on a 200 is not 'registered'", async () => {
    const bad = { ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } } as unknown as Response;
    const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(bad) as unknown as typeof fetch);
    expect(a.registered).toBe(false);
    expect(a.message).toBe("HTTP 200");
  });

  it("a 200 without registered:true is not success", async () => {
    const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(200, { registered: false })) as unknown as typeof fetch);
    expect(a.registered).toBe(false);
  });

  it("uses body.message when there is no body.error, and passes code through", async () => {
    const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(403, { message: "nope", code: "per-creator-cap" })) as unknown as typeof fetch);
    expect(a).toMatchObject({ message: "nope", code: "per-creator-cap", retryable: false, transient: false });
  });

  it("ignores a non-string code", async () => {
    const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(400, { error: "e", code: 5 })) as unknown as typeof fetch);
    expect(a.code).toBeUndefined();
  });

  it("a timeout (fetch rejects with an AbortError) is a transient retryable attempt with no status", async () => {
    const err = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const a = await postKeeperRegistration(REQ, vi.fn().mockRejectedValue(err) as unknown as typeof fetch);
    expect(a).toEqual({ registered: false, retryable: true, transient: true, message: "The operation was aborted due to timeout" });
  });

  it("a non-Error rejection is stringified", async () => {
    const a = await postKeeperRegistration(REQ, vi.fn().mockRejectedValue("boom") as unknown as typeof fetch);
    expect(a.message).toBe("boom");
  });

  it("401 and 429 are transient; 400 is not", async () => {
    for (const [s, t] of [[401, true], [429, true], [400, false]] as const) {
      const a = await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(res(s, { error: "x" })) as unknown as typeof fetch);
      expect(a.transient).toBe(t);
      expect(a.retryable).toBe(true);
    }
  });

  it("Retry-After seconds become ms, capped at one hour; junk and zero are ignored", async () => {
    const run = async (v: string) => (await postKeeperRegistration(REQ, vi.fn().mockResolvedValue(withHeaders(429, { error: "full" }, { "Retry-After": v })) as unknown as typeof fetch)).retryAfterMs;
    expect(await run("300")).toBe(300_000);
    expect(await run("999999")).toBe(3_600_000);
    expect(await run("abc")).toBeUndefined();
    expect(await run("0")).toBeUndefined();
  });

  it("concurrent posts for one slab share a single request; the next one after it settles is new", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { registered: true }));
    const req = { ...REQ, slabAddress: "DEDUPE" };
    const [a, b] = [postKeeperRegistration(req, f as unknown as typeof fetch), postKeeperRegistration(req, f as unknown as typeof fetch)];
    expect(a).toBe(b);
    await a;
    await Promise.resolve();
    await postKeeperRegistration(req, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sends nulls for omitted optional fields", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { registered: true }));
    await postKeeperRegistration({ ...REQ, slabAddress: "NULLS" }, f as unknown as typeof fetch);
    const body = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ mainnetCA: null, dexType: null, symbol: null, payload: null });
  });
});

describe("runKeeperRegistration: pacing", () => {
  const attemptOf = (rs: Partial<KeeperRegisterAttempt>[]) => {
    let i = 0;
    return async (): Promise<KeeperRegisterAttempt> => ({ registered: false, retryable: true, message: "x", ...rs[Math.min(i++, rs.length - 1)] });
  };

  it("409s use the short not-yet ladder, then the ordinary schedule", async () => {
    const waits: number[] = [];
    let n = 0;
    await runKeeperRegistration({
      attempt: async () => ({ registered: ++n > KEEPER_REGISTER_NOT_YET_BACKOFF_MS.length + 1, retryable: true, transient: true, status: 409, message: "nf" }),
      onStatus: () => undefined,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits.slice(0, KEEPER_REGISTER_NOT_YET_BACKOFF_MS.length)).toEqual([...KEEPER_REGISTER_NOT_YET_BACKOFF_MS]);
    expect(waits[waits.length - 1]).toBe(KEEPER_REGISTER_STEADY_MS); // ladder spent: ordinary schedule by attempt index (9 > 6 steps)
  });

  it("Retry-After longer than the schedule wins", async () => {
    const waits: number[] = [];
    await runKeeperRegistration({
      attempt: attemptOf([{ status: 429, transient: true, retryAfterMs: 300_000 }, { registered: true }]),
      onStatus: () => undefined,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([300_000]);
  });

  it("a non-5xx 4xx that is not final surfaces the generic creator line after the cap, without final", async () => {
    const seen: Array<{ message: string; final?: boolean; phase: string }> = [];
    await runKeeperRegistration({
      attempt: attemptOf([{ status: 400, message: "Invalid dexType" }]),
      onStatus: (s) => seen.push(s),
      sleep: async () => undefined,
      maxServerRetries: 1,
    });
    expect(seen.length).toBe(2);
    expect(seen[1]).toMatchObject({ phase: "failed", message: KEEPER_REGISTER_COPY.generic });
    expect(seen[1].final).toBeUndefined();
  });

  it("a network error (no status) never counts toward the server cap", async () => {
    let n = 0;
    const phase = await runKeeperRegistration({
      attempt: async () => (++n > 8 ? { registered: true, retryable: false, message: "ok" } : { registered: false, retryable: true, transient: true, message: "offline" }),
      onStatus: () => undefined,
      sleep: async () => undefined,
    });
    expect(phase).toBe("ready");
    expect(n).toBe(9);
  });

  it("already-aborted signal returns the initial phase without attempting", async () => {
    const ac = new AbortController();
    ac.abort();
    const attempt = vi.fn();
    expect(await runKeeperRegistration({ attempt, onStatus: () => undefined, signal: ac.signal })).toBe("connecting");
    expect(attempt).not.toHaveBeenCalled();
  });

  it("final refusal carries the code only when present", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await runKeeperRegistration({
      attempt: attemptOf([{ retryable: false, message: PER_CREATOR_CAP_COPY, code: "per-creator-cap" }]),
      onStatus: (s) => seen.push(s),
      sleep: async () => undefined,
    });
    expect(seen[0]).toMatchObject({ phase: "failed", final: true, code: "per-creator-cap", message: PER_CREATOR_CAP_COPY });
    const seen2: Array<Record<string, unknown>> = [];
    await runKeeperRegistration({ attempt: attemptOf([{ retryable: false, message: "z" }]), onStatus: (s) => seen2.push(s), sleep: async () => undefined });
    expect(seen2[0]).not.toHaveProperty("code");
    expect(seen2[0].message).toBe(KEEPER_REGISTER_COPY.refused);
  });

  it("default sleep really waits and is cut short by abort", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const done = runKeeperRegistration({
        attempt: async () => ({ registered: ++n > 1, retryable: true, message: "x" }),
        onStatus: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(n).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(await done).toBe("ready");

      const ac = new AbortController();
      const p = runKeeperRegistration({ attempt: async () => ({ registered: false, retryable: true, message: "x" }), onStatus: () => undefined, signal: ac.signal });
      await vi.advanceTimersByTimeAsync(10);
      ac.abort();
      expect(await p).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("copy helpers", () => {
  it("isPerCreatorCapRefusal reads the code or the exact copy", () => {
    expect(isPerCreatorCapRefusal({ code: "per-creator-cap" })).toBe(true);
    expect(isPerCreatorCapRefusal({ message: `  ${PER_CREATOR_CAP_COPY} ` })).toBe(true);
    expect(isPerCreatorCapRefusal({})).toBe(false);
    expect(PER_CREATOR_LIMIT_ROW_COPY).toMatch(/limit/);
  });
  it("a listed user-facing reason is shown verbatim", () => {
    expect(userFacingRegistrationReason(` ${KEEPER_REGISTER_COPY.serverTrouble} `)).toBe(KEEPER_REGISTER_COPY.serverTrouble);
    expect(userFacingRegistrationReason(null)).toBe(KEEPER_REGISTER_COPY.generic);
  });
});

describe("local persistence + events", () => {
  const stubWindow = (store: KeyStore, events: Array<{ type: string; detail: unknown }> = []) =>
    vi.stubGlobal("window", {
      localStorage: store,
      dispatchEvent: (e: CustomEvent) => { events.push({ type: e.type, detail: e.detail }); return true; },
    });
  const PAYLOAD = { dex_pool_address: "POOL", mainnet_ca: "CA", symbol: "ABC" } as unknown as MarketRegistrationPayload;

  it("saveProofTx / loadProofTx round-trip, and swallow storage errors", () => {
    const s = memStore();
    stubWindow(s);
    try {
      saveProofTx("S1", SIG);
      expect(loadProofTx("S1")).toBe(SIG);
      expect(loadProofTx("S2")).toBeNull();
      const boom = { ...s, getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
      vi.stubGlobal("window", { localStorage: boom });
      expect(() => saveProofTx("S1", SIG)).not.toThrow();
      expect(loadProofTx("S1")).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it("announces a pending registration once proof, payload and request are all saved; not once registered", () => {
    const s = memStore();
    const events: Array<{ type: string; detail: unknown }> = [];
    stubWindow(s, events);
    try {
      saveProofTx("SL", SIG);
      saveRegisterRequest({ slabAddress: "SL", dexPoolAddress: "POOL", dexType: "pumpswap" }, s);
      expect(events).toEqual([]);
      saveProofPayload("SL", PAYLOAD, s);
      expect(events).toEqual([{ type: "percolator:keeper-registration-pending", detail: { slab: "SL" } }]);
      markRegistered("SL", s);
      saveProofPayload("SL", PAYLOAD, s);
      expect(events.filter((e) => e.type === "percolator:keeper-registration-pending")).toHaveLength(1);
      expect(events[events.length - 1]).toEqual({ type: MARKET_REGISTERED_EVENT, detail: { slab: "SL" } });
    } finally { vi.unstubAllGlobals(); }
  });

  it("storage that throws never breaks the save / announce / mark calls", () => {
    const boom: KeyStore = { length: 0, key: () => null, getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(() => saveProofPayload("S", PAYLOAD, boom)).not.toThrow();
    expect(() => saveRegisterRequest({ slabAddress: "S", dexPoolAddress: "P" }, boom)).not.toThrow();
    expect(() => markRegistered("S", boom)).not.toThrow();
    expect(() => markRegistrationRefused("S", boom)).not.toThrow();
  });

  it("with no store (no window) the default-store helpers are no-ops", () => {
    expect(() => saveRegisterRequest({ slabAddress: "S", dexPoolAddress: "P" })).not.toThrow();
    expect(loadRegisterRequest("S")).toBeNull();
    expect(() => announceMarketRegistered("S")).not.toThrow();
    expect(() => markRegistered("S")).not.toThrow();
  });

  it("announceMarketRegistered swallows a throwing dispatch", () => {
    vi.stubGlobal("window", { dispatchEvent: () => { throw new Error("no"); } });
    try { expect(() => announceMarketRegistered("S")).not.toThrow(); } finally { vi.unstubAllGlobals(); }
  });

  it("loadRegisterRequest rejects garbage, arrays and a request for another slab", () => {
    const s = memStore();
    s.m.set("perc.keeperRequest.A", "{bad");
    s.m.set("perc.keeperRequest.B", "[1]");
    s.m.set("perc.keeperRequest.C", JSON.stringify({ slabAddress: "other", dexPoolAddress: "P" }));
    s.m.set("perc.keeperRequest.D", JSON.stringify({ slabAddress: "D", dexPoolAddress: "P" }));
    expect(loadRegisterRequest("A", s)).toBeNull();
    expect(loadRegisterRequest("B", s)).toBeNull();
    expect(loadRegisterRequest("C", s)).toBeNull();
    expect(loadRegisterRequest("D", s)).toMatchObject({ slabAddress: "D" });
  });
});

describe("registrationCandidates / pendingRegistrationSlabs", () => {
  const PAYLOAD = { dex_pool_address: "POOL", mainnet_ca: "CA", symbol: "ABC" };
  const seed = (s: ReturnType<typeof memStore>, slab: string, extra: Record<string, string> = {}) => {
    s.m.set(`perc.keeperProofTx.${slab}`, SIG);
    for (const [k, v] of Object.entries(extra)) s.m.set(k, v);
  };

  it("no valid proof -> none", () => {
    const s = memStore();
    s.m.set("perc.keeperProofTx.S", "short");
    expect(registrationCandidates("S", s)).toEqual([]);
  });

  it("corrupt or non-object payload -> none", () => {
    for (const raw of ["{bad", "[1]", "null", "7"]) {
      const s = memStore();
      seed(s, "S", { "perc.keeperPayload.S": raw });
      expect(registrationCandidates("S", s)).toEqual([]);
    }
  });

  it("a saved request yields exactly one candidate with proof and payload attached", () => {
    const s = memStore();
    seed(s, "S", {
      "perc.keeperPayload.S": JSON.stringify(PAYLOAD),
      "perc.keeperRequest.S": JSON.stringify({ slabAddress: "S", dexPoolAddress: "POOL", dexType: "pumpswap", payloadRequired: true }),
    });
    const c = registrationCandidates("S", s);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ slabAddress: "S", dexType: "pumpswap", proofTx: SIG, payload: PAYLOAD });
    expect(c[0]).not.toHaveProperty("payloadRequired");
  });

  it("payloadRequired without a saved payload -> none; without the flag the request still goes", () => {
    const s = memStore();
    seed(s, "S", { "perc.keeperRequest.S": JSON.stringify({ slabAddress: "S", dexPoolAddress: "POOL", payloadRequired: true }) });
    expect(registrationCandidates("S", s)).toEqual([]);
    const t = memStore();
    seed(t, "S", { "perc.keeperRequest.S": JSON.stringify({ slabAddress: "S", dexPoolAddress: "POOL" }) });
    expect(registrationCandidates("S", t)).toMatchObject([{ slabAddress: "S", payload: null }]);
  });

  it("a corrupt or mismatched saved request falls back to payload-derived candidates over every dex type", () => {
    for (const raw of ["{bad", JSON.stringify({ slabAddress: "other", dexPoolAddress: "POOL" }), JSON.stringify({ slabAddress: "S", dexPoolAddress: 5 })]) {
      const s = memStore();
      seed(s, "S", { "perc.keeperPayload.S": JSON.stringify(PAYLOAD), "perc.keeperRequest.S": raw });
      const c = registrationCandidates("S", s);
      expect(c.map((r) => r.dexType)).toEqual(["raydium-clmm", "meteora-dlmm", "pumpswap", null]);
      expect(c[0]).toMatchObject({ dexPoolAddress: "POOL", mainnetCA: "CA", symbol: "ABC" });
    }
  });

  it("payload without a pool, or no payload and no request -> none; UNKNOWN symbol and missing CA become null", () => {
    const a = memStore();
    seed(a, "S", { "perc.keeperPayload.S": JSON.stringify({ symbol: "X" }) });
    expect(registrationCandidates("S", a)).toEqual([]);
    const b = memStore();
    seed(b, "S");
    expect(registrationCandidates("S", b)).toEqual([]);
    const c = memStore();
    seed(c, "S", { "perc.keeperPayload.S": JSON.stringify({ dex_pool_address: "P", symbol: "UNKNOWN" }) });
    expect(registrationCandidates("S", c)[0]).toMatchObject({ symbol: null, mainnetCA: null });
  });

  it("pendingRegistrationSlabs skips registered/refused slabs, non-proof keys and slabs with no candidates", () => {
    const s = memStore();
    s.m.set("unrelated", "x");
    seed(s, "OPEN", { "perc.keeperPayload.OPEN": JSON.stringify(PAYLOAD) });
    seed(s, "DONE", { "perc.keeperPayload.DONE": JSON.stringify(PAYLOAD), "perc.keeperRegistered.DONE": "1" });
    seed(s, "REF", { "perc.keeperPayload.REF": JSON.stringify(PAYLOAD), "perc.keeperRegistered.REF": "refused" });
    seed(s, "EMPTY");
    expect(pendingRegistrationSlabs(s)).toEqual(["OPEN"]);
  });
});

describe("resumePendingRegistrations", () => {
  const PAYLOAD = JSON.stringify({ dex_pool_address: "POOL", mainnet_ca: "CA", symbol: "ABC" });
  const seedSlab = (s: ReturnType<typeof memStore>, slab: string, withRequest = false) => {
    s.m.set(`perc.keeperProofTx.${slab}`, SIG);
    s.m.set(`perc.keeperPayload.${slab}`, PAYLOAD);
    if (withRequest) s.m.set(`perc.keeperRequest.${slab}`, JSON.stringify({ slabAddress: slab, dexPoolAddress: "POOL", dexType: "pumpswap", payloadRequired: true }));
  };
  const att = (o: Partial<KeeperRegisterAttempt>): KeeperRegisterAttempt => ({ registered: false, retryable: true, message: "x", ...o });

  it("registers, marks the slab and saves the winning request for next time", async () => {
    const s = memStore();
    seedSlab(s, "A");
    const post = vi.fn(async (req: KeeperRegisterRequest) => att(req.dexType === "meteora-dlmm" ? { registered: true, retryable: false } : { transient: false, status: 400 }));
    const r = await resumePendingRegistrations({ store: s, post });
    expect(r).toEqual({ registered: ["A"], retryLater: [], refused: [] });
    expect(post.mock.calls.map((c) => c[0].dexType)).toEqual(["raydium-clmm", "meteora-dlmm"]);
    expect(s.m.get("perc.keeperRegistered.A")).toBe("1");
    expect(loadRegisterRequest("A", s)).toMatchObject({ dexType: "meteora-dlmm", dexPoolAddress: "POOL" });
  });

  it("a final refusal marks the slab refused and stops trying more candidates", async () => {
    const s = memStore();
    seedSlab(s, "A");
    const post = vi.fn(async () => att({ retryable: false, status: 403 }));
    const r = await resumePendingRegistrations({ store: s, post });
    expect(r.refused).toEqual(["A"]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(s.m.get("perc.keeperRegistered.A")).toBe("refused");
  });

  it("transport trouble stops at the first candidate, leaves the slab for later and reports the longest Retry-After", async () => {
    const s = memStore();
    seedSlab(s, "A");
    seedSlab(s, "B");
    const post = vi.fn(async (req: KeeperRegisterRequest) => att({ transient: true, status: 429, retryAfterMs: req.slabAddress === "A" ? 60_000 : 300_000 }));
    const r = await resumePendingRegistrations({ store: s, post });
    expect(r).toEqual({ registered: [], retryLater: ["A", "B"], refused: [], retryAfterMs: 300_000 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(s.m.has("perc.keeperRegistered.A")).toBe(false);
  });

  it("when every dexType candidate is merely 'not this request', the slab is retried later (not refused)", async () => {
    const s = memStore();
    seedSlab(s, "A");
    const post = vi.fn(async () => att({ transient: false, status: 400 }));
    const r = await resumePendingRegistrations({ store: s, post });
    expect(r.retryLater).toEqual(["A"]);
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("`only` restricts the pass; a storage failure while recording a refusal is swallowed", async () => {
    const s = memStore();
    seedSlab(s, "A");
    seedSlab(s, "B");
    const post = vi.fn(async () => att({ retryable: false }));
    const failing: KeyStore = { length: s.length, key: s.key, getItem: s.getItem, setItem: () => { throw new Error("full"); } };
    const r = await resumePendingRegistrations({ store: failing, post, only: ["B"] });
    expect(r.refused).toEqual(["B"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("the default poster goes through fetch with the saved request", async () => {
    const s = memStore();
    seedSlab(s, "DEFPOST", true);
    const f = vi.fn().mockResolvedValue(res(200, { registered: true }));
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("window", { dispatchEvent: () => true });
    try {
      const r = await resumePendingRegistrations({ store: s });
      expect(r.registered).toEqual(["DEFPOST"]);
      const body = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body));
      expect(body).toMatchObject({ slabAddress: "DEFPOST", dexType: "pumpswap", proofTx: SIG });
    } finally { vi.unstubAllGlobals(); }
  });
});
