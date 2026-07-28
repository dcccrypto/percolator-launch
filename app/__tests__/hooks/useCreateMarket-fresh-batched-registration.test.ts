import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hookSource = readFileSync(
  resolve(process.cwd(), "hooks/useCreateMarket.ts"),
  "utf8",
);

const functionStart = hookSource.indexOf(
  "async function attemptFreshBatchedLaunch",
);
const functionEnd = hookSource.indexOf("\nconst STEP_LABELS", functionStart);
const freshBatchSource = hookSource.slice(functionStart, functionEnd);

describe("useCreateMarket fresh batched registration", () => {
  it("has locatable function bounds (guards the source-scan itself)", () => {
    // These tests scan source text, so a moved marker silently turns every
    // assertion below into a no-op. This test failed exactly that way once
    // already: the slice used `keeperRegisterPromise` as an end marker, the
    // zombie fix moved markets-registration AFTER it, indexOf returned -1, and
    // the guard stopped guarding while looking like an ordinary failure.
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(freshBatchSource.length).toBeGreaterThan(1000);
  });

  it("signs the canonical registration payload and posts that same payload", () => {
    // The signed message and the POSTed body must be byte-identical (#2387).
    expect(freshBatchSource).toMatch(
      /const registrationPayload\s*=\s*buildMarketRegistrationPayload\(\{/,
    );
    expect(freshBatchSource).toContain(
      "const deployerStr: string = walletPk.toBase58();",
    );
    expect(freshBatchSource).toMatch(
      /buildMarketRegistrationMessage\(\{\s*nonce:\s*marketsNonce,\s*deployer:\s*deployerStr,\s*payload:\s*registrationPayload,\s*\}\)/s,
    );
    expect(freshBatchSource).toContain("wallet.signMessage(signingMessage)");
    expect(freshBatchSource).not.toContain(
      "new TextEncoder().encode(marketsNonce)",
    );
  });

  it("POSTs the shared payload, never a re-typed literal", () => {
    // Scoped to the registerMarketInDb body — the zombie fix moved the fetch
    // into that helper, so slicing on the old `marketsRegisterPromise` marker
    // no longer covers it.
    const start = freshBatchSource.indexOf("const registerMarketInDb");
    expect(start).toBeGreaterThanOrEqual(0);
    // Bound to the helper itself — running past it picks up keeper-register's
    // own `{ deployer: ... }` argument and produces a false positive.
    const end = freshBatchSource.indexOf("const keeperRegisterPromise", start);
    expect(end).toBeGreaterThan(start);
    const body = freshBatchSource.slice(start, end);

    expect(body).toMatch(/body:\s*JSON\.stringify\(\{\s*\.\.\.registrationPayload,/s);
    expect(body).toMatch(
      /\.\.\.\(marketsNonce\s*&&\s*marketsSignature\s*\?\s*\{\s*nonce:\s*marketsNonce,\s*signature:\s*marketsSignature\s*\}/s,
    );
    // Must not drift back to a separately duplicated registration object.
    expect(body).not.toMatch(/\bslab_address\s*:/);
    expect(body).not.toMatch(/\bmint_address\s*:/);
    expect(body).not.toMatch(/\bdeployer\s*:/);
  });

  it("does not publish the market until it actually holds collateral", () => {
    // THE ZOMBIE GUARD. Registration used to fire right after M1, so any launch
    // that died later (steps 4-5 never ran) still published a listed, unfunded,
    // untradeable market — and because "create the market" always succeeds,
    // EVERY failed launch left one behind. That is what happened to the ANSEM
    // market: it registered, then M3a never landed.
    //
    // Registration must therefore come AFTER the M3a broadcast
    // (DepositCollateral + backing seed).
    const m3a = freshBatchSource.indexOf("const m3aSig = await broadcastTailTx(2)");
    // Match the CALL, not the prose — the doc comment above also contains
    // "registerMarketInDb()" and sits before M3a, which made this pass a
    // stale-looking failure the first time round.
    const register = freshBatchSource.indexOf(
      "const marketsRegisterPromise = registerMarketInDb();",
    );
    expect(m3a).toBeGreaterThanOrEqual(0);
    expect(register).toBeGreaterThan(m3a);

    // And it must be idempotent — the helper is reachable from more than one
    // place, so a second call must not double-POST.
    expect(freshBatchSource).toMatch(/let marketsRegistered\s*=\s*false/);
    expect(freshBatchSource).toMatch(
      /if\s*\(marketsRegistered\)\s*return;\s*marketsRegistered\s*=\s*true;/s,
    );
  });

  it("keeps keeper-registration before M4, where marketauth still works", () => {
    // Deliberately NOT deferred like the DB registration: StakeInitPool (in M4)
    // rotates marketauth away from the deployer, and keeper-register's H1 check
    // requires marketauth to still equal the deployer. Pinning the order stops
    // someone "fixing" the asymmetry and silently breaking keeper registration.
    const keeper = freshBatchSource.indexOf("const keeperRegisterPromise");
    const m4 = freshBatchSource.indexOf("const m4Sig = await broadcastTailTx(4)");
    expect(keeper).toBeGreaterThanOrEqual(0);
    expect(m4).toBeGreaterThan(keeper);
  });

  it("builds the registration payload in exactly ONE place (no drift between paths)", () => {
    const factoryDefs = hookSource.match(/function buildMarketRegistrationPayload\b/g) ?? [];
    expect(factoryDefs.length).toBe(1);

    const factoryCalls = hookSource.match(/buildMarketRegistrationPayload\(\{/g) ?? [];
    expect(factoryCalls.length).toBe(2); // batched path + sequential fallback

    expect(hookSource).not.toMatch(/MarketRegistrationPayload\s*=\s*\{/);
  });
});
