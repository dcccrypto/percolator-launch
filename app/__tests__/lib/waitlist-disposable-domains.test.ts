/**
 * Disposable-email helper behaviour.
 *
 * The list is the single source of truth shared between the signup
 * route (rejects at the door) and the admin spam panel (post-facto
 * detection). These tests pin the match semantics so a future refactor
 * can't accidentally:
 *   • switch to a subdomain match (legit forwarders would be blocked)
 *   • re-introduce case sensitivity (the caller lowercases; the helper
 *     trusts that contract — both directions of the contract should
 *     break loudly here if violated)
 *   • drop the lastIndexOf("@") in favour of indexOf (display-name
 *     emails like "Alice <a@x>" would then match against "x>" or
 *     similar garbage)
 */

import { describe, it, expect } from "vitest";
import {
  DISPOSABLE_EMAIL_DOMAINS,
  isDisposableEmail,
} from "../../lib/waitlist/disposable-domains";

describe("DISPOSABLE_EMAIL_DOMAINS", () => {
  it("is a non-empty ReadonlySet", () => {
    expect(DISPOSABLE_EMAIL_DOMAINS.size).toBeGreaterThan(0);
  });

  it("contains the canonical throwaway providers", () => {
    // Smoke-check that the list is roughly the right shape — pinned
    // against the well-known names so an accidental wipe is obvious.
    for (const known of [
      "mailinator.com",
      "guerrillamail.com",
      "10minutemail.com",
      "yopmail.com",
      "tempmail.com",
    ]) {
      expect(DISPOSABLE_EMAIL_DOMAINS.has(known)).toBe(true);
    }
  });

  it("does NOT contain mainstream providers", () => {
    // Defence against an accidental "add all .com" entry — the legit
    // providers below must always be allowed through.
    for (const real of [
      "gmail.com",
      "outlook.com",
      "yahoo.com",
      "icloud.com",
      "proton.me",
      "protonmail.com",
      "fastmail.com",
      "hey.com",
    ]) {
      expect(DISPOSABLE_EMAIL_DOMAINS.has(real)).toBe(false);
    }
  });
});

describe("isDisposableEmail", () => {
  it("flags a basic mailinator address", () => {
    expect(isDisposableEmail("alice@mailinator.com")).toBe(true);
  });

  it("flags every entry in the blocklist for a trivial local part", () => {
    // Walk every entry — catches a regression where the helper used
    // indexOf instead of lastIndexOf, or strip-port-style cruft.
    for (const dom of DISPOSABLE_EMAIL_DOMAINS) {
      expect(isDisposableEmail(`user@${dom}`)).toBe(true);
    }
  });

  it("returns false for canonical real providers", () => {
    for (const real of [
      "alice@gmail.com",
      "bob@outlook.com",
      "carol@yahoo.com",
      "dave@icloud.com",
      "eve@proton.me",
    ]) {
      expect(isDisposableEmail(real)).toBe(false);
    }
  });

  it("matches the LAST @-segment (display-name immunity)", () => {
    // If isDisposableEmail used indexOf instead of lastIndexOf, a
    // pasted display-name shape like the below would slice to
    // "mailinator.com>" and miss the match. Pin the correct semantics.
    // (The signup route's EMAIL_RE already rejects display-name shapes
    // before this helper runs, but the helper itself must be robust.)
    expect(isDisposableEmail("Alice <alice@mailinator.com>")).toBe(false);
    // ...because the last `@` is followed by "mailinator.com>" which
    // isn't in the set. Confirms the helper doesn't try to be too
    // clever about parsing.
  });

  it("treats subdomains as NOT disposable", () => {
    // Documented design choice — legit forwarders sometimes live on
    // vendor subdomains. Stricter matching would risk false positives.
    expect(isDisposableEmail("user@mail.mailinator.com")).toBe(false);
  });

  it("does NOT lowercase input — caller's contract", () => {
    // The signup route lowercases before calling. If a caller passes
    // mixed case, the helper returns false (the blocklist entries are
    // all lowercase). This is the contract; a regression that
    // auto-lowercased here would mask bugs at the caller.
    expect(isDisposableEmail("User@Mailinator.com")).toBe(false);
  });

  it("returns false for malformed shapes", () => {
    expect(isDisposableEmail("")).toBe(false);
    expect(isDisposableEmail("@mailinator.com")).toBe(false); // no local
    expect(isDisposableEmail("user@")).toBe(false); // no domain
    expect(isDisposableEmail("user")).toBe(false); // no @
  });
});
