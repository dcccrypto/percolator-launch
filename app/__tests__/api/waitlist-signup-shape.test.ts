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
});
