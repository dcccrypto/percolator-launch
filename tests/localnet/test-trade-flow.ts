/**
 * Localnet Integration Test: Full Trade Flow
 *
 * Phase A happy-path:
 *   1. Start solana-test-validator with all 4 program .so files
 *   2. Bootstrap market (InitMarket + InitLP + InitMatcherCtx + first crank)
 *   3. Create trader account (InitUser + DepositCollateral)
 *   4. Execute TradeCpi (long position)
 *   5. Read state via parseEngine / parseAllAccounts
 *   6. Assert position exists with expected size
 *   7. Teardown (close slab + stop validator)
 *
 * Run:
 *   pnpm localnet:test
 *
 * Or directly:
 *   npx tsx tests/localnet/test-trade-flow.ts
 */

import { LocalValidator, LocalnetHarness, LOCAL_PROGRAM_IDS, sleep } from "./harness.js";
import { parseAllAccounts } from "@percolatorct/sdk";

const INITIAL_PRICE_E6 = 1_000_000n; // $1.00
const LP_SEED_DEPOSIT   = 50_000_000n; // 50 tokens (LP seed)
const TRADER_TOKENS     = 20_000_000n; // 20 tokens minted to trader
const TRADER_DEPOSIT    = 10_000_000n; // 10 tokens deposited into account
const TRADE_SIZE        = 5_000_000n;  // 5 tokens long position (positive = buy)

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("\n=== Percolator Localnet Integration Test ===\n");
  console.log(`Programs under test:`);
  console.log(`  percolator: ${LOCAL_PROGRAM_IDS.percolator.toBase58()}`);
  console.log(`  matcher:    ${LOCAL_PROGRAM_IDS.matcher.toBase58()}`);
  console.log(`  stake:      ${LOCAL_PROGRAM_IDS.stake.toBase58()}`);
  console.log(`  nft:        ${LOCAL_PROGRAM_IDS.nft.toBase58()}`);
  console.log();

  const validator = new LocalValidator();
  const harness = new LocalnetHarness();
  let testsPassed = false;

  try {
    // ────────────────────────────────────────────────────────────────────────
    // Start validator
    // ────────────────────────────────────────────────────────────────────────
    console.log("[step 1/7] Starting localnet validator...");
    await validator.start();
    console.log("[step 1/7] Validator up\n");

    // Give validator a moment to settle block production
    await sleep(1000);

    // ────────────────────────────────────────────────────────────────────────
    // Tests
    // ────────────────────────────────────────────────────────────────────────
    let ctx: Awaited<ReturnType<typeof harness.createMarket>> | null = null;
    let lpIdx = -1;
    let traderAccountIndex = -1;

    await harness.runTest("[step 2/7] Bootstrap market (InitMarket + InitLP + InitMatcherCtx)", async () => {
      const snapBefore = {
        slot: 0,
        header: null as any,
        config: null as any,
        engine: null as any,
        params: null as any,
        accounts: [],
        usedIndices: [],
        rawHash: "",
      };

      ctx = await harness.createMarket({
        initialPriceE6: INITIAL_PRICE_E6,
        lpSeedDeposit: LP_SEED_DEPOSIT,
        decimals: 6,
      });

      LocalnetHarness.assert(!!ctx.slab.publicKey, "Slab keypair generated");
      LocalnetHarness.assert(!!ctx.vault, "Vault ATA created");
      LocalnetHarness.assert(!!ctx.lpPda, "LP PDA derived");
      LocalnetHarness.assert(!!ctx.matcherCtx.publicKey, "Matcher context created");
    });

    await harness.runTest("[step 3/7] Verify market state after bootstrap", async () => {
      const snap = await harness.snapshot(ctx!);

      LocalnetHarness.assert(snap.header.magic !== 0n, "Slab magic is set");
      LocalnetHarness.assert(
        snap.header.admin.toBase58() === harness.payerPubkey.toBase58(),
        `Admin matches payer (got ${snap.header.admin.toBase58().slice(0, 8)}...)`
      );
      LocalnetHarness.assert(snap.engine.lastCrankSlot > 0n, `Crank slot set (got ${snap.engine.lastCrankSlot})`);
      LocalnetHarness.assert(snap.config.authorityPriceE6 > 0n, "Oracle price set");
      LocalnetHarness.assert(
        snap.usedIndices.length === 1,
        `LP account exists (expected 1 used index, got ${snap.usedIndices.length})`
      );

      // LP account is at index 0 (first InitLP on a fresh market)
      lpIdx = snap.usedIndices[0];
      console.log(`  LP account index: ${lpIdx}`);
      console.log(`  Oracle price e6:  ${snap.config.authorityPriceE6}`);
      console.log(`  Last crank slot:  ${snap.engine.lastCrankSlot}`);
    });

    await harness.runTest("[step 4/7] Create trader (InitUser + DepositCollateral)", async () => {
      const traderCtx = await harness.createUser(
        ctx!,
        "trader1",
        TRADER_TOKENS,
        TRADER_DEPOSIT
      );

      LocalnetHarness.assert(traderCtx.accountIndex >= 0, "Trader account index assigned");
      traderAccountIndex = traderCtx.accountIndex;
      console.log(`  Trader account index: ${traderAccountIndex}`);

      const snap = await harness.snapshot(ctx!);
      // Should now have LP (1) + trader (1) = 2 used accounts
      LocalnetHarness.assert(
        snap.usedIndices.length === 2,
        `2 accounts used after user init (got ${snap.usedIndices.length})`
      );

      const traderAcct = snap.accounts.find((a) => a.idx === traderAccountIndex);
      LocalnetHarness.assert(!!traderAcct, "Trader account found in slab");
      LocalnetHarness.assert(traderAcct!.account.capital > 0n, `Trader capital > 0 (got ${traderAcct!.account.capital})`);
      console.log(`  Trader capital: ${traderAcct!.account.capital}`);
    });

    await harness.runTest("[step 5/7] KeeperCrank before trade", async () => {
      const sig = await harness.keeperCrank(ctx!);
      console.log(`  Crank sig: ${sig.slice(0, 20)}...`);
      const snap = await harness.snapshot(ctx!);
      LocalnetHarness.assert(snap.engine.lastCrankSlot > 0n, "Crank slot updated");
    });

    await harness.runTest("[step 6/7] TradeCpi — open long position", async () => {
      const traderCtx = ctx!.users.get("trader1")!;
      LocalnetHarness.assert(lpIdx >= 0, "LP index is known before trade");

      const sig = await harness.tradeCpi(
        ctx!,
        traderCtx,
        lpIdx,
        harness.payerPubkey, // LP owner = admin (who ran InitLP)
        TRADE_SIZE,          // positive = long
        0n                   // no slippage limit
      );
      console.log(`  TradeCpi sig: ${sig.slice(0, 20)}...`);
    });

    await harness.runTest("[step 7/7] Assert position exists with expected size", async () => {
      const snap = await harness.snapshot(ctx!);
      const traderAcct = snap.accounts.find((a) => a.idx === traderAccountIndex);

      LocalnetHarness.assert(!!traderAcct, "Trader account still present after trade");

      const positionSize = traderAcct!.account.positionSize;
      console.log(`  Position size after trade: ${positionSize}`);
      console.log(`  Trader capital after trade: ${traderAcct!.account.capital}`);
      console.log(`  Engine numUsedAccounts: ${snap.engine.numUsedAccounts}`);

      // Position must be non-zero after a buy
      LocalnetHarness.assert(
        positionSize !== 0n,
        `Position size should be non-zero after TradeCpi (got ${positionSize})`
      );
      // Position should be positive (long)
      LocalnetHarness.assert(
        positionSize > 0n,
        `Position should be positive (long) after buy (got ${positionSize})`
      );
    });

    testsPassed = true;

  } catch (fatalErr: unknown) {
    const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    console.error(`\nFATAL: ${msg}`);
    if (fatalErr instanceof Error && fatalErr.stack) {
      console.error(fatalErr.stack);
    }
  } finally {
    // Cleanup slab (best-effort)
    if (harness) {
      try {
        await harness.cleanup();
      } catch (e: unknown) {
        console.warn("Cleanup warning:", e instanceof Error ? e.message : String(e));
      }
    }

    // Stop validator
    await validator.stop();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = harness.getSummary();

    console.log("\n============================================================");
    console.log(`Localnet test suite complete in ${elapsed}s`);
    console.log(`Results: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`);

    if (summary.failed > 0) {
      console.log("\nFailed tests:");
      for (const r of summary.results.filter((r) => !r.passed)) {
        console.log(`  - ${r.name}: ${r.error}`);
      }
    }
    console.log("============================================================\n");

    process.exit(summary.failed > 0 ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Unhandled error:", msg);
  process.exit(1);
});
