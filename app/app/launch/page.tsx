"use client";

import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeUpdateConfig,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_UPDATE_CONFIG,
  buildAccountMetas,
  deriveVaultAuthority,
  deriveLpPda,
  buildIx,
  getAta,
} from "@percolator/core";
import { getConfig } from "@/lib/config";
import { useQuickLaunch } from "@/hooks/useQuickLaunch";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
}

interface DeployStep {
  label: string;
  status: "pending" | "active" | "done" | "error";
  sig?: string;
  error?: string;
}

export default function LaunchPage() {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [activeTab, setActiveTab] = useState<"quick" | "advanced">("quick");
  const [step, setStep] = useState(0); // 0=token, 1=params, 2=deploy, 3=done
  const [mintInput, setMintInput] = useState("");
  const [quickMint, setQuickMint] = useState<string | null>(null);
  const quickLaunch = useQuickLaunch(quickMint);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [fetchingToken, setFetchingToken] = useState(false);
  const [tokenError, setTokenError] = useState("");

  // Params
  const [initialPrice, setInitialPrice] = useState("1.00");
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [tradingFeeBps, setTradingFeeBps] = useState(10);
  const [lpCollateral, setLpCollateral] = useState("1000000");
  const maxAccounts = 4096; // Fixed by on-chain program

  // Deploy
  const [deploySteps, setDeploySteps] = useState<DeployStep[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [slabAddress, setSlabAddress] = useState("");
  const [slabKeypair, setSlabKeypair] = useState<Keypair | null>(null);
  const [recovering, setRecovering] = useState(false);

  // Helper: send tx and confirm with proper blockhash ordering
  const sendAndConfirm = useCallback(async (tx: Transaction, signers?: Keypair[]) => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = publicKey!;
    if (signers) signers.forEach((s) => tx.partialSign(s));
    if (!signTransaction) throw new Error("Wallet does not support signTransaction");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  }, [connection, publicKey, signTransaction]);

  // Recover SOL from failed slab — closes the account and returns rent to wallet
  const recoverSlab = useCallback(async () => {
    if (!publicKey || !slabKeypair) return;
    setRecovering(true);
    try {
      const slabPk = slabKeypair.publicKey;
      const info = await connection.getAccountInfo(slabPk);
      if (!info) {
        alert("Slab account not found — SOL may have already been recovered.");
        setRecovering(false);
        return;
      }

      // Transfer all lamports from slab to wallet, then assign to system program
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
      // We need to use the system program to transfer lamports and close
      // Since the slab is owned by the percolator program after init, we can only close
      // if the market hasn't been initialized. If it has, use CloseSlab instruction.
      const config = getConfig();
      const programId = new PublicKey(config.programId);

      if (info.owner.equals(programId)) {
        // Market was initialized — use CloseSlab instruction (tag 13)
        // CloseSlab: admin(signer,writable) + slab(writable)
        const closeData = new Uint8Array([13]); // CloseSlab tag
        tx.add({
          programId,
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: slabPk, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(closeData),
        });
      } else {
        // Still owned by system program — just transfer lamports back
        tx.add(SystemProgram.transfer({
          fromPubkey: slabPk,
          toPubkey: publicKey,
          lamports: info.lamports,
        }));
      }

      await sendAndConfirm(tx, info.owner.equals(programId) ? [] : [slabKeypair]);
      alert(`Recovered ${(info.lamports / 1e9).toFixed(4)} SOL!`);
      setSlabKeypair(null);
      setStep(0);
      setDeploySteps([]);
    } catch (e) {
      console.error("Recovery error:", e);
      alert(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRecovering(false);
    }
  }, [publicKey, slabKeypair, connection, sendAndConfirm]);

  const fetchToken = useCallback(async () => {
    setFetchingToken(true);
    setTokenError("");
    try {
      const mintPk = new PublicKey(mintInput);
      const info = await connection.getParsedAccountInfo(mintPk);
      if (!info.value) throw new Error("Mint not found");

      const parsed = (info.value.data as any)?.parsed;
      if (!parsed || parsed.type !== "mint") throw new Error("Not a valid SPL token mint");

      const decimals = parsed.info.decimals;

      // Try Jupiter price
      let price = "1.00";
      try {
        const resp = await fetch(`https://api.jup.ag/price/v2?ids=${mintInput}`);
        const data = await resp.json();
        if (data.data?.[mintInput]?.price) {
          price = parseFloat(data.data[mintInput].price).toFixed(6);
        }
      } catch { /* use default */ }

      setTokenInfo({
        mint: mintInput,
        name: `Token ${mintInput.slice(0, 6)}`,
        symbol: mintInput.slice(0, 4).toUpperCase(),
        decimals,
      });
      setInitialPrice(price);
      setStep(1);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : "Invalid mint");
    } finally {
      setFetchingToken(false);
    }
  }, [mintInput, connection]);

  const deploy = useCallback(async () => {
    if (!publicKey || !tokenInfo) return;
    setDeploying(true);
    setStep(2);

    const config = getConfig();
    const programId = new PublicKey(config.programId);
    const matcherProgramId = new PublicKey(config.matcherProgramId);
    const collateralMint = new PublicKey(tokenInfo.mint);
    const slabSize = config.slabSize;

    const steps: DeployStep[] = [
      { label: "Create slab account", status: "pending" },
      { label: "Create vault ATA", status: "pending" },
      { label: "Initialize market", status: "pending" },
      { label: "Set oracle authority", status: "pending" },
      { label: "Push initial price", status: "pending" },
      { label: "Set funding parameters", status: "pending" },
      { label: "Initial crank", status: "pending" },
      { label: "Create matcher context", status: "pending" },
      { label: "Initialize LP", status: "pending" },
      { label: "Deposit LP collateral", status: "pending" },
      { label: "Final crank", status: "pending" },
    ];
    setDeploySteps([...steps]);

    const updateStep = (idx: number, update: Partial<DeployStep>) => {
      steps[idx] = { ...steps[idx], ...update };
      setDeploySteps([...steps]);
    };

    try {
      // Step 0: Create slab
      updateStep(0, { status: "active" });
      const slab = Keypair.generate();
      setSlabKeypair(slab);
      const rentExempt = await connection.getMinimumBalanceForRentExemption(slabSize);

      const createSlabTx = new Transaction();
      createSlabTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      createSlabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      createSlabTx.add(SystemProgram.createAccount({
        fromPubkey: publicKey,
        newAccountPubkey: slab.publicKey,
        lamports: rentExempt,
        space: slabSize,
        programId,
      }));
      const sig0 = await sendAndConfirm(createSlabTx, [slab]);
      updateStep(0, { status: "done", sig: sig0 });

      const slabPk = slab.publicKey;
      setSlabAddress(slabPk.toBase58());

      // Step 1: Vault ATA
      updateStep(1, { status: "active" });
      const [vaultPda] = deriveVaultAuthority(programId, slabPk);
      const { getAssociatedTokenAddress: getATA, createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
      // vaultPda is off-curve (PDA), so we need allowOwnerOffCurve = true
      const vaultAta = await getATA(collateralMint, vaultPda, true);
      const createAtaTx = new Transaction();
      createAtaTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      createAtaTx.add(createAssociatedTokenAccountInstruction(publicKey, vaultAta, vaultPda, collateralMint));
      const sig1 = await sendAndConfirm(createAtaTx);
      updateStep(1, { status: "done", sig: sig1 });

      // Step 2: Init market
      updateStep(2, { status: "active" });
      const priceE6 = Math.round(parseFloat(initialPrice) * 1_000_000).toString();
      const initialMarginBps = Math.round(10000 / maxLeverage).toString();
      const maintenanceMarginBps = Math.round(10000 / maxLeverage / 2).toString();

      const initMarketData = encodeInitMarket({
        admin: publicKey,
        collateralMint,
        indexFeedId: "0".repeat(64),
        maxStalenessSecs: "86400",
        confFilterBps: 0,
        invert: 1,
        unitScale: 0,
        initialMarkPriceE6: priceE6,
        warmupPeriodSlots: "100",
        maintenanceMarginBps,
        initialMarginBps,
        tradingFeeBps: tradingFeeBps.toString(),
        maxAccounts: maxAccounts.toString(),
        newAccountFee: "1000000",
        riskReductionThreshold: "0",
        maintenanceFeePerSlot: "0",
        maxCrankStalenessSlots: "400",
        liquidationFeeBps: "100",
        liquidationFeeCap: "100000000000",
        liquidationBufferBps: "50",
        minLiquidationAbs: "1000000",
      });
      const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
        publicKey, slabPk, collateralMint, vaultAta,
        TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
        vaultPda, SystemProgram.programId,
      ]);
      const initTx = new Transaction();
      initTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      initTx.add(buildIx({ programId, keys: initMarketKeys, data: initMarketData }));
      const sig2 = await sendAndConfirm(initTx);
      updateStep(2, { status: "done", sig: sig2 });

      // Step 3: Set oracle authority
      updateStep(3, { status: "active" });
      const setAuthTx = new Transaction();
      setAuthTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      setAuthTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      setAuthTx.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [publicKey, slabPk]),
        data: encodeSetOracleAuthority({ newAuthority: publicKey }),
      }));
      const sig3 = await sendAndConfirm(setAuthTx);
      updateStep(3, { status: "done", sig: sig3 });

      // Step 4: Push price
      updateStep(4, { status: "active" });
      const now = Math.floor(Date.now() / 1000);
      const pushTx = new Transaction();
      pushTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      pushTx.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [publicKey, slabPk]),
        data: encodePushOraclePrice({ priceE6, timestamp: now.toString() }),
      }));
      const sig4 = await sendAndConfirm(pushTx);
      updateStep(4, { status: "done", sig: sig4 });

      // Step 5: Funding params
      updateStep(5, { status: "active" });
      const cfgTx = new Transaction();
      cfgTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      cfgTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      cfgTx.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [publicKey, slabPk]),
        data: encodeUpdateConfig({
          fundingHorizonSlots: "500",
          fundingKBps: "100",
          fundingInvScaleNotionalE6: "1000000000000",
          fundingMaxPremiumBps: "500",
          fundingMaxBpsPerSlot: "5",
          threshFloor: "0",
          threshRiskBps: "50",
          threshUpdateIntervalSlots: "10",
          threshStepBps: "500",
          threshAlphaBps: "1000",
          threshMin: "0",
          threshMax: "10000000000000000000",
          threshMinStep: "1",
        }),
      }));
      const sig5 = await sendAndConfirm(cfgTx);
      updateStep(5, { status: "done", sig: sig5 });

      // Step 6: Initial crank
      updateStep(6, { status: "active" });
      const crank1Tx = new Transaction();
      crank1Tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      crank1Tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      crank1Tx.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [publicKey, slabPk, SYSVAR_CLOCK_PUBKEY, slabPk]),
        data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
      }));
      const sig6 = await sendAndConfirm(crank1Tx);
      updateStep(6, { status: "done", sig: sig6 });

      // Step 7: Create matcher context
      updateStep(7, { status: "active" });
      const matcherCtxKp = Keypair.generate();
      const matcherRent = await connection.getMinimumBalanceForRentExemption(config.matcherCtxSize);
      const createMatcherTx = new Transaction();
      createMatcherTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      createMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      createMatcherTx.add(SystemProgram.createAccount({
        fromPubkey: publicKey,
        newAccountPubkey: matcherCtxKp.publicKey,
        lamports: matcherRent,
        space: config.matcherCtxSize,
        programId: matcherProgramId,
      }));

      // Init vAMM — use Uint8Array + DataView (browser-safe, no Buffer.writeBigUInt64LE)
      const lpIndex = 0;
      const [lpPda] = deriveLpPda(programId, slabPk, lpIndex);
      const initVammData = new Uint8Array(66);
      const vammView = new DataView(initVammData.buffer);
      {
        let off = 0;
        initVammData[off] = 2; off += 1;                          // tag
        initVammData[off] = 0; off += 1;                          // sub-tag
        vammView.setUint32(off, 50, true); off += 4;              // spread_bps
        vammView.setUint32(off, 50, true); off += 4;              // spread_bps_2
        vammView.setUint32(off, 200, true); off += 4;             // max_spread_bps
        vammView.setUint32(off, 0, true); off += 4;               // reserved
        const liq = 10_000_000_000_000n;
        vammView.setBigUint64(off, liq, true); off += 8;          // liquidity lo
        vammView.setBigUint64(off, 0n, true); off += 8;           // liquidity hi
        const maxFill = 1_000_000_000_000n;
        vammView.setBigUint64(off, maxFill, true); off += 8;      // max_fill lo
        vammView.setBigUint64(off, 0n, true); off += 8;           // max_fill hi
        vammView.setBigUint64(off, 0n, true); off += 8;           // reserved
        vammView.setBigUint64(off, 0n, true); off += 8;           // reserved
      }
      createMatcherTx.add({
        programId: matcherProgramId,
        keys: [
          { pubkey: lpPda, isSigner: false, isWritable: false },
          { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(initVammData),
      });

      const sig7 = await sendAndConfirm(createMatcherTx, [matcherCtxKp]);
      updateStep(7, { status: "done", sig: sig7 });

      // Step 8: Init LP
      updateStep(8, { status: "active" });
      const userAta = await getAta(publicKey, collateralMint);
      const initLpTx = new Transaction();
      initLpTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      initLpTx.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_INIT_LP, [
          publicKey, slabPk, userAta, vaultAta, TOKEN_PROGRAM_ID,
        ]),
        data: encodeInitLP({
          matcherProgram: matcherProgramId,
          matcherContext: matcherCtxKp.publicKey,
          feePayment: "2000000",
        }),
      }));
      const sig8 = await sendAndConfirm(initLpTx);
      updateStep(8, { status: "done", sig: sig8 });

      // Step 9: Deposit LP collateral
      updateStep(9, { status: "active" });
      const decimals = tokenInfo.decimals;
      // Query actual balance to avoid insufficient funds (InitLP fee reduces balance)
      const { getAccount } = await import("@solana/spl-token");
      const userTokenAccount = await getAccount(connection, userAta);
      const requestedAmount = BigInt(Math.round(parseFloat(lpCollateral) * (10 ** decimals)));
      const collateralAmount = requestedAmount > userTokenAccount.amount ? userTokenAccount.amount : requestedAmount;
      const depositTx = new Transaction();
      depositTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      depositTx.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
          publicKey, slabPk, userAta, vaultAta, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
        ]),
        data: encodeDepositCollateral({ userIdx: lpIndex, amount: collateralAmount.toString() }),
      }));
      const sig9 = await sendAndConfirm(depositTx);
      updateStep(9, { status: "done", sig: sig9 });

      // Step 10: Final crank — push fresh price, then attempt crank (non-fatal)
      updateStep(10, { status: "active" });
      const now2 = Math.floor(Date.now() / 1000);
      const pushTx2 = new Transaction();
      pushTx2.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
      pushTx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
      pushTx2.add(buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [publicKey, slabPk]),
        data: encodePushOraclePrice({ priceE6, timestamp: now2.toString() }),
      }));
      const sig10push = await sendAndConfirm(pushTx2);
      // Attempt keeper crank — non-fatal if it fails (devnet program may overflow)
      try {
        const crankTx2 = new Transaction();
        crankTx2.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }));
        crankTx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
        crankTx2.add(buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [publicKey, slabPk, SYSVAR_CLOCK_PUBKEY, slabPk]),
          data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: true }),
        }));
        await sendAndConfirm(crankTx2);
      } catch {
        console.warn("Final crank failed (non-fatal on devnet) — market is still functional");
      }
      updateStep(10, { status: "done", sig: sig10push });

      // Register market in Supabase
      try {
        const regRes = await fetch("/api/markets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slab_address: slabPk.toBase58(),
            mint_address: tokenInfo.mint,
            symbol: tokenInfo.symbol,
            name: tokenInfo.name,
            decimals: tokenInfo.decimals,
            deployer: publicKey.toBase58(),
            oracle_authority: publicKey.toBase58(),
            initial_price_e6: Math.round(parseFloat(initialPrice) * 1_000_000),
            max_leverage: maxLeverage,
            trading_fee_bps: tradingFeeBps,
            lp_collateral: parseFloat(lpCollateral),
            matcher_context: matcherCtxKp.publicKey.toBase58(),
          }),
        });
        if (!regRes.ok) {
          const regErr = await regRes.json().catch(() => ({}));
          console.error("Market registration failed:", regRes.status, regErr);
        } else {
          console.log("Market registered in Supabase ✅");
        }
      } catch (regE) {
        console.error("Market registration error:", regE);
      }

      setStep(3);
    } catch (e) {
      let errMsg: string;
      if (e instanceof Error) {
        errMsg = e.message;
      } else if (typeof e === "object" && e !== null) {
        // Handle Solana transaction errors (InstructionError, etc.)
        try { errMsg = JSON.stringify(e); } catch { errMsg = String(e); }
        // Extract useful info from SendTransactionError
        if ("logs" in e && Array.isArray((e as any).logs)) {
          const logs = (e as any).logs as string[];
          const errorLog = logs.find((l: string) => l.includes("Error") || l.includes("failed"));
          if (errorLog) errMsg = errorLog;
        }
        if ("message" in e) errMsg = (e as any).message;
      } else {
        errMsg = String(e);
      }
      console.error("Deploy error:", e);
      console.error("Error details:", JSON.stringify(e, null, 2));
      const activeIdx = steps.findIndex((s) => s.status === "active");
      if (activeIdx >= 0) updateStep(activeIdx, { status: "error", error: errMsg });
    } finally {
      setDeploying(false);
    }
  }, [publicKey, sendAndConfirm, connection, tokenInfo, initialPrice, maxLeverage, tradingFeeBps, lpCollateral]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="mb-2 text-3xl font-bold text-white">Launch a Perp Market</h1>
      <p className="mb-8 text-slate-400">Deploy a perpetual futures market for any Solana token.</p>

      {/* Tab Switcher */}
      <div className="mb-6 flex rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-1">
        <button
          onClick={() => setActiveTab("quick")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
            activeTab === "quick"
              ? "bg-emerald-500 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          ⚡ Quick Launch
        </button>
        <button
          onClick={() => setActiveTab("advanced")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
            activeTab === "advanced"
              ? "bg-emerald-500 text-white"
              : "text-slate-400 hover:text-white"
          }`}
        >
          🔧 Advanced
        </button>
      </div>

      {/* Quick Launch Tab */}
      {activeTab === "quick" && step < 2 && (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-8">
          {!connected ? (
            <div className="text-center">
              <p className="mb-4 text-slate-400">Connect your wallet to get started</p>
              <WalletMultiButton />
            </div>
          ) : (
            <>
              <label className="mb-2 block text-sm text-slate-400">Token Mint Address</label>
              <div className="mb-4 flex gap-2">
                <input
                  type="text"
                  value={quickMint ?? ""}
                  onChange={(e) => setQuickMint(e.target.value || null)}
                  placeholder="Paste any Solana token mint..."
                  className="flex-1 rounded-xl border border-[#1e2433] bg-[#0a0b0f] px-4 py-3 text-white placeholder-slate-600 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              {quickLaunch.loading && (
                <div className="flex items-center gap-2 py-4 text-slate-400">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                  Auto-detecting token &amp; pool...
                </div>
              )}

              {quickLaunch.error && (
                <p className="mb-4 text-sm text-red-400">{quickLaunch.error}</p>
              )}

              {quickLaunch.config && !quickLaunch.loading && (
                <div className="space-y-4">
                  {/* Detected Token */}
                  <div className="rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-lg font-bold text-white">{quickLaunch.config.symbol}</p>
                        <p className="text-sm text-slate-400">{quickLaunch.config.name}</p>
                      </div>
                      <div className={`rounded-full px-3 py-1 text-xs font-bold ${
                        quickLaunch.config.liquidityTier === "high"
                          ? "bg-emerald-500/10 text-emerald-400"
                          : quickLaunch.config.liquidityTier === "medium"
                          ? "bg-yellow-500/10 text-yellow-400"
                          : "bg-red-500/10 text-red-400"
                      }`}>
                        {quickLaunch.config.liquidityTier.toUpperCase()} LIQUIDITY
                      </div>
                    </div>
                  </div>

                  {/* Pool Info */}
                  {quickLaunch.poolInfo && (
                    <div className="rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-4">
                      <p className="mb-1 text-xs text-slate-500">Best DEX Pool</p>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-white">{quickLaunch.poolInfo.pairLabel} ({quickLaunch.poolInfo.dexId})</span>
                        <span className="text-sm text-emerald-400">${quickLaunch.poolInfo.liquidityUsd.toLocaleString()} liquidity</span>
                      </div>
                    </div>
                  )}

                  {/* Suggested Params */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-3">
                      <p className="text-xs text-slate-500">Price</p>
                      <p className="font-mono text-white">${quickLaunch.config.initialPrice}</p>
                    </div>
                    <div className="rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-3">
                      <p className="text-xs text-slate-500">Max Leverage</p>
                      <p className="font-mono text-white">{quickLaunch.config.maxLeverage}x</p>
                    </div>
                    <div className="rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-3">
                      <p className="text-xs text-slate-500">Initial Margin</p>
                      <p className="font-mono text-white">{quickLaunch.config.initialMarginBps} bps</p>
                    </div>
                    <div className="rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-3">
                      <p className="text-xs text-slate-500">Trading Fee</p>
                      <p className="font-mono text-white">{quickLaunch.config.tradingFeeBps} bps</p>
                    </div>
                  </div>

                  {/* Cost Estimate */}
                  <div className="rounded-xl border border-yellow-500/10 bg-yellow-500/5 p-4">
                    <p className="text-sm text-yellow-400">⚠️ Estimated cost: ~7 SOL for on-chain storage (refundable if you close the market).</p>
                  </div>

                  <button
                    onClick={() => {
                      // Transfer quick launch config to advanced form state and deploy
                      const c = quickLaunch.config!;
                      setMintInput(c.mint);
                      setTokenInfo({ mint: c.mint, name: c.name, symbol: c.symbol, decimals: c.decimals });
                      setInitialPrice(c.initialPrice);
                      setMaxLeverage(c.maxLeverage);
                      setTradingFeeBps(c.tradingFeeBps);
                      setLpCollateral(c.lpCollateral);
                      // Go directly to deploy
                      setStep(1);
                      setActiveTab("advanced");
                    }}
                    className="w-full rounded-xl bg-emerald-500 py-3 font-semibold text-white transition-colors hover:bg-emerald-400"
                  >
                    🚀 Review &amp; Launch
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Steps indicator (Advanced tab or during deploy/done) */}
      {(activeTab === "advanced" || step >= 2) && <>
      {/* Steps indicator */}
      <div className="mb-8 flex items-center gap-2">
        {["Token", "Parameters", "Deploy", "Done"].map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
              i === step ? "bg-emerald-500 text-white" :
              i < step ? "bg-emerald-500/20 text-emerald-400" :
              "bg-slate-800 text-slate-500"
            }`}>
              {i < step ? "✓" : i + 1}
            </div>
            <span className={`text-sm ${i === step ? "text-white" : "text-slate-500"}`}>{label}</span>
            {i < 3 && <div className={`h-px w-8 ${i < step ? "bg-emerald-500" : "bg-slate-700"}`} />}
          </div>
        ))}
      </div>

      {/* Step 0: Token selection */}
      {step === 0 && (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-8">
          {!connected ? (
            <div className="text-center">
              <p className="mb-4 text-slate-400">Connect your wallet to get started</p>
              <WalletMultiButton />
            </div>
          ) : (
            <>
              <label className="mb-2 block text-sm text-slate-400">Token Mint Address</label>
              <input
                type="text"
                value={mintInput}
                onChange={(e) => setMintInput(e.target.value)}
                placeholder="Enter Solana token mint address..."
                className="mb-4 w-full rounded-xl border border-[#1e2433] bg-[#0a0b0f] px-4 py-3 text-white placeholder-slate-600 focus:border-emerald-500 focus:outline-none"
              />
              {tokenError && <p className="mb-4 text-sm text-red-400">{tokenError}</p>}
              <button
                onClick={fetchToken}
                disabled={fetchingToken || !mintInput}
                className="w-full rounded-xl bg-emerald-500 py-3 font-semibold text-white transition-colors hover:bg-emerald-400 disabled:opacity-50"
              >
                {fetchingToken ? "Fetching..." : "Continue"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Step 1: Parameters */}
      {step === 1 && tokenInfo && (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-8">
          {/* Token card */}
          <div className="mb-6 rounded-xl border border-[#1e2433] bg-[#0a0b0f] p-4">
            <p className="text-sm text-slate-400">Token</p>
            <p className="text-lg font-bold text-white">{tokenInfo.symbol}</p>
            <p className="font-mono text-xs text-slate-500">{tokenInfo.mint}</p>
            <p className="text-xs text-slate-500">{tokenInfo.decimals} decimals</p>
          </div>

          <div className="space-y-6">
            <div>
              <label className="mb-1 block text-sm text-slate-400">Initial Price (USD)</label>
              <input
                type="text"
                value={initialPrice}
                onChange={(e) => setInitialPrice(e.target.value)}
                className="w-full rounded-xl border border-[#1e2433] bg-[#0a0b0f] px-4 py-3 text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Max Leverage: {maxLeverage}x
              </label>
              <input
                type="range"
                min={2}
                max={20}
                value={maxLeverage}
                onChange={(e) => setMaxLeverage(parseInt(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-slate-500">
                <span>2x</span><span>20x</span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-400">
                Trading Fee: {tradingFeeBps} bps ({(tradingFeeBps / 100).toFixed(2)}%)
              </label>
              <input
                type="range"
                min={1}
                max={50}
                value={tradingFeeBps}
                onChange={(e) => setTradingFeeBps(parseInt(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-slate-500">
                <span>1 bps</span><span>50 bps</span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-400">LP Collateral (tokens to seed)</label>
              <input
                type="text"
                value={lpCollateral}
                onChange={(e) => setLpCollateral(e.target.value)}
                className="w-full rounded-xl border border-[#1e2433] bg-[#0a0b0f] px-4 py-3 text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="rounded-xl border border-yellow-500/10 bg-yellow-500/5 p-4">
              <p className="text-sm text-yellow-400">⚠️ Deploying a market requires ~6.9 SOL for on-chain storage (refundable if you close the market later). Supports up to 4,096 traders.</p>
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={() => setStep(0)}
              className="flex-1 rounded-xl border border-slate-700 py-3 text-slate-400 hover:bg-slate-800"
            >
              Back
            </button>
            <button
              onClick={deploy}
              className="flex-1 rounded-xl bg-emerald-500 py-3 font-semibold text-white hover:bg-emerald-400"
            >
              🚀 Deploy Market
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Deploying */}
      {step === 2 && (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-8">
          <h3 className="mb-4 text-lg font-semibold text-white">Deploying Market...</h3>
          <div className="space-y-3">
            {deploySteps.map((s, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className={`h-3 w-3 rounded-full ${
                  s.status === "done" ? "bg-emerald-500" :
                  s.status === "active" ? "bg-yellow-500 animate-pulse" :
                  s.status === "error" ? "bg-red-500" :
                  "bg-slate-700"
                }`} />
                <span className={`text-sm ${
                  s.status === "done" ? "text-emerald-400" :
                  s.status === "active" ? "text-yellow-400" :
                  s.status === "error" ? "text-red-400" :
                  "text-slate-500"
                }`}>
                  {s.label}
                </span>
                {s.sig && (
                  <a
                    href={`https://explorer.solana.com/tx/${s.sig}${typeof window !== "undefined" && localStorage.getItem("percolator_network") === "mainnet" ? "" : "?cluster=devnet"}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-slate-500 hover:text-emerald-400"
                  >
                    {s.sig.slice(0, 8)}...
                  </a>
                )}
                {s.error && <span className="text-xs text-red-400">{s.error}</span>}
              </div>
            ))}
          </div>

          {/* Recovery buttons on failure */}
          {!deploying && deploySteps.some((s) => s.status === "error") && (
            <div className="mt-6 space-y-3 border-t border-[#1e2433] pt-6">
              <p className="text-sm text-slate-400">Deployment failed. You can recover your SOL or try again.</p>
              <div className="flex gap-3">
                {slabKeypair && (
                  <button
                    onClick={recoverSlab}
                    disabled={recovering}
                    className="flex-1 rounded-xl border border-yellow-500/30 bg-yellow-500/10 py-3 text-sm font-semibold text-yellow-400 transition-colors hover:bg-yellow-500/20 disabled:opacity-50"
                  >
                    {recovering ? "Recovering..." : "🔄 Recover SOL from Slab"}
                  </button>
                )}
                <button
                  onClick={() => { setStep(1); setDeploySteps([]); setSlabKeypair(null); }}
                  className="flex-1 rounded-xl border border-slate-700 py-3 text-sm font-semibold text-slate-400 hover:bg-slate-800"
                >
                  ← Back to Settings
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Done */}
      {step === 3 && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-8 text-center">
          <div className="mb-4 text-5xl">🎉</div>
          <h3 className="mb-2 text-2xl font-bold text-white">Market Deployed!</h3>
          <p className="mb-4 text-slate-400">Your perpetual futures market is live on Solana.</p>
          <div className="mb-6 rounded-xl bg-[#0a0b0f] p-4">
            <p className="text-xs text-slate-500">Market Address (Slab)</p>
            <p className="font-mono text-sm text-emerald-400">{slabAddress}</p>
          </div>
          <a
            href={`/trade/${slabAddress}`}
            className="inline-block rounded-xl bg-emerald-500 px-8 py-3 font-semibold text-white hover:bg-emerald-400"
          >
            Start Trading →
          </a>
        </div>
      )}
      </>}
    </div>
  );
}
