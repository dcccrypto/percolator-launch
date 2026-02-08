/**
 * T2: User Lifecycle — init user, deposit, withdraw, close
 */
import { TestHarness } from "./harness.js";

async function main() {
  const h = new TestHarness();
  console.log("\n=== T2: User Lifecycle ===\n");

  let ctx: Awaited<ReturnType<typeof h.createFreshMarket>> | null = null;

  try {
    ctx = await h.createFreshMarket({ initialPriceE6: "1000000" }); // $1.00

    await h.runTest("Create and init user", async () => {
      const user = await h.createUser(ctx!, "alice", 10_000_000n); // 10 tokens
      await h.initUser(ctx!, user);
      TestHarness.assert(user.accountIndex >= 0, "Account index assigned");

      const snap = await h.snapshot(ctx!);
      TestHarness.assertEqual(snap.engine.numUsedAccounts, 1, "1 account used");
    });

    await h.runTest("Deposit collateral", async () => {
      const alice = ctx!.users.get("alice")!;
      await h.deposit(ctx!, alice, "5000000"); // 5 tokens

      const snap = await h.snapshot(ctx!);
      const acct = snap.accounts.find((a) => a.idx === alice.accountIndex);
      TestHarness.assert(!!acct, "Account found in slab");
      // Capital should be > 0 (initial fee payment + deposit)
      TestHarness.assert(acct!.account.capital > 0n, "Capital is positive");
    });

    await h.runTest("Crank after deposit", async () => {
      await h.keeperCrank(ctx!);
    });

    await h.runTest("Withdraw collateral", async () => {
      const alice = ctx!.users.get("alice")!;
      await h.withdraw(ctx!, alice, "1000000"); // 1 token
    });

    await h.runTest("Create second user", async () => {
      const bob = await h.createUser(ctx!, "bob", 10_000_000n);
      await h.initUser(ctx!, bob);

      const snap = await h.snapshot(ctx!);
      TestHarness.assertEqual(snap.engine.numUsedAccounts, 2, "2 accounts");
    });

    await h.runTest("Create LP", async () => {
      const lp = await h.createUser(ctx!, "lp1", 100_000_000n); // 100 tokens
      // Init as regular user first (LP init requires matcher setup)
      await h.initUser(ctx!, lp);

      const snap = await h.snapshot(ctx!);
      TestHarness.assertEqual(snap.engine.numUsedAccounts, 3, "3 accounts");
    });
  } finally {
    if (ctx) await h.cleanup();
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
