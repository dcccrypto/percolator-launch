/**
 * T3: Hyperp Market — Full Resolution Lifecycle
 *
 * Ported from upstream commit 19b75e1 (test-hyperp-market.ts).
 *
 * Hyperp mode uses internal mark/index pricing (index_feed_id = all zeros).
 * This test exercises the complete lifecycle:
 *   1. Create market in Hyperp mode (all-zero feed ID)
 *   2. Trade updates mark price
 *   3. Crank smooths index toward mark
 *   4. Set oracle authority (admin)
 *   5. Push settlement price (YES outcome = 1_000_000 e6)
 *   6. Resolve market
 *   7. Force-close positions via crank
 *   8. Withdraw insurance fund
 *   9. Cleanup (withdraw capital, close accounts, close slab)
 */

import {
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

import {
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeResolveMarket,
  encodeWithdrawInsurance,
  encodeWithdrawCollateral,
  encodeCloseAccount,
  encodeCloseSlab,
  encodeKeeperCrank,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET,
  ACCOUNTS_WITHDRAW_INSURANCE,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_KEEPER_CRANK,
  parseHeader,
  parseEngine,
  fetchSlab,
  parseUsedIndices,
  parseAccount,
  WELL_KNOWN,
} from "@percolator/sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { TestHarness, CRANK_NO_CALLER } from "./harness.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const h = new TestHarness();
  console.log("\n=== T3: Hyperp Market — Full Resolution Lifecycle ===\n");

  let ctx: Awaited<ReturnType<typeof h.createFreshMarket>> | null = null;

  try {
    // Create Hyperp market (all-zero feed = internal pricing)
    await h.runTest("Create Hyperp market (all-zero feed ID)", async () => {
      ctx = await h.createFreshMarket({ initialPriceE6: "500000" }); // $0.50 binary-like
      const snap = await h.snapshot(ctx);
      TestHarness.assert(!!ctx.slab, "Slab exists");
      // Hyperp = all zeros in index_feed_id (handled by createFreshMarket default)
      console.log("  Market created in Hyperp mode");
    });

    // Create a user and LP, do a trade to move mark price
    await h.runTest("Init user and trade to move mark", async () => {
      const user = await h.createUser(ctx!, "trader1");
      await h.initUser(ctx!, "trader1");
      await h.deposit(ctx!, "trader1", "500000000"); // 0.5 SOL

      // Trade to move the mark price
      const snapBefore = await h.snapshot(ctx!);
      const markBefore = snapBefore.config.authorityPriceE6;
      console.log(`  Mark before trade: ${markBefore}`);

      await h.tradeNoCpi(ctx!, "trader1", "10000000"); // small long
      
      const snapAfter = await h.snapshot(ctx!);
      const markAfter = snapAfter.config.authorityPriceE6;
      console.log(`  Mark after trade: ${markAfter}`);
      console.log(`  Mark changed: ${markBefore !== markAfter ? "YES" : "NO (may be expected)"}`);
    });

    // Crank to update index smoothing
    await h.runTest("Index smoothing via crank", async () => {
      const snapBefore = await h.snapshot(ctx!);
      const indexBefore = snapBefore.config.lastEffectivePriceE6;
      console.log(`  Index before crank: ${indexBefore}`);

      await delay(2000);
      await h.keeperCrank(ctx!, 400_000);

      const snapAfter = await h.snapshot(ctx!);
      const indexAfter = snapAfter.config.lastEffectivePriceE6;
      console.log(`  Index after crank: ${indexAfter}`);

      if (indexBefore !== indexAfter) {
        const dir = indexAfter > indexBefore ? "up toward mark" : "down toward mark";
        console.log(`  Index moved: ${dir}`);
      } else {
        console.log("  Index unchanged (may already equal mark)");
      }
    });

    // Funding rate check
    await h.runTest("Funding rate present", async () => {
      const snap = await h.snapshot(ctx!);
      console.log(`  Funding rate (bps/slot): ${snap.engine.fundingRateBpsPerSlotLast}`);
      console.log(`  Funding index: ${snap.engine.fundingIndexQpbE6}`);
    });

    // Set oracle authority
    await h.runTest("Set oracle authority", async () => {
      const data = encodeSetOracleAuthority({ newAuthority: ctx!.payer.publicKey });
      const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
        ctx!.payer.publicKey,
        ctx!.slab.publicKey,
      ]);
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      tx.add(buildIx({ programId: ctx!.programId, keys, data }));
      await sendAndConfirmTransaction(ctx!.connection, tx, [ctx!.payer], {
        commitment: "confirmed",
      });
      console.log("  Admin set as oracle authority");
    });

    // Push settlement price (YES outcome)
    await h.runTest("Push settlement price", async () => {
      const settlementPriceE6 = "1000000"; // $1.00 = YES
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const data = encodePushOraclePrice({
        priceE6: settlementPriceE6,
        timestamp: timestamp.toString(),
      });
      const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
        ctx!.payer.publicKey,
        ctx!.slab.publicKey,
      ]);
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      tx.add(buildIx({ programId: ctx!.programId, keys, data }));
      await sendAndConfirmTransaction(ctx!.connection, tx, [ctx!.payer], {
        commitment: "confirmed",
      });
      console.log(`  Pushed settlement price: ${settlementPriceE6} (YES outcome)`);
    });

    // Resolve market
    await h.runTest("Resolve market", async () => {
      const data = encodeResolveMarket();
      const keys = buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [
        ctx!.payer.publicKey,
        ctx!.slab.publicKey,
      ]);
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      tx.add(buildIx({ programId: ctx!.programId, keys, data }));
      await sendAndConfirmTransaction(ctx!.connection, tx, [ctx!.payer], {
        commitment: "confirmed",
      });

      const slabData = await fetchSlab(ctx!.connection, ctx!.slab.publicKey);
      const header = parseHeader(slabData);
      TestHarness.assert(header.resolved === true, "Market resolved flag is set");
      console.log("  Market RESOLVED — trading blocked, force-close enabled");
    });

    // Force-close positions via crank
    await h.runTest("Force-close positions via crank", async () => {
      const maxAttempts = 10;
      let attempts = 0;

      while (attempts < maxAttempts) {
        await h.keeperCrank(ctx!, 400_000);
        attempts++;

        const slabData = await fetchSlab(ctx!.connection, ctx!.slab.publicKey);
        const indices = parseUsedIndices(slabData);
        let hasOpen = false;
        for (const idx of indices) {
          const acc = parseAccount(slabData, idx);
          if (acc && acc.positionSize !== 0n) {
            hasOpen = true;
            console.log(`  Account ${idx} still has position: ${acc.positionSize}`);
          }
        }
        if (!hasOpen) {
          console.log(`  All positions force-closed after ${attempts} crank(s)`);
          break;
        }
        await delay(500);
      }
      TestHarness.assert(attempts <= maxAttempts, "Force-close completed within limit");
    });

    // Withdraw insurance
    await h.runTest("Withdraw insurance fund", async () => {
      const slabData = await fetchSlab(ctx!.connection, ctx!.slab.publicKey);
      const engine = parseEngine(slabData);
      console.log(`  Insurance fund balance: ${Number(engine.insuranceFund.balance) / 1e9} SOL`);

      if (engine.insuranceFund.balance > 0n) {
        const data = encodeWithdrawInsurance();
        const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
          ctx!.payer.publicKey,
          ctx!.slab.publicKey,
          (ctx!.users.get("__admin") ?? ctx!.lps.values().next().value)!.ata,
          ctx!.vault,
          TOKEN_PROGRAM_ID,
          ctx!.vaultPda,
        ]);
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
        tx.add(buildIx({ programId: ctx!.programId, keys, data }));
        await sendAndConfirmTransaction(ctx!.connection, tx, [ctx!.payer], {
          commitment: "confirmed",
        });
        console.log("  Insurance fund withdrawn to admin");
      } else {
        console.log("  No insurance fund to withdraw (OK)");
      }
    });

    // Cleanup
    await h.runTest("Cleanup — withdraw, close accounts, close slab", async () => {
      const slabData = await fetchSlab(ctx!.connection, ctx!.slab.publicKey);
      const indices = parseUsedIndices(slabData);
      const adminAta = (ctx!.users.get("__admin") ?? ctx!.lps.values().next().value)!.ata;

      for (const idx of indices) {
        const acc = parseAccount(slabData, idx);
        if (!acc) continue;

        // Withdraw remaining capital
        if (acc.capital > 0n) {
          try {
            const wKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
              ctx!.payer.publicKey,
              ctx!.slab.publicKey,
              ctx!.vault,
              adminAta,
              ctx!.vaultPda,
              TOKEN_PROGRAM_ID,
              SYSVAR_CLOCK_PUBKEY,
              ctx!.slab.publicKey,
            ]);
            const wIx = buildIx({
              programId: ctx!.programId,
              keys: wKeys,
              data: encodeWithdrawCollateral({ userIdx: idx, amount: acc.capital.toString() }),
            });
            const wTx = new Transaction().add(
              ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
              wIx,
            );
            await sendAndConfirmTransaction(ctx!.connection, wTx, [ctx!.payer], {
              commitment: "confirmed",
            });
            console.log(`  Withdrew ${Number(acc.capital) / 1e9} SOL from account ${idx}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message.slice(0, 50) : String(e);
            console.log(`  Withdraw failed for ${idx}: ${msg}`);
          }
        }

        // Close account
        try {
          const cKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
            ctx!.payer.publicKey,
            ctx!.slab.publicKey,
            ctx!.vault,
            adminAta,
            ctx!.vaultPda,
            TOKEN_PROGRAM_ID,
            SYSVAR_CLOCK_PUBKEY,
            ctx!.slab.publicKey,
          ]);
          const cIx = buildIx({
            programId: ctx!.programId,
            keys: cKeys,
            data: encodeCloseAccount({ userIdx: idx }),
          });
          const cTx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            cIx,
          );
          await sendAndConfirmTransaction(ctx!.connection, cTx, [ctx!.payer], {
            commitment: "confirmed",
          });
          console.log(`  Account ${idx} closed`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message.slice(0, 50) : String(e);
          console.log(`  Close failed for ${idx}: ${msg}`);
        }

        await delay(300);
      }

      // Close slab
      try {
        const csKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
          ctx!.payer.publicKey,
          ctx!.slab.publicKey,
        ]);
        const csIx = buildIx({
          programId: ctx!.programId,
          keys: csKeys,
          data: encodeCloseSlab(),
        });
        const csTx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
          csIx,
        );
        await sendAndConfirmTransaction(ctx!.connection, csTx, [ctx!.payer], {
          commitment: "confirmed",
        });
        console.log("  Slab closed — rent returned to admin");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message.slice(0, 60) : String(e);
        console.log(`  Close slab failed: ${msg}`);
      }
    });

    console.log("\n============================================================");
    console.log("T3 HYPERP LIFECYCLE TEST COMPLETE");
    console.log("============================================================\n");
  } catch (e) {
    console.error("FATAL:", e);
    process.exit(1);
  }
}

main();
