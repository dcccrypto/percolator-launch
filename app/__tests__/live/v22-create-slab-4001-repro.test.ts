// @vitest-environment node
/**
 * OPT-IN, READ-ONLY repro of the v2.2 "Create slab & initialize market" instant 4001 (QA, 2026-10-15).
 * Builds the sequential step-0 transaction the way useCreateMarket + sendTx build it (heap frame, CU limit, CU price,
 * createAccount, vault ATA, InitMarket v2.2, keeper memo), reports its wire size and simulates it on devnet.
 *   V22_REPRO=1 V22_REPRO_RPC=... V22_REPRO_PAYER=<funded devnet pubkey> npx vitest run __tests__/live/v22-create-slab-4001-repro.test.ts
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from "@solana/spl-token";

const ON = process.env.V22_REPRO === "1";
const OUT = (m: string) => fs.appendFileSync(process.env.V22_REPRO_OUT ?? "/tmp/v22-repro.log", m + "\n");

describe.skipIf(!ON)("v2.2 create step 0: size + devnet simulation", () => {
  it("builds and simulates", async () => {
    const { slabSizeFor, buildV17InitMarketArgs } = await import("@/lib/create-market-args");
    const { deriveLaunchMarketParams } = await import("@/lib/market-params");
    const { defaultGrowthLaunch } = await import("@/lib/v21/growth-launch");
    const { planLaunchV22, toLaunchParams } = await import("@/lib/v22/launch-plan");
    const { encodeInitMarketDataWithV22 } = await import("@/lib/v22/launch-wire");
    const { buildKeeperRegisterMemoIx } = await import("@/lib/keeper-register-memo");
    const sdk = await import("@percolatorct/sdk");

    const conn = new Connection(process.env.V22_REPRO_RPC!, "confirmed");
    const programId = new PublicKey(process.env.NEXT_PUBLIC_WRAPPER_PROGRAM_ID!);
    const mint = new PublicKey(process.env.NEXT_PUBLIC_TEST_USDC_MINT!);
    const payer = new PublicKey(process.env.V22_REPRO_PAYER!);
    const slabKp = Keypair.generate();
    const [vaultPda] = sdk.deriveVaultAuthority(programId, slabKp.publicKey);
    const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);

    const tokenPriceE6 = BigInt(process.env.V22_REPRO_PRICE_E6 ?? "20000000");
    const derivedW = deriveLaunchMarketParams({ initialMarginBps: 2000, lpCollateral: 0n, initialPriceE6: 1_000_000n });
    const growth = { ...defaultGrowthLaunch({ engineImrBps: derivedW.initialMarginBps, maintenanceMarginBps: derivedW.maintenanceMarginBps, maxPriceMoveBpsPerSlot: derivedW.maxPriceMoveBpsPerSlot, baseFeeBps: 30 }), collateralDecimals: 6 };
    const plan = planLaunchV22({ tokenPriceE6, collateralDecimals: 6, collateralSymbol: "USDC", oracleMode: "keeper", growthOn: true });
    const v22 = toLaunchParams(plan);
    const params = {
      mint, initialPriceE6: tokenPriceE6 * 10n ** BigInt(v22?.lotExp ?? 0), lpCollateral: 1_000_000_000n, insuranceAmount: 100_000_000n,
      oracleFeed: "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump", invert: false, tradingFeeBps: 30, initialMarginBps: 2000,
      p3: { juniorFloorBps: 1000, juniorAtoms: 1_000_000_000n }, growth, v22,
    } as never;
    const derived = deriveLaunchMarketParams(params);
    const space = slabSizeFor(params);
    const rent = await conn.getMinimumBalanceForRentExemption(space);
    const initData = encodeInitMarketDataWithV22(buildV17InitMarketArgs(params, derived), growth as never, v22);
    const initIx = sdk.buildIx({ programId, keys: sdk.buildAccountMetas(sdk.ACCOUNTS_INIT_MARKET, { admin: payer, slab: slabKp.publicKey, mint }), data: initData });
    const memo = await buildKeeperRegisterMemoIx(payer, { slabAddress: slabKp.publicKey.toBase58(), mainnetCA: "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump", dexPoolAddress: "3KFCgJ5R3zshW8hTDbzjSrrKSRYmKvsMfhc4Vo4iddxD", dexType: "pumpswap", symbol: "QA", payload: null } as never);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: slabKp.publicKey, lamports: rent, space, programId }));
    tx.add(createAssociatedTokenAccountInstruction(payer, vaultAta, vaultPda, mint));
    tx.add(initIx, memo);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
    const bal = await conn.getBalance(payer);
    OUT(JSON.stringify({
      space, rentSol: rent / 1e9, payerSol: bal / 1e9, lotExp: v22?.lotExp, initDataLen: initData.length, memoLen: memo.data.length,
      wireBytes: wire.length, signers: tx.compileMessage().header.numRequiredSignatures,
      simErr: sim.value.err, units: sim.value.unitsConsumed, logs: (sim.value.logs ?? []).slice(-8),
    }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(wire.length).toBeGreaterThan(0);
  }, 60_000);
});
