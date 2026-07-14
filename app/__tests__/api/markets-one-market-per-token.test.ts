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

  it("POST rejects a second market for the same token (Supabase path)", () => {
    expect(routeSource).toContain('mainnet_ca.eq.${canonicalMainnetCa}');
    expect(routeSource).toContain(".or(dedupeFilters.join(");
    expect(routeSource).toContain("A market for this token already exists");
    expect(routeSource).toContain("One market per token");
  });

  it("SEC: dedupes on the DEX pool too, so omitting optional mainnet_ca can't bypass it", () => {
    // mainnet_ca is not a required field — keying on it alone let a crafted
    // POST skip the gate by omitting it. dex_pool_address (the keeper's
    // pricing source) is the second key that closes the bypass.
    expect(routeSource).toContain('dex_pool_address.eq.${canonicalDexPool}');
    expect(routeSource).toContain("canonicalDexPool = new PublicKey(dex_pool_address).toBase58()");
  });

  it("POST canonicalizes both dedupe keys (no alternate-encoding dodge)", () => {
    expect(routeSource).toContain("canonicalMainnetCa = new PublicKey(mainnet_ca).toBase58()");
    expect(routeSource).toContain("canonicalDexPool = new PublicKey(dex_pool_address).toBase58()");
  });

  it("POST stores the CANONICAL mainnet_ca / dex_pool_address (dedupe keys must match on re-register)", () => {
    // The insert must not persist the raw request values — a non-canonical
    // encoding would slip past the canonical-keyed dedupe next time.
    expect(routeSource).toContain("mainnet_ca: canonicalMainnetCa");
    expect(routeSource).toContain("dex_pool_address: canonicalDexPool");
    expect(routeSource).not.toContain("mainnet_ca: mainnet_ca || null");
    expect(routeSource).not.toContain("dex_pool_address: dex_pool_address || null");
  });

  it("POST never dedupes on mint_address (shared sim-USDC collateral)", () => {
    // The dedupe must not filter markets by mint_address — every playground
    // market shares the sim-USDC collateral, so that key would false-positive
    // every launch after the first.
    expect(routeSource).not.toContain('.eq("mint_address"');
  });

  it("POST also guards the no-Supabase (Blob registry) path on either key", () => {
    expect(routeSource).toContain("r.mainnetCA === canonicalMainnetCa");
    expect(routeSource).toContain("r.poolAddress === canonicalDexPool");
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
