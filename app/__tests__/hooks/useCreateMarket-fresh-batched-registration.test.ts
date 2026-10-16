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

  it("UX WP-7: NO signMessage prompt — the proof is a memo inside M1 (the InitMarket tx)", () => {
    expect(freshBatchSource).not.toContain('fetch("/api/markets"');
    expect(freshBatchSource).not.toContain("/api/markets/challenge");
    expect(freshBatchSource).not.toContain("wallet.signMessage(");
    expect(freshBatchSource).not.toContain("buildKeeperRegisterProofMessage");
    // the memo is built from the exact fields the registration POSTs (memo v2: incl. the payload
    // it later sends, security review 2026-09-30 M-1) and rides in M1
    expect(freshBatchSource).toContain("await buildKeeperRegisterMemoIx(walletPk, await keeperMemoParams({ ...keeperRequestBase, payload: keeperPayload }))");
    expect(freshBatchSource).toContain("if (keeperRequestBase && keeperPayload) rememberRegistrationPayload(slabPk.toBase58(), keeperPayload);");
    expect(freshBatchSource).toMatch(/buildM1Instructions\(\{[\s\S]*memo: keeperMemoIx,/);
    // the creation tx signature is kept as the proof
    expect(freshBatchSource).toContain("if (keeperRequestBase) saveProofTx(slabPk.toBase58(), m1Sig);");
  });

  it("the ZOMBIE GUARD, now stricter: nothing registers until the WHOLE launch has landed", () => {
    // Registration writes the markets row, so it must never run for a launch that dies later
    // (ANSEM). It is no longer called inside the batch at all: the hook starts the background
    // loop only on a "success" outcome (after M3a, the insurance check, M4a, M4p, M4b).
    expect(freshBatchSource).not.toContain("registerMarketWithKeeper(");
    expect(freshBatchSource).not.toContain("postKeeperRegistration(");
    expect(freshBatchSource).not.toContain("startKeeperLoop(");
    const createEntry = hookSource.indexOf("async (params: CreateMarketParams, retryFromStep?: number) => {");
    const success = hookSource.indexOf('if (outcome.status === "success") {', createEntry);
    const start = hookSource.indexOf("startKeeperLoop(params, slabKp.publicKey.toBase58())", createEntry);
    expect(success).toBeGreaterThan(createEntry);
    expect(start).toBeGreaterThan(success);
    expect(start - success).toBeLessThan(300);
  });

  it("the stake tail order is unchanged (M4a -> M4p -> M4b); registration no longer constrains it", () => {
    // The proof is the historical creation tx, not the live marketauth, so StakeInitPool rotating
    // marketauth no longer matters to registration.
    const m4a = freshBatchSource.indexOf("const m4aSig = await broadcastTailTx(tailIdx(m4aDescriptor))");
    const m4b = freshBatchSource.indexOf("const m4bSig = await broadcastTailTx(tailIdx(m4bDescriptor))");
    const m4p = freshBatchSource.indexOf("const m4pSig = await broadcastTailTx(tailIdx(m4pDescriptor))");
    expect(m4a).toBeGreaterThan(0);
    expect(m4p).toBeGreaterThan(m4a);
    expect(m4b).toBeGreaterThan(m4p);
  });
});

