// @vitest-environment node
/**
 * A registration the launch page did not finish is re-sent on the creator's next visit, from what
 * is already on the device (the creation-tx proof + the memo-bound payload). 2026-10-01: the first
 * relaunch market (9EPm...) got six 500s from the markets write and was never enrolled.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pendingRegistrationSlabs,
  postKeeperRegistration,
  registrationCandidates,
  resumePendingRegistrations,
  saveProofPayload,
  saveRegisterRequest,
  type KeeperRegisterAttempt,
  type KeeperRegisterRequest,
  type KeyStore,
} from "@/lib/keeper-register-client";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const PROOF = "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY";
const PAYLOAD = { slab_address: SLAB, dex_pool_address: "POOL", mainnet_ca: "CA", symbol: "TKN", max_leverage: 5.4 };

function store(init: Record<string, string> = {}): KeyStore & { m: Map<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}
const launched = () => store({ [`perc.keeperProofTx.${SLAB}`]: PROOF, [`perc.keeperPayload.${SLAB}`]: JSON.stringify(PAYLOAD) });
const ok: KeeperRegisterAttempt = { registered: true, retryable: false, message: "ok" };
const memoMismatch: KeeperRegisterAttempt = { registered: false, retryable: false, message: "no matching registration memo" };
const serverDown: KeeperRegisterAttempt = { registered: false, retryable: true, message: "HTTP 500" };

describe("resume a registration the launch page did not finish", () => {
  const request = { slabAddress: SLAB, dexPoolAddress: "POOL", dexType: "pumpswap" as const, payloadRequired: true as const };

  it("waits for a new launch's payload instead of posting or permanently refusing it", async () => {
    const s = store({ [`perc.keeperProofTx.${SLAB}`]: PROOF });
    saveRegisterRequest(request, s);
    const post = vi.fn(async () => memoMismatch);
    expect(pendingRegistrationSlabs(s)).toEqual([]);
    expect(await resumePendingRegistrations({ store: s, post })).toMatchObject({ registered: [], retryLater: [], refused: [] });
    expect(post).not.toHaveBeenCalled();
    expect(s.getItem(`perc.keeperRegistered.${SLAB}`)).toBeNull();
  });

  it("waits through malformed saved payload JSON, then sends the completed record once", async () => {
    const s = store({ [`perc.keeperProofTx.${SLAB}`]: PROOF, [`perc.keeperPayload.${SLAB}`]: "{broken" });
    saveRegisterRequest(request, s);
    const post = vi.fn(async () => ok);
    await resumePendingRegistrations({ store: s, post });
    expect(post).not.toHaveBeenCalled();
    expect(s.getItem(`perc.keeperRegistered.${SLAB}`)).toBeNull();
    s.setItem(`perc.keeperPayload.${SLAB}`, JSON.stringify(PAYLOAD));
    expect(pendingRegistrationSlabs(s)).toEqual([SLAB]);
    expect((await resumePendingRegistrations({ store: s, post })).registered).toEqual([SLAB]);
    await resumePendingRegistrations({ store: s, post });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].payload).toEqual(PAYLOAD);
  });

  it("retains a valid legacy no-payload request and treats an actual server refusal as terminal", async () => {
    const s = store({ [`perc.keeperProofTx.${SLAB}`]: PROOF });
    saveRegisterRequest({ slabAddress: SLAB, dexPoolAddress: "POOL", dexType: "pumpswap" }, s);
    const post = vi.fn(async () => memoMismatch);
    expect(pendingRegistrationSlabs(s)).toEqual([SLAB]);
    expect((await resumePendingRegistrations({ store: s, post })).refused).toEqual([SLAB]);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ payload: null, proofTx: PROOF }));
    await resumePendingRegistrations({ store: s, post });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("wakes a waiting new launch when its payload is saved after proof and request", async () => {
    const s = store({ [`perc.keeperProofTx.${SLAB}`]: PROOF });
    const seen: string[] = [];
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("CustomEvent", class<T> extends Event {
      detail: T;
      constructor(type: string, options: { detail: T }) { super(type); this.detail = options.detail; }
    });
    const onPending = (event: Event) => seen.push((event as CustomEvent<{ slab: string }>).detail.slab);
    window.addEventListener("percolator:keeper-registration-pending", onPending);
    try {
      saveRegisterRequest(request, s);
      expect(seen).toEqual([]);
      saveProofPayload(SLAB, PAYLOAD, s);
      expect(seen).toEqual([SLAB]);
      const post = vi.fn(async () => ok);
      expect((await resumePendingRegistrations({ store: s, post })).registered).toEqual([SLAB]);
      await resumePendingRegistrations({ store: s, post });
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("percolator:keeper-registration-pending", onPending);
      vi.unstubAllGlobals();
    }
  });

  it("never posts when the saved proof is missing or malformed", async () => {
    const missing = store({ [`perc.keeperPayload.${SLAB}`]: JSON.stringify(PAYLOAD) });
    const malformed = store({ [`perc.keeperProofTx.${SLAB}`]: "invalid", [`perc.keeperPayload.${SLAB}`]: JSON.stringify(PAYLOAD) });
    const post = vi.fn(async () => ok);
    await resumePendingRegistrations({ store: missing, post });
    await resumePendingRegistrations({ store: malformed, post });
    expect(post).not.toHaveBeenCalled();
    const fetchImpl = vi.fn();
    const result = await postKeeperRegistration({ slabAddress: SLAB, dexPoolAddress: "POOL", proofTx: "invalid" }, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ registered: false, retryable: false, status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not refuse a proof saved before its payload or request is ready", async () => {
    const s = store({ [`perc.keeperProofTx.${SLAB}`]: PROOF });
    const post = vi.fn(async () => ok);
    expect(pendingRegistrationSlabs(s)).toEqual([]);
    await resumePendingRegistrations({ store: s, post });
    expect(post).not.toHaveBeenCalled();
    expect(s.getItem(`perc.keeperRegistered.${SLAB}`)).toBeNull();
    s.setItem(`perc.keeperPayload.${SLAB}`, JSON.stringify(PAYLOAD));
    expect(pendingRegistrationSlabs(s)).toEqual([SLAB]);
  });

  it("announces a slab only after its proof, payload, and request are stored", () => {
    const s = store({ [`perc.keeperPayload.${SLAB}`]: "{invalid" });
    const seen: string[] = [];
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("CustomEvent", class<T> extends Event {
      detail: T;
      constructor(type: string, options: { detail: T }) {
        super(type);
        this.detail = options.detail;
      }
    });
    const onPending = (event: Event) => seen.push((event as CustomEvent<{ slab: string }>).detail.slab);
    window.addEventListener("percolator:keeper-registration-pending", onPending);
    try {
      saveRegisterRequest({ slabAddress: SLAB, dexPoolAddress: "POOL" }, s);
      expect(seen).toEqual([]);
      s.setItem(`perc.keeperProofTx.${SLAB}`, PROOF);
      saveRegisterRequest({ slabAddress: SLAB, dexPoolAddress: "POOL" }, s);
      expect(seen).toEqual([]);
      s.setItem(`perc.keeperPayload.${SLAB}`, JSON.stringify(PAYLOAD));
      s.setItem(`perc.keeperProofTx.${SLAB}`, "invalid");
      saveRegisterRequest({ slabAddress: SLAB, dexPoolAddress: "POOL" }, s);
      expect(seen).toEqual([]);
      s.setItem(`perc.keeperProofTx.${SLAB}`, PROOF);
      saveRegisterRequest({ slabAddress: SLAB, dexPoolAddress: "POOL" }, s);
      expect(seen).toEqual([SLAB]);
      expect(registrationCandidates(SLAB, s)[0]).toMatchObject({ proofTx: PROOF, payload: PAYLOAD });
    } finally {
      window.removeEventListener("percolator:keeper-registration-pending", onPending);
      vi.unstubAllGlobals();
    }
  });

  it("payload-only launch: tries each keeper dex type; the one the memo bound registers; marked done", async () => {
    const s = launched();
    const post = vi.fn(async (r: KeeperRegisterRequest) => (r.dexType === "meteora-dlmm" ? ok : memoMismatch));
    const res = await resumePendingRegistrations({ store: s, post });
    expect(res.registered).toEqual([SLAB]);
    expect(post.mock.calls.map((c) => c[0].dexType)).toEqual(["raydium-clmm", "meteora-dlmm"]);
    const sent = post.mock.calls[1]![0];
    expect(sent).toMatchObject({ slabAddress: SLAB, dexPoolAddress: "POOL", mainnetCA: "CA", symbol: "TKN", proofTx: PROOF });
    expect(sent.payload).toEqual(PAYLOAD); // the exact bound payload, so the memo digest matches
    // Done: the next visit sends nothing.
    expect(pendingRegistrationSlabs(s)).toEqual([]);
    const again = vi.fn(async () => ok);
    await resumePendingRegistrations({ store: s, post: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("a saved request is sent as is (one candidate)", () => {
    const s = launched();
    saveRegisterRequest({ slabAddress: SLAB, dexPoolAddress: "POOL", mainnetCA: "CA", dexType: "pumpswap", symbol: "TKN" }, s);
    const c = registrationCandidates(SLAB, s);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ dexType: "pumpswap", proofTx: PROOF, payload: PAYLOAD });
  });

  it("server trouble: stops, nothing marked, tried again next visit", async () => {
    const s = launched();
    const post = vi.fn(async () => serverDown);
    const res = await resumePendingRegistrations({ store: s, post });
    expect(res.retryLater).toEqual([SLAB]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(pendingRegistrationSlabs(s)).toEqual([SLAB]);
  });

  it("every candidate refused (final): marked, never re-sent", async () => {
    const s = launched();
    const res = await resumePendingRegistrations({ store: s, post: async () => memoMismatch });
    expect(res.refused).toEqual([SLAB]);
    expect(pendingRegistrationSlabs(s)).toEqual([]);
  });

  it("NEGATIVE CONTROL: no proof on this device -> nothing to resume, nothing sent", async () => {
    const s = store({ [`perc.keeperPayload.${SLAB}`]: JSON.stringify(PAYLOAD) });
    const post = vi.fn(async () => ok);
    expect(pendingRegistrationSlabs(s)).toEqual([]);
    await resumePendingRegistrations({ store: s, post });
    expect(post).not.toHaveBeenCalled();
  });

  it("wiring: the launch loop saves its request and marks success; the app runs the resume once per load", () => {
    const hook = readFileSync(join(__dirname, "..", "..", "hooks", "useCreateMarket.ts"), "utf8");
    expect(hook).toMatch(/saveRegisterRequest\(\{ slabAddress: slab/);
    expect(hook).toMatch(/if \(phase === "ready"\) markRegistered\(slab\)/);
    const providers = readFileSync(join(__dirname, "..", "..", "app", "providers.tsx"), "utf8");
    expect(providers).toContain("<ResumeKeeperRegistrations />");
  });
});
