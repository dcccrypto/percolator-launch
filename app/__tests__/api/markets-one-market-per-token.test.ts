import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One market per token: launching a second market for a token that already
 * has one must be rejected. Guard is keyed on mainnet_ca (the token's
 * identity field) — NOT mint_address, which on the playground is the
 * COLLATERAL mint (the same sim-USDC for every market) and would 409 every
 * legitimate launch. Source-assertion style mirrors
 * markets-duplicate-slab-guard.test.ts.
 */
describe("one market per token", () => {
  const routeSource = readFileSync(
    resolve(__dirname, "../../app/api/markets/route.ts"),
    "utf8",
  );

  it("POST rejects a second market for the same mainnet_ca (Supabase path)", () => {
    expect(routeSource).toContain('.eq("mainnet_ca", canonicalMainnetCa)');
    expect(routeSource).toContain("A market for this token already exists");
    expect(routeSource).toContain("One market per token");
  });

  it("POST canonicalizes mainnet_ca before deduping (no alternate-encoding dodge)", () => {
    expect(routeSource).toContain("canonicalMainnetCa = new PublicKey(mainnet_ca).toBase58()");
  });

  it("POST dedupes on mainnet_ca, never on mint_address (shared sim-USDC collateral)", () => {
    // The dedupe query must not filter markets by mint_address — every
    // playground market shares the sim-USDC collateral there, so that key
    // would false-positive every launch after the first.
    expect(routeSource).not.toContain('.eq("mint_address"');
  });

  it("POST also guards the no-Supabase (Blob registry) path", () => {
    expect(routeSource).toContain("r.mainnetCA === canonicalMainnetCa");
  });

  it("GET search matches mainnet_ca so the wizard's duplicate lookup can find the market", () => {
    // Both list-shaped search filters (on-chain-discovery + static fallback)
    // must include the CA in their match set.
    const caMatches = routeSource.match(/ca\.includes\(searchTrimmed\)/g) ?? [];
    expect(caMatches.length).toBeGreaterThanOrEqual(2);
    // Supabase path's direct-address match:
    expect(routeSource).toContain("mainnetCa.toLowerCase().includes(q)");
  });

  it("create wizard blocks Continue when the token already has a market", () => {
    const stepSource = readFileSync(
      resolve(__dirname, "../../components/create/StepTokenSelect.tsx"),
      "utf8",
    );
    expect(stepSource).toContain("duplicateBlocked");
    expect(stepSource).toContain("!duplicateBlocked");
    expect(stepSource).toContain("one market per token");
  });

  it("wizard gates BOTH Quick Launch auto-advance and step-1 Continue on the check", () => {
    // The guard must live in CreateMarketWizard (not only StepTokenSelect):
    // Quick Launch auto-advances and unmounts the step, so step-local state
    // can't gate anything. step1CanAdvance also waits while the lookup is
    // in flight so auto-advance can't race past a pending check.
    const wizardSource = readFileSync(
      resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"),
      "utf8",
    );
    expect(wizardSource).toContain("useDuplicateMarket(");
    expect(wizardSource).toContain(
      "const step1CanAdvance = step1Valid && !duplicateCheck.checking && duplicateCheck.duplicates.length === 0",
    );
    expect(wizardSource).toContain("if (!step1CanAdvance) return;");
    expect(wizardSource).toContain("canContinue={step1CanAdvance}");
  });

  it("lookup hook fails open (server 409 is the authoritative gate)", () => {
    const hookSource = readFileSync(
      resolve(__dirname, "../../hooks/useDuplicateMarket.ts"),
      "utf8",
    );
    expect(hookSource).toContain("setState(CLEAR); // fail-open");
    expect(hookSource).toContain("mint === ca || mainnetCa === ca");
  });
});
