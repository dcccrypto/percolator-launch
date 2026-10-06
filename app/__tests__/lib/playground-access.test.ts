/**
 * The playground gate's crypto contract.
 *
 * This is the lock on devnet v2. A hole here is not a wrong number on a screen
 * — it is everyone walking in. So the cases below are adversarial by default:
 * forged signatures, swapped token kinds, expiry edges, tampered payloads, and
 * the two ways a gate ships open (missing secret, null position).
 */

import { describe, expect, it } from "vitest";
import {
  HANDOFF_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  accessSecret,
  cohortCutoff,
  isWithinCohort,
  mintHandoff,
  mintSession,
  readHandoff,
  readSession,
} from "@/lib/playground-access";

const SECRET = "x".repeat(32);
const OTHER = "y".repeat(32);
const NOW = 1_800_000_000_000; // fixed clock; nothing here may depend on real time

describe("handoff tokens", () => {
  it("carries the referral code, signed: it round-trips and can't be edited", () => {
    const t = mintHandoff("row-1", 42, SECRET, NOW, "PERC7Q");
    expect(readHandoff(t, SECRET, NOW)).toMatchObject({ sub: "row-1", pos: 42, ref: "PERC7Q" });
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString("utf8")), ref: "OTHER1" })).toString("base64url");
    expect(readHandoff(`${forged}.${mac}`, SECRET, NOW)).toBeNull();
  });

  it("no referral code: no ref claim (an old-style token)", () => {
    expect(readHandoff(mintHandoff("row-1", 42, SECRET, NOW), SECRET, NOW)).not.toHaveProperty("ref");
    expect(readHandoff(mintHandoff("row-1", 42, SECRET, NOW, ""), SECRET, NOW)).not.toHaveProperty("ref");
  });

  it("round-trips the claims it was minted with", () => {
    const t = mintHandoff("row-1", 42, SECRET, NOW);
    const c = readHandoff(t, SECRET, NOW);
    expect(c?.sub).toBe("row-1");
    expect(c?.pos).toBe(42);
  });

  it("refuses a token signed with a different secret", () => {
    const t = mintHandoff("row-1", 42, OTHER, NOW);
    expect(readHandoff(t, SECRET, NOW)).toBeNull();
  });

  it("refuses a tampered payload", () => {
    // Promote yourself to position 1 by editing the body. The signature covers
    // the body, so this must fail — this is the whole point of signing.
    const t = mintHandoff("row-1", 9999, SECRET, NOW);
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "row-1", pos: 1, exp: 9e9 }), "utf8").toString("base64url");
    expect(readHandoff(`${forged}.${mac}`, SECRET, NOW)).toBeNull();
    // CONTROL: the untampered token DOES verify, so the assertion above is
    // about the tampering and not about a broken harness.
    expect(readHandoff(`${body}.${mac}`, SECRET, NOW)).not.toBeNull();
  });

  it("expires exactly at its TTL, not after", () => {
    const t = mintHandoff("row-1", 1, SECRET, NOW);
    const justInside = NOW + (HANDOFF_TTL_SECONDS - 1) * 1000;
    const atExpiry = NOW + HANDOFF_TTL_SECONDS * 1000;
    expect(readHandoff(t, SECRET, justInside)).not.toBeNull();
    expect(readHandoff(t, SECRET, atExpiry)).toBeNull();
  });

  it("is short-lived — a link pasted in chat goes stale fast", () => {
    expect(HANDOFF_TTL_SECONDS).toBeLessThanOrEqual(120);
  });
});

describe("token kinds cannot be swapped", () => {
  it("a handoff token is not accepted as a session", () => {
    // Same secret, different derivation. Without this a 90-second token would
    // be usable for 24 hours.
    const t = mintHandoff("row-1", 1, SECRET, NOW);
    expect(readSession(t, SECRET, NOW)).toBeNull();
  });

  it("a session cookie is not accepted as a handoff", () => {
    const s = mintSession("row-1", 1, SECRET, NOW);
    expect(readHandoff(s, SECRET, NOW)).toBeNull();
  });

  it("CONTROL: each verifies under its own kind", () => {
    expect(readHandoff(mintHandoff("r", 1, SECRET, NOW), SECRET, NOW)).not.toBeNull();
    expect(readSession(mintSession("r", 1, SECRET, NOW), SECRET, NOW)).not.toBeNull();
  });
});

