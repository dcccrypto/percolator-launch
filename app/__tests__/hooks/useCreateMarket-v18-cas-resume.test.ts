import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source guards for the 2026-09-29 live report ("engine is stale" on create,
// then "not authorized" on retry). The batched path and the step builders are
// closures inside one large hook, so — like the other useCreateMarket-* tests —
// these pin the wiring in source; the behaviour of each helper they call is
// unit-tested in __tests__/lib/create-market-v18.test.ts and
// parseMarketError-step-context.test.ts.
const hookSource = readFileSync(resolve(process.cwd(), "hooks/useCreateMarket.ts"), "utf8");

const batchStart = hookSource.indexOf("async function attemptFreshBatchedLaunch");
const batchEnd = hookSource.indexOf("\nconst STEP_LABELS", batchStart);
const batchSource = hookSource.slice(batchStart, batchEnd);

const step1Start = hookSource.indexOf("// Step 1: Oracle setup + pre-LP crank");
const step1End = hookSource.indexOf("// Step 2: v17 LP init sequence", step1Start);
const step1Source = hookSource.slice(step1Start, step1End);

describe("useCreateMarket v18 CAS + resume wiring", () => {
  it("has locatable bounds (guards the source scan itself)", () => {
    expect(batchStart).toBeGreaterThanOrEqual(0);
    expect(batchEnd).toBeGreaterThan(batchStart);
    expect(step1Start).toBeGreaterThanOrEqual(0);
    expect(step1End).toBeGreaterThan(step1Start);
    expect(step1Source.length).toBeGreaterThan(500);
  });

  it("batched funding txs bind the post-hand-off authority_epoch, never a literal 0", () => {
    // M3b TopUpInsurance and M4b UpdateFeeSplit are CAS-bound
    // to asset 0's authority_epoch, which the co-signed UpdateAssetAuthority
    // advances to 1 before M3a. The literal 0 made every keeper launch's M3a
    // revert EngineStale (Custom 19).
    expect(batchSource).not.toMatch(/authorityEpoch:\s*0n/);
    expect(batchSource).toContain("freshLaunchAuthorityEpoch(cosignTx !== null)");
    const uses = batchSource.match(/authorityEpoch: assetZeroAuthorityEpoch/g) ?? [];
    expect(uses.length).toBe(2); // M3b TopUpInsurance + M4b UpdateFeeSplit (M3a backing seed removed, C-1)
  });

  it("no direct backing top-up remains in either create path (C-1)", () => {
    // A direct TopUpBackingBucket makes CreateLpVault fail Custom(63); the
    // domains are funded by DepositToLpVault instead (lib/earn-vault-seed.ts).
    expect(hookSource).not.toMatch(/encodeTopUpBackingBucket|ACCOUNTS_TOP_UP_BACKING_BUCKET|DIRECT_BACKING_TOPUP_EXPIRY_SLOT/);
    expect(hookSource.match(/buildEarnVaultSeedInstructions\(/g)?.length).toBe(2); // batched M4a + sequential Step 4
  });

  it("a batch failure hands Retry the step to resume from, not step 0", () => {
    // handleRetry calls create(params, createState.step). The batch left step
    // at 0, so Retry skipped the existing slab and then re-sent the keeper
    // hand-off — refused with Unauthorized (Custom 8).
    expect(batchSource).toMatch(/error: msg, step: resumeStep/);
    expect(batchSource).toContain("resumeStep = signedCosign ? 1 : 2;");
    expect(batchSource).toContain("parseMarketCreationError(err, { step: failingKind, stepLabel: failingLabel })");
  });

  it("step 1 skips the keeper hand-off once it is on-chain, checked before the co-sign request", () => {
    // The guard is keeper-aware: "already delegated" must mean delegated TO THE
    // KEEPER, so the keeper pubkey is resolved before the guard runs.
    const keeperKey = step1Source.indexOf("await fetchKeeperCosignPubkey()");
    const guard = step1Source.indexOf("isOracleDelegationApplied(profile, wallet.publicKey, keeperPubkey)");
    const cosign = step1Source.indexOf('fetch("/api/playground/keeper-cosign"');
    expect(keeperKey).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(keeperKey);
    expect(cosign).toBeGreaterThan(guard);
    expect(step1Source).toContain("if (isKeeperOracle && isV17Slab && !oracleDelegationDone)");
  });

  it("step 1 refuses a market whose oracle authority is neither the deployer nor the keeper", () => {
    // Such a market can never be priced and its registration is refused with a
    // final 403, so the launch must stop rather than continue (GH#3661).
    const mismatch = step1Source.indexOf("oracleAuthorityMismatch(profile, wallet.publicKey, keeperPubkey)");
    const cosign = step1Source.indexOf('fetch("/api/playground/keeper-cosign"');
    expect(mismatch).toBeGreaterThanOrEqual(0);
    expect(cosign).toBeGreaterThan(mismatch);
    expect(step1Source).toMatch(/if \(strayAuthority\) \{[\s\S]*throw new Error\(/);
  });

  it("step 1 simulates the co-signed hand-off before the wallet prompt", () => {
    const sim = step1Source.indexOf("await presimulateOrThrow(connection, partialTx)");
    const sign = step1Source.indexOf("await wallet.signTransaction(partialTx)");
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sign).toBeGreaterThan(sim);
  });

  it("the batch simulates M1 (the only independent tx) before the one-approval prompt", () => {
    const sim = batchSource.indexOf("await presimulateOrThrow(connection, m1)");
    const sign = batchSource.indexOf("await signAllCompat(wallet, orderedTxs)");
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sign).toBeGreaterThan(sim);
  });

  it("every sequential sendTx simulates before the wallet prompt", () => {
    const calls = hookSource.match(/await sendTx\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("simulateBeforeSign: true");
  });

  it("the sequential catch names the step that failed", () => {
    expect(hookSource).toContain("step: sequentialStepKind(runningStep)");
  });
});
