// @vitest-environment node
/**
 * Edge cases in lib/playground-access.ts: cutoff parsing, expiry boundaries,
 * and that every failure path refuses access (fails closed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cohortCutoff,
  isWithinCohort,
  judgeAccessCode,
  mintSession,
  readHandoff,
  readSession,
  sessionGrantsAccess,
  SESSION_TTL_SECONDS,
} from "@/lib/playground-access";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;
const ENV = { PLAYGROUND_ACCESS_SECRET: SECRET };
const b64u = (s: string) => Buffer.from(s).toString("base64url");

async function signedToken(derivedSuffix: string, body: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const b = b64u(body);
  return `${b}.${createHmac("sha256", `${SECRET}:${derivedSuffix}`).update(b).digest("base64url")}`;
}

afterEach(() => vi.restoreAllMocks());

describe("lead 1: cohortCutoff parsing", () => {
  it("accepts hex/exponent/padded forms as the number they denote", () => {
    expect(cohortCutoff("0x3E8")).toBe(1000);
    expect(cohortCutoff("1e3")).toBe(1000);
    expect(cohortCutoff(" 1000 ")).toBe(1000);
    expect(cohortCutoff("250.9")).toBe(250);
  });
  it("'0.5' floors to 0, which admits nobody (fails closed)", () => {
    expect(cohortCutoff("0.5")).toBe(0);
    expect(isWithinCohort(1, cohortCutoff("0.5"))).toBe(false);
  });
  it("junk falls back to the default", () => {
    for (const v of ["", "0", "-5", "NaN", "Infinity", "abc"]) expect(cohortCutoff(v)).toBe(1000);
  });
});

describe("lead 2: expiry boundaries", () => {
  it("session is valid until its exp second and refused exactly at exp", async () => {
    const tok = await mintSession("u1", 5, SECRET, NOW);
    const expMs = (Math.floor(NOW / 1000) + SESSION_TTL_SECONDS) * 1000;
    expect(await readSession(tok, SECRET, expMs - 1)).not.toBeNull();
    expect(await readSession(tok, SECRET, expMs)).toBeNull();
    expect(await readSession(tok, SECRET, expMs + 1000)).toBeNull();
  });
  it("a token is accepted at exactly its issue time (no iat check)", async () => {
    const tok = await mintSession("u1", 5, SECRET, NOW);
    expect(await readSession(tok, SECRET, NOW)).not.toBeNull();
  });
  it("sessionGrantsAccess honours the same boundary", async () => {
    const tok = await mintSession("u1", 5, SECRET, NOW);
    const expMs = (Math.floor(NOW / 1000) + SESSION_TTL_SECONDS) * 1000;
    expect(await sessionGrantsAccess(tok, ENV, expMs - 1)).toBe(true);
    expect(await sessionGrantsAccess(tok, ENV, expMs)).toBe(false);
  });
  it("a non-finite clock refuses instead of treating the token as unexpired", async () => {
    const tok = await mintSession("u1", 5, SECRET, NOW);
    expect(await readSession(tok, SECRET, NaN)).toBeNull();
    expect(await sessionGrantsAccess(tok, ENV, NaN)).toBe(false);
  });
  it("a non-finite clock closes the judge door", () => {
    const env = {
      PLAYGROUND_JUDGE_ACCESS_CODE: "j".repeat(30),
      PLAYGROUND_JUDGE_ACCESS_UNTIL: "2026-12-31T23:59:59Z",
    };
    expect(judgeAccessCode(env, NaN)).toBeNull();
  });
});

describe("lead 3: failure paths fail closed", () => {
  it("b64url decode failure (catch at b64urlToBytes) refuses", async () => {
    vi.spyOn(globalThis, "atob").mockImplementation(() => {
      throw new Error("boom");
    });
    const tok = await signedToken("session:v1", JSON.stringify({ sub: "u", pos: 1, exp: 9e9 }));
    expect(await readSession(tok, SECRET, NOW)).toBeNull();
    expect(await sessionGrantsAccess(tok, ENV, NOW)).toBe(false);
  });
  it("HMAC failure (catch at hmacB64url) refuses", async () => {
    const tok = await mintSession("u1", 5, SECRET, NOW);
    vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error("boom"));
    expect(await readSession(tok, SECRET, NOW)).toBeNull();
    expect(await sessionGrantsAccess(tok, ENV, NOW)).toBe(false);
  });
  it("validly signed but non-JSON / invalid-UTF8 body refuses", async () => {
    expect(await readSession(await signedToken("session:v1", "not json"), SECRET, NOW)).toBeNull();
    const { createHmac } = await import("node:crypto");
    const b = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url");
    const mac = createHmac("sha256", `${SECRET}:session:v1`).update(b).digest("base64url");
    expect(await readSession(`${b}.${mac}`, SECRET, NOW)).toBeNull();
  });
  it("a handoff does not open as a session and null token refuses", async () => {
    const tok = await signedToken("handoff:v1", JSON.stringify({ sub: "u", pos: 1, exp: 9e9 }));
    expect(await readHandoff(tok, SECRET, NOW)).not.toBeNull();
    expect(await readSession(tok, SECRET, NOW)).toBeNull();
    expect(await sessionGrantsAccess(null, ENV, NOW)).toBe(false);
  });
});