describe("sessions", () => {
  it("lasts a day, then stops", () => {
    const s = mintSession("row-1", 7, SECRET, NOW);
    expect(readSession(s, SECRET, NOW + (SESSION_TTL_SECONDS - 1) * 1000)).not.toBeNull();
    expect(readSession(s, SECRET, NOW + SESSION_TTL_SECONDS * 1000)).toBeNull();
  });
});

describe("malformed input is refused, never thrown on", () => {
  // Middleware runs this on every request; a throw is a 500 on every page.
  it.each([
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["no separator", "abcdef"],
    ["separator only", "."],
    ["leading separator", ".abc"],
    ["trailing separator", "abc."],
    ["not base64", "!!!.???"],
    ["body is not json", `${Buffer.from("nope", "utf8").toString("base64url")}.sig`],
  ])("%s", (_label, input) => {
    expect(() => readHandoff(input as string, SECRET, NOW)).not.toThrow();
    expect(readHandoff(input as string, SECRET, NOW)).toBeNull();
    expect(readSession(input as string, SECRET, NOW)).toBeNull();
  });

  it("refuses a validly-signed token whose claims are the wrong shape", () => {
    // Signature valid, contents junk — the shape checks must still reject it,
    // or `pos` could arrive as a string and slip past a numeric comparison.
    const body = Buffer.from(JSON.stringify({ sub: "", pos: "1", exp: 9e9 }), "utf8").toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const mac = createHmac("sha256", `${SECRET}:handoff:v1`).update(body).digest().toString("base64url");
    expect(readHandoff(`${body}.${mac}`, SECRET, NOW)).toBeNull();
  });
});

describe("cohort membership fails CLOSED", () => {
  it("admits a position inside the cutoff", () => {
    expect(isWithinCohort(1, 1000)).toBe(true);
    expect(isWithinCohort(1000, 1000)).toBe(true);
  });

  it("refuses the first position past it", () => {
    expect(isWithinCohort(1001, 1000)).toBe(false);
  });

  it.each([
    ["null — lookup failed or not a member", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s", (_label, pos) => {
    // A failed position lookup must CLOSE the door, not open it. This is the
    // single most important assertion in the file: a Supabase blip must not
    // admit the internet.
    expect(isWithinCohort(pos as number, 1000)).toBe(false);
  });

  it("refuses everyone when the cutoff itself is nonsense", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isWithinCohort(1, bad)).toBe(false);
    }
  });
});

describe("configuration", () => {
  it("defaults to the announced first 1000", () => {
    expect(cohortCutoff(undefined)).toBe(1000);
    expect(cohortCutoff("")).toBe(1000);
    expect(cohortCutoff("not-a-number")).toBe(1000);
    expect(cohortCutoff("-5")).toBe(1000);
  });

  it("honours an explicit cutoff, so day two does not need a code change", () => {
    expect(cohortCutoff("2500")).toBe(2500);
  });

  it("treats a missing or too-short secret as unset", () => {
    // Returning null here is what makes the routes refuse. A short secret is
    // worse than none because it looks configured.
    expect(accessSecret({} as NodeJS.ProcessEnv)).toBeNull();
    expect(accessSecret({ PLAYGROUND_ACCESS_SECRET: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(accessSecret({ PLAYGROUND_ACCESS_SECRET: "short" } as NodeJS.ProcessEnv)).toBeNull();
    expect(accessSecret({ PLAYGROUND_ACCESS_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(SECRET);
  });
});

describe("no identifier is carried in a token", () => {
  it("the encoded body contains the row id and position, never an email or wallet", () => {
    // Signed, NOT encrypted: anyone can decode this. If an email were ever put
    // in the claims it would be readable in a URL, a referrer header and a
    // server log. Pin it.
    const t = mintHandoff("row-abc", 12, SECRET, NOW);
    const decoded = Buffer.from(t.split(".")[0]!, "base64url").toString("utf8");
    expect(decoded).toContain("row-abc");
    expect(decoded).not.toMatch(/@/);
    expect(JSON.parse(decoded)).toEqual({ sub: "row-abc", pos: 12, exp: expect.any(Number) });
  });

  it("the referral code, when given, is the only addition: public by design, still no email or wallet", () => {
    const t = mintHandoff("row-abc", 12, SECRET, NOW, "PERC7Q");
    const decoded = Buffer.from(t.split(".")[0]!, "base64url").toString("utf8");
    expect(decoded).not.toMatch(/@/);
    expect(JSON.parse(decoded)).toEqual({ sub: "row-abc", pos: 12, exp: expect.any(Number), ref: "PERC7Q" });
  });
});
