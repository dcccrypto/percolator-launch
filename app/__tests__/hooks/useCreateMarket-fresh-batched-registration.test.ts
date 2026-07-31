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

  it("registers in exactly ONE call, with no dead markets-challenge signature", () => {
    // Registration was consolidated onto keeper-register, which writes the
    // markets row under the on-chain marketauth proof. POST /api/markets and
    // its separate nonce+signature challenge are gone — that challenge cost the
    // user a second wallet prompt whose result fed nothing.
    expect(freshBatchSource).not.toContain('fetch("/api/markets"');
    expect(freshBatchSource).not.toContain("marketsNonce");
    expect(freshBatchSource).not.toContain("marketsSignature");
    expect(freshBatchSource).not.toContain("/api/markets/challenge");

    // The keeper proof is the one remaining signature.
    expect(freshBatchSource).toContain("keeper-register:");
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
    // keeper-register now writes the markets row, so THE REGISTRATION CALL is
    // what must come after M3a. It used to be created before M2, which was safe
    // only while it wrote nothing but the keeper's blob.
    const m3a = freshBatchSource.indexOf("const m3aSig = await broadcastTailTx(2)");
    const register = freshBatchSource.indexOf("const keeperRegisterPromise");
    expect(m3a).toBeGreaterThanOrEqual(0);
    expect(register).toBeGreaterThan(m3a);
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

  it("keeps registration to a single call site in the batched path", () => {
    // Two registration writes to two stores is what let the creator's metadata
    // lose to the indexer. One call, one store.
    const calls = freshBatchSource.match(/registerMarketWithKeeper\(/g) ?? [];
    expect(calls.length).toBe(1);
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
    expect(hookSource).toMatch(
      /oracle_authority: \(isAdminOracle \|\| oracleMode === "keeper"\)/,
    );
  });
});