describe("keeper-market oracle wiring", () => {
  it("attaches a Pyth oracle account ONLY on the pyth path", () => {
    // A keeper market's oracleFeed is the mainnet DEX POOL address, not a Pyth
    // hex feed id. The old gate (!isAdminOracle && !isHyperpOracle) was TRUE for
    // keeper markets, so every keeper launch derived a push-oracle PDA from a
    // pool address and appended that account to its crank.
    expect(hookSource).not.toMatch(
      /if \(!isAdminOracle && !isHyperpOracle\) \{\s*crankKeys\.push/,
    );
    expect(hookSource).toMatch(
      /if \(oracleMode === "pyth"\) \{\s*crankKeys\.push/,
    );
  });

  it("records the crank wallet as oracle_authority for keeper markets", () => {
    // On devnet a keeper market is created in AUTH_MARK/admin mode with its
    // authority DELEGATED to the keeper. Gating on isAdminOracle alone
    // (oracleMode === "admin") excluded exactly those markets, writing
    // oracle_authority=null for the ones the keeper drives.
    // The payload builder moved to lib/market-registration-payload.ts (shared with the cross-device
    // registration recovery, #3267); the rule is unchanged.
    const builderSource = readFileSync(resolve(process.cwd(), "lib/market-registration-payload.ts"), "utf8");
    expect(builderSource).toMatch(
      /oracle_authority: \(isAdminOracle \|\| oracleMode === "keeper"\)/,
    );
    expect(hookSource).toContain('import { buildMarketRegistrationPayload, flooredInitialMarginBps } from "@/lib/market-registration-payload";');
  });
});

describe("P3 wizard wiring (round 4, sequential path)", () => {
  it("binds the vault-owned LP in step 5 BEFORE StakeInitPool rotates marketauth", () => {
    const bind = hookSource.indexOf("P3: bind the vault-owned LP + fund the junior tranche BEFORE StakeInitPool");
    const stake = hookSource.indexOf("const sigStake = await sendTx(");
    expect(bind).toBeGreaterThan(0);
    expect(stake).toBeGreaterThan(bind);
  });
  it("resume: if StakeInitPool already ran without a bound vault LP, stop with the clear error (94 is marketauth-only)", () => {
    const bind = hookSource.indexOf("P3: bind the vault-owned LP + fund the junior tranche BEFORE StakeInitPool");
    const guard = hookSource.indexOf('if (progress === "bind" && existingPool) {', bind);
    const thrown = hookSource.indexOf("throw new Error(LIMITS_COPY.p3Wizard.marketauthRotated);", guard);
    const stakeTail = hookSource.indexOf("const sigStake = await sendTx(", bind);
    expect(guard).toBeGreaterThan(bind);
    expect(thrown).toBeGreaterThan(guard);
    expect(stakeTail).toBeGreaterThan(thrown);
    // the pool read the guard depends on happens BEFORE the bind block
    expect(hookSource.lastIndexOf("const existingPool = await connection.getAccountInfo(stakePoolPda);", bind)).toBeGreaterThan(0);
  });
  it("P3 auto-pin (07a1d0eb): NO creator-owned LP / matcher in either path (M2, sequential step 2, the LP crank)", () => {
    expect(hookSource).toContain("const includeM2 = !params.p3;");
    expect(hookSource).toContain("...(includeM2 ? [m2Descriptor] : []),");
    expect(hookSource).toContain("if (startStep <= 2 && !params.p3) {");
    expect(hookSource).toContain("instructions: params.p3 ? [topupIx] : [topupIx, crankIx],");
    expect(hookSource).toContain("if (isV17SlabDeposit && !params.p3) {");
    // the bind carries the pre-created ctx and signs with it
    expect(hookSource).toContain("signers: [vaultLpPortfolioKp, vaultLpCtxKp!],");
    expect(hookSource).toContain("matcherProgram: canonicalVaultLpMatcher(");
  });
  it("skips the creator-LP deposit under P3 (the junior replaces it) in BOTH paths", () => {
    expect(hookSource).toContain("if (!params.p3 && alreadyDepositedCapital < params.lpCollateral)");
    expect(hookSource).toContain("const includeM3a = !params.p3;");
  });
  it("validates the junior requirement before anything is broadcast", () => {
    const validate = hookSource.indexOf("const issue = validateP3Wizard({");
    const firstBatched = hookSource.indexOf("attemptFreshBatchedLaunch(");
    expect(validate).toBeGreaterThan(0);
    // the create() entry check precedes the create() body that dispatches the batched launch
    const createEntry = hookSource.indexOf("async (params: CreateMarketParams, retryFromStep?: number) => {");
    expect(validate).toBeGreaterThan(createEntry);
    expect(hookSource.indexOf("attemptFreshBatchedLaunch(", createEntry)).toBeGreaterThan(validate);
    expect(firstBatched).toBeGreaterThan(0);
  });
});
