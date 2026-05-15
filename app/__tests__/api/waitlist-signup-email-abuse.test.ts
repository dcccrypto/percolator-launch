/**
 * Waitlist signup — email-bombing hardening.
 *
 * The route used to fire a Resend confirmation email on every POST that
 * carried an email field, regardless of whether the insert actually
 * created a new row. Combined with the route's own 23505 swallow (treating
 * unique-violation as "already on the list, idempotent"), that meant
 * resubmitting the same {email} payload from rotating IPs caused the
 * same victim's inbox to be flooded — once per request. The middleware's
 * 120 req/min/IP rate limit was trivially bypassed with residential
 * proxies, and there was no per-email or global ceiling on the Resend
 * send rate.
 *
 * The fix is three-layered:
 *   (1) capture isDuplicate from the insert error and skip the send when
 *       set — Resend send count == new-row count.
 *   (2) per-email Upstash limiter (1/24h) backstops a future regression
 *       of the unique-on-lower(email) index.
 *   (3) global hourly Upstash cap (default 500/h, tunable via
 *       WAITLIST_EMAIL_HOURLY_CAP) bounds Resend quota burn under the
 *       fresh-victims-mass-signup variant where layer 1 and 2 don't help.
 *
 * This test guards the route source so a future "let's just fire the
 * mail unconditionally again" refactor trips the suite.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../app/api/waitlist/signup/route.ts",
);

describe("/api/waitlist/signup email-bombing hardening", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");

  it("captures isDuplicate from the insert error code", () => {
    // Refactored to retry-loop form (assigns true on 23505 inside the loop)
    // rather than a single `isDuplicate = err?.code === "23505"` expression.
    // Either form is correct; just confirm the route reads the unique-violation
    // code and routes a flag named isDuplicate from it.
    expect(source).toMatch(/let\s+isDuplicate\s*=\s*false/);
    expect(source).toMatch(/error\.code\s*!==\s*"23505"/);
    expect(source).toMatch(/isDuplicate\s*=\s*true/);
  });

  it("skips the confirmation email on duplicate insert", () => {
    // The single Resend-send call site must sit inside an `if (...)`
    // whose condition includes both `hasEmail` and `!isDuplicate`.
    const beforeSend = source.split("sendConfirmationEmail(emailRaw!")[0];
    expect(beforeSend).toBeDefined();
    // Walk back from the call site to the nearest `if (` and confirm the
    // gate. The pre-fix gate was `if (hasEmail) { sendConfirmationEmail(...) }`.
    const lastIfIdx = beforeSend.lastIndexOf("if (");
    expect(lastIfIdx).toBeGreaterThan(-1);
    const gate = beforeSend.slice(lastIfIdx);
    expect(gate).toContain("hasEmail");
    expect(gate).toContain("!isDuplicate");
  });

  it("gates the send through a per-email budget (1 per 24 h)", () => {
    expect(source).toContain("shouldSendConfirmationEmail");
    expect(source).toMatch(/Ratelimit\.slidingWindow\(\s*1\s*,\s*"24 h"/);
  });

  it("enforces a global hourly cap, env-tunable via WAITLIST_EMAIL_HOURLY_CAP", () => {
    expect(source).toContain("WAITLIST_EMAIL_HOURLY_CAP");
    // Global limiter is keyed at "1 h" with a numeric cap (not the literal
    // 1 of the per-email limiter).
    expect(source).toMatch(/Ratelimit\.slidingWindow\([^,]+,\s*"1 h"/);
  });

  it("hashes the email before using it as a Redis key", () => {
    // Privacy hygiene — Redis logs / dashboards must never see cleartext
    // emails as rate-limit keys.
    expect(source).toContain("emailRateKey");
    expect(source).toMatch(
      /createHash\("sha256"\)\.update\(email\)\.digest\("hex"\)/,
    );
  });

  it("fails open when Upstash is unconfigured (local dev / Redis outage)", () => {
    // Matches the in-memory fallback posture in middleware.ts. Without
    // this, /api/waitlist/signup would 500 in CI/dev where UPSTASH_*
    // env vars are unset.
    expect(source).toMatch(
      /if\s*\(\s*!perEmail\s*\|\|\s*!global\s*\)\s*return\s+true/,
    );
  });

  it("does not reach the Resend send call from the wallet-only path", () => {
    // The send guard must require hasEmail. There must be exactly one
    // call site to sendConfirmationEmail (the function definition isn't
    // counted by this regex because the param is `email`, not `emailRaw`).
    const callSites = source.match(/sendConfirmationEmail\(emailRaw!/g) ?? [];
    expect(callSites.length).toBe(1);
  });
});
