/**
 * PoC + regression — shared admin-secret check: fixed-length compare (no length
 * leak) + per-capability secret with fallback.
 *
 * The previous inline checks used `a.length === b.length && timingSafeEqual(a, b)`,
 * which short-circuits on a length mismatch (a timing signal for the secret's
 * length), and every admin route shared one ADMIN_API_SECRET.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { checkAdminSecret } from "@/lib/admin-secret";

const reqWith = (value: string | null): NextRequest =>
  ({ headers: { get: (k: string) => (k === "x-admin-secret" ? value : null) } } as unknown as NextRequest);

const ENV_KEYS = ["ADMIN_API_SECRET", "ADMIN_ORACLE_SECRET", "ADMIN_REGISTER_SECRET"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("checkAdminSecret", () => {
  it("PoC: the old compare leaks length by short-circuiting on a mismatch", () => {
    // Model of the removed check: timingSafeEqual is not even reached when lengths
    // differ, so a wrong-length guess returns faster than a right-length one.
    let constantTimeReached = false;
    const oldCheck = (secret: string, provided: string) => {
      const a = Buffer.from(provided), b = Buffer.from(secret);
      if (a.length !== b.length) return false;          // early return — timing signal
      constantTimeReached = true;
      return a.equals(b);
    };
    expect(oldCheck("supersecret", "x")).toBe(false);
    expect(constantTimeReached).toBe(false);             // never did constant-time work
  });

  it("accepts the correct secret and rejects wrong/empty (fixed-length compare)", () => {
    process.env.ADMIN_API_SECRET = "supersecret";
    expect(checkAdminSecret(reqWith("supersecret"))).toBe(true);
    expect(checkAdminSecret(reqWith("wrong"))).toBe(false);
    expect(checkAdminSecret(reqWith("supersecre"))).toBe(false); // off-by-one length
    expect(checkAdminSecret(reqWith(""))).toBe(false);
    expect(checkAdminSecret(reqWith(null))).toBe(false);
  });

  it("denies when no secret is configured (fail closed)", () => {
    expect(checkAdminSecret(reqWith("anything"), "oracle")).toBe(false);
  });

  it("per-capability secret overrides the shared fallback", () => {
    process.env.ADMIN_API_SECRET = "shared";
    process.env.ADMIN_ORACLE_SECRET = "oracle-only";
    // oracle capability uses its own secret; the shared one no longer works for it
    expect(checkAdminSecret(reqWith("oracle-only"), "oracle")).toBe(true);
    expect(checkAdminSecret(reqWith("shared"), "oracle")).toBe(false);
    // a capability without its own secret falls back to the shared one
    expect(checkAdminSecret(reqWith("shared"), "register")).toBe(true);
  });
});
