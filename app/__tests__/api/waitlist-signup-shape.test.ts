/**
 * Waitlist signup input-shape rejection.
 *
 * The route used to accept three shapes: email-only, wallet-only, and a
 * combined email+wallet shape that skipped the on-chain mainnet check on
 * the assumption that Privy's OTP gate proved real intent. The server
 * never actually verified anything from Privy, so the combined shape let
 * any caller bind an arbitrary email to a self-controlled keypair, and a
 * downstream silent 23505 swallow then made a victim's later email-only
 * signup look successful while their pubkey was never persisted.
 *
 * The fix rejects the combined shape outright. This test guards the
 * route source so a future "let's bring back combined" refactor can't
 * land without tripping the assertion.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../app/api/waitlist/signup/route.ts",
);

describe("/api/waitlist/signup input shape", () => {
  it("rejects the combined email + wallet shape with 400", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");

    expect(source).toMatch(/if\s*\(\s*hasEmail\s*&&\s*hasWalletPart\s*\)/);
    // The 400 status must live inside that branch, not somewhere else.
    const combinedBranch = source
      .split("if (hasEmail && hasWalletPart)")[1]
      ?.split("if (!hasEmail && !hasWalletPart)")[0];
    expect(combinedBranch).toBeDefined();
    expect(combinedBranch).toContain("status: 400");
  });

  it("requires either an email OR a wallet signature, not both", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toContain('"provide an email or a wallet signature"');
    // The pre-fix copy ("…or both") must be gone.
    expect(source).not.toContain('"provide an email, a wallet signature, or both"');
  });

  it("runs the mainnet existence check unconditionally on the wallet path", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    // Pre-fix the call sat behind `if (!hasEmail) { … }`. Post-fix the
    // wrapper is gone. Confirm both: the call still exists and the
    // wrapper guard does not.
    expect(source).toContain("walletExistsOnMainnet(pubkey!)");
    expect(source).not.toMatch(/if\s*\(\s*!hasEmail\s*\)\s*\{\s*const\s+exists\s*=\s*await\s+walletExistsOnMainnet/);
  });

  it("rejects signups missing a referral code (invite-only)", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    // The required-referrer branch must return 400. Pin the error string
    // so a future refactor can't accidentally re-open the route to the
    // unauthenticated public.
    expect(source).toMatch(
      /referredByRaw\s*===\s*null\s*\|\|\s*referredByRaw\.length\s*===\s*0/,
    );
    expect(source).toContain(
      'referral code required — Percolator is invite-only',
    );
    expect(source).toMatch(/status:\s*400/);
  });

  it("rejects disposable email domains at signup, not just in admin", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    // Import from the shared module — pins the single-source-of-truth
    // contract. If a future refactor re-defines the list inline in the
    // route, the admin panel's count would silently drift from what
    // the route blocks.
    expect(source).toContain(
      `import { isDisposableEmail } from "@/lib/waitlist/disposable-domains"`,
    );
    // The check runs inside the email-shape branch, returns 400, and
    // the error string does NOT echo the rejected domain (no need to
    // confirm to a bot which entries are on the list).
    expect(source).toMatch(/if\s*\(\s*isDisposableEmail\s*\(\s*emailRaw\s*\)\s*\)/);
    expect(source).toContain("this email provider isn't accepted");
  });

  it("places the disposable check INSIDE the email-shape branch", () => {
    // Defence-in-depth: the disposable check should only run after the
    // email passed shape validation. If a future refactor moves it
    // above the shape check, malformed inputs could reach the helper
    // (it'd return false for them, but the route would then fall
    // through to the wallet path with a half-validated email field).
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    const emailShapeIdx = source.indexOf("EMAIL_RE.test(emailRaw)");
    const disposableCheckIdx = source.indexOf("isDisposableEmail(emailRaw)");
    expect(emailShapeIdx).toBeGreaterThan(0);
    expect(disposableCheckIdx).toBeGreaterThan(0);
    expect(disposableCheckIdx).toBeGreaterThan(emailShapeIdx);
  });

  it("enforces a minimum time-on-page (dwell) before accepting a submit", () => {
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    // Floor + stale cap constants present.
    expect(source).toMatch(/MIN_DWELL_MS\s*=\s*1500/);
    expect(source).toMatch(/MAX_STALE_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    // Reads from the body, validates as a finite number.
    expect(source).toMatch(/typeof\s+b\.mounted_at\s*===\s*"number"/);
    expect(source).toContain("Number.isFinite(b.mounted_at)");
    // Rejects with 400 (opaque error so a bot can't refine its script
    // off our copy).
    expect(source).toContain("request rejected — refresh the page");
  });

  it("places the dwell check immediately after the honeypot", () => {
    // The check is essentially free (one branch, no I/O) so positioning
    // it as the very first non-trivial gate maximises the work saved
    // when the dwell is wrong — a missing `mounted_at` short-circuits
    // BEFORE the captcha siteverify call and BEFORE the wallet
    // signature verify.
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    const honeypotIdx = source.indexOf("Honeypot — silently accept");
    const dwellIdx = source.indexOf("Time-on-page (dwell) check");
    const captchaIdx = source.indexOf("Cloudflare Turnstile gate");
    expect(honeypotIdx).toBeGreaterThan(0);
    expect(dwellIdx).toBeGreaterThan(0);
    expect(captchaIdx).toBeGreaterThan(0);
    expect(dwellIdx).toBeGreaterThan(honeypotIdx);
    expect(dwellIdx).toBeLessThan(captchaIdx);
  });

  it("rejects when dwell is below the floor, above the cap, or negative", () => {
    // The conditional should cover three independent fail modes,
    // not just the under-floor case. Pin all three so a future
    // refactor that drops one branch is flagged.
    const source = fs.readFileSync(ROUTE_PATH, "utf8");
    expect(source).toMatch(/dwellMs\s*<\s*0/);
    expect(source).toMatch(/dwellMs\s*<\s*MIN_DWELL_MS/);
    expect(source).toMatch(/dwellMs\s*>\s*MAX_STALE_MS/);
  });
});
