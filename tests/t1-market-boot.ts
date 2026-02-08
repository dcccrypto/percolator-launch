/**
 * T1: Market Boot — verify market initialization and first crank
 */
import { TestHarness } from "./harness.js";

async function main() {
  const h = new TestHarness();
  console.log("\n=== T1: Market Boot ===\n");

  let ctx: Awaited<ReturnType<typeof h.createFreshMarket>> | null = null;

  try {
    await h.runTest("Create fresh market with admin oracle", async () => {
      ctx = await h.createFreshMarket({ initialPriceE6: "91000000000" }); // $91,000 (BTC-like)
      TestHarness.assert(!!ctx.slab, "Slab keypair exists");
      TestHarness.assert(!!ctx.vault, "Vault created");
    });

    await h.runTest("Slab header is valid", async () => {
      const snap = await h.snapshot(ctx!);
      TestHarness.assert(snap.header.magic !== 0n, "Magic is set");
      TestHarness.assert(
        snap.header.admin.equals(h.payerPubkey),
        "Admin matches payer"
      );
    });

    await h.runTest("Market config is correct", async () => {
      const snap = await h.snapshot(ctx!);
      TestHarness.assert(
        snap.config.collateralMint.equals(ctx!.mint),
        "Collateral mint matches"
      );
      TestHarness.assertEqual(
        Number(snap.params.initialMarginBps),
        1000,
        "Initial margin"
      );
      TestHarness.assertEqual(
        Number(snap.params.maintenanceMarginBps),
        500,
        "Maintenance margin"
      );
      TestHarness.assertEqual(
        Number(snap.params.tradingFeeBps),
        10,
        "Trading fee"
      );
    });

    await h.runTest("Engine state after first crank", async () => {
      const snap = await h.snapshot(ctx!);
      TestHarness.assert(
        snap.engine.lastCrankSlot > 0n,
        "Last crank slot is set"
      );
      TestHarness.assert(
        snap.engine.currentSlot > 0n,
        "Current slot is set"
      );
      TestHarness.assertEqual(
        snap.engine.numUsedAccounts,
        0,
        "No accounts yet"
      );
    });

    await h.runTest("Oracle price is set", async () => {
      const snap = await h.snapshot(ctx!);
      TestHarness.assert(
        snap.config.authorityPriceE6 > 0n,
        "Oracle price is non-zero"
      );
    });

    await h.runTest("Second crank succeeds", async () => {
      await h.keeperCrank(ctx!);
      const snap = await h.snapshot(ctx!);
      TestHarness.assert(
        snap.engine.lastCrankSlot > 0n,
        "Crank slot updated"
      );
    });
  } finally {
    await h.cleanup();
  }

  const summary = h.getSummary();
  console.log(
    `\n  Results: ${summary.passed}/${summary.total} passed, ${summary.failed} failed\n`
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
