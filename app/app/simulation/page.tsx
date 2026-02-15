"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Transaction,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMintLen,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeInitVamm,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeSetOraclePriceCap,
  encodeUpdateConfig,
  encodeKeeperCrank,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_UPDATE_CONFIG,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  SLAB_TIERS,
  deriveLpPda,
} from "@percolator/core";
import { ScenarioSelector } from "@/components/simulation/ScenarioSelector";
import { SimulationControls } from "@/components/simulation/SimulationControls";
import { LiveEventFeed } from "@/components/simulation/LiveEventFeed";
import { SimulationMetrics } from "@/components/simulation/SimulationMetrics";
import { BotLeaderboard } from "@/components/simulation/BotLeaderboard";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

/* ─── Constants ─── */
const FUND_AMOUNT_SOL = 0.5;
const FUND_AMOUNT_LAMPORTS = FUND_AMOUNT_SOL * LAMPORTS_PER_SOL;
const PROGRAM_ID = new PublicKey("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MINT_AMOUNT = 10_000_000_000n;
const LP_FEE = 1_000_000n;
const INITIAL_PRICE_E6 = 1_000_000n; // $1.00
const MATCHER_CTX_SIZE = 320;

// Hardcoded rent (avoids RPC calls)
const MINT_RENT = 1_461_600;
const SLAB_RENT = 438_034_560;
const MATCHER_CTX_RENT = 3_118_080;

/* ─── Types ─── */
interface SimulationState {
  running: boolean;
  slabAddress: string | null;
  price: number;
  scenario: string | null;
  model: string;
  uptime: number;
}

interface TokenPreview {
  name: string;
  symbol: string;
  description: string;
  decimals: number;
}

type Phase = "idle" | "funding-wallet" | "creating" | "funding" | "starting" | "running" | "ended";

/* ─── Helpers ─── */
function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function extractError(err: unknown): string {
  if (err instanceof SendTransactionError) {
    const logs = (err as SendTransactionError & { logs?: string[] }).logs;
    if (logs) {
      const fails = logs.filter((l: string) => l.includes("failed") || l.includes("Error"));
      if (fails.length) return `${err.message} | ${fails.join("; ")}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function sendAndConfirm(
  connection: ReturnType<typeof useConnection>["connection"],
  tx: Transaction,
  signers: Keypair[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.partialSign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/* ─── Component ─── */
export default function SimulationPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [phase, setPhase] = useState<Phase>("idle");
  const [tokenPreview, setTokenPreview] = useState<TokenPreview | null>(null);
  const [slabAddress, setSlabAddress] = useState<string | null>(null);
  const [mintAddress, setMintAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepLabel, setStepLabel] = useState("");
  const [stepNum, setStepNum] = useState(0);
  const [stepTotal, setStepTotal] = useState(0);

  const [state, setState] = useState<SimulationState>({
    running: false,
    slabAddress: null,
    price: 1_000_000,
    scenario: null,
    model: "random-walk",
    uptime: 0,
  });
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);

  /* ─── Fetch random token ─── */
  const fetchTokenPreview = useCallback(async () => {
    try {
      const res = await fetch("/api/simulation/random-token");
      if (res.ok) {
        const data = await res.json();
        setTokenPreview({ name: data.name, symbol: data.symbol, description: data.description, decimals: data.decimals ?? 6 });
      }
    } catch {
      setTokenPreview({ name: "Mystery Token", symbol: "???", description: "Could not load", decimals: 6 });
    }
  }, []);

  useEffect(() => { fetchTokenPreview(); }, [fetchTokenPreview]);

  /* ─── Poll simulation state ─── */
  useEffect(() => {
    if (phase !== "running") return;
    const fetchState = async () => {
      try {
        const res = await fetch("/api/simulation");
        if (res.ok) {
          const data = await res.json();
          setState({ running: data.running, slabAddress: data.slabAddress, price: data.price, scenario: data.scenario, model: data.model, uptime: data.uptime });
          if (!data.running) setPhase("ended");
        }
      } catch (err) { console.error("Poll error:", err); }
    };
    fetchState();
    const iv = setInterval(fetchState, 2000);
    return () => clearInterval(iv);
  }, [phase]);

  /* ─── LAUNCH ─── */
  const handleLaunch = async () => {
    if (!publicKey || !sendTransaction) return;
    setError(null);

    try {
      const decimals = tokenPreview?.decimals ?? 6;
      const payer = Keypair.generate();
      const oracleKp = Keypair.generate();
      const mintKp = Keypair.generate();
      const slabKp = Keypair.generate();
      const matcherCtxKp = Keypair.generate();

      const tier = SLAB_TIERS.small;
      const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);
      const vaultAta = await getAssociatedTokenAddress(mintKp.publicKey, vaultPda, true);
      const [lpPda] = deriveLpPda(PROGRAM_ID, slabKp.publicKey, 0);
      const payerAta = await getAssociatedTokenAddress(mintKp.publicKey, payer.publicKey);

      /* ─── Phase 1: Fund disposable wallet (ONE wallet approval) ─── */
      setPhase("funding-wallet");
      setStepLabel("Approve SOL transfer...");
      setStepNum(0);
      setStepTotal(6);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const fundTx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: publicKey }).add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: payer.publicKey, lamports: FUND_AMOUNT_LAMPORTS })
      );
      const fundSig = await sendTransaction(fundTx, connection, { skipPreflight: true });
      setStepLabel("Confirming transfer...");
      await connection.confirmTransaction({ signature: fundSig, blockhash, lastValidBlockHeight }, "confirmed");
      setStepNum(1);

      /* ─── Phase 2: Create market (4 tx groups) ─── */
      setPhase("creating");

      // Group 1: mint + slab + vault + InitMarket
      setStepLabel("Creating mint, slab & market...");
      {
        const tx = new Transaction();
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, lamports: MINT_RENT, space: getMintLen([]), programId: TOKEN_PROGRAM_ID }));
        tx.add(createInitializeMint2Instruction(mintKp.publicKey, decimals, payer.publicKey, null));
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: slabKp.publicKey, lamports: SLAB_RENT, space: tier.dataSize, programId: PROGRAM_ID }));
        tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, vaultAta, vaultPda, mintKp.publicKey));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, [payer.publicKey, slabKp.publicKey, mintKp.publicKey, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent, vaultPda, WELL_KNOWN.systemProgram]),
          data: encodeInitMarket({
            admin: payer.publicKey, collateralMint: mintKp.publicKey, indexFeedId: "0".repeat(64),
            maxStalenessSecs: "86400", confFilterBps: 0, invert: 0, unitScale: 0,
            initialMarkPriceE6: INITIAL_PRICE_E6.toString(), warmupPeriodSlots: "10",
            maintenanceMarginBps: "500", initialMarginBps: "1000", tradingFeeBps: "30",
            maxAccounts: "256", newAccountFee: "1000000", riskReductionThreshold: "0",
            maintenanceFeePerSlot: "0", maxCrankStalenessSlots: "400", liquidationFeeBps: "100",
            liquidationFeeCap: "100000000000", liquidationBufferBps: "50", minLiquidationAbs: "1000000",
          }),
        }));
        await sendAndConfirm(connection, tx, [payer, mintKp, slabKp]);
      }
      setStepNum(2);
      setSlabAddress(slabKp.publicKey.toBase58());
      setMintAddress(mintKp.publicKey.toBase58());

      // Group 2: Oracle + Config + Crank
      setStepLabel("Setting up oracle & config...");
      {
        const tx = new Transaction();
        const t = nowSecs();
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slabKp.publicKey]), data: encodeSetOracleAuthority({ newAuthority: payer.publicKey }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: t.toString() }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slabKp.publicKey]), data: encodeSetOraclePriceCap({ maxChangeE2bps: 100_000n }) }));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [payer.publicKey, slabKp.publicKey]),
          data: encodeUpdateConfig({
            fundingHorizonSlots: "3600", fundingKBps: "100", fundingInvScaleNotionalE6: "1000000000000",
            fundingMaxPremiumBps: "1000", fundingMaxBpsPerSlot: "10", threshFloor: "0", threshRiskBps: "500",
            threshUpdateIntervalSlots: "100", threshStepBps: "100", threshAlphaBps: "5000",
            threshMin: "0", threshMax: "1000000000000000000", threshMinStep: "0",
          }),
        }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey]), data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) }));
        await sendAndConfirm(connection, tx, [payer]);
      }
      setStepNum(3);

      // Group 3: LP Setup
      setStepLabel("Initializing LP & vAMM...");
      {
        const tx = new Transaction();
        tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mintKp.publicKey));
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: matcherCtxKp.publicKey, lamports: MATCHER_CTX_RENT, space: MATCHER_CTX_SIZE, programId: MATCHER_PROGRAM_ID }));
        tx.add(createMintToInstruction(mintKp.publicKey, payerAta, payer.publicKey, LP_FEE));
        tx.add(buildIx({
          programId: PROGRAM_ID,
          keys: buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slabKp.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram]),
          data: encodeInitLP({ matcherProgram: MATCHER_PROGRAM_ID, matcherContext: matcherCtxKp.publicKey, feePayment: LP_FEE.toString() }),
        }));
        // InitVamm — on-chain only reads 2 accounts (lp_pda, matcher_ctx)
        tx.add(buildIx({
          programId: MATCHER_PROGRAM_ID,
          keys: [
            { pubkey: lpPda, isSigner: false, isWritable: false },
            { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
          ],
          data: encodeInitVamm({
            mode: 0, tradingFeeBps: 30, baseSpreadBps: 50, maxTotalBps: 200,
            impactKBps: 0, liquidityNotionalE6: 10_000_000_000_000n,
            maxFillAbs: 1_000_000_000_000n, maxInventoryAbs: 0n,
          }),
        }));
        await sendAndConfirm(connection, tx, [payer, matcherCtxKp]);
      }
      setStepNum(4);

      // Group 4: Delegate oracle + final crank
      setStepLabel("Delegating oracle & finalizing...");
      {
        const tx = new Transaction();
        const t = nowSecs();
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: t.toString() }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey]), data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, slabKp.publicKey]), data: encodeSetOracleAuthority({ newAuthority: oracleKp.publicKey }) }));
        tx.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [oracleKp.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: (t + 1).toString() }) }));
        await sendAndConfirm(connection, tx, [payer, oracleKp]);
      }
      setStepNum(5);

      /* ─── Phase 3: Fund market ─── */
      setPhase("funding");
      setStepLabel("Minting & depositing collateral...");
      {
        const tx1 = new Transaction();
        tx1.add(createMintToInstruction(mintKp.publicKey, payerAta, payer.publicKey, MINT_AMOUNT));
        await sendAndConfirm(connection, tx1, [payer]);
      }
      {
        const tx2 = new Transaction();
        const lpCollateral = (MINT_AMOUNT * 70n) / 100n;
        const insuranceAmt = (MINT_AMOUNT * 20n) / 100n;
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slabKp.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock]), data: encodeDepositCollateral({ userIdx: 0, amount: lpCollateral.toString() }) }));
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slabKp.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram]), data: encodeTopUpInsurance({ amount: insuranceAmt.toString() }) }));
        const t = nowSecs();
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [oracleKp.publicKey, slabKp.publicKey]), data: encodePushOraclePrice({ priceE6: INITIAL_PRICE_E6.toString(), timestamp: t.toString() }) }));
        tx2.add(buildIx({ programId: PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slabKp.publicKey, WELL_KNOWN.clock, slabKp.publicKey]), data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) }));
        await sendAndConfirm(connection, tx2, [payer, oracleKp]);
      }
      setStepNum(6);

      /* ─── Phase 4: Start simulation ─── */
      setPhase("starting");
      setStepLabel("Starting simulation engine...");

      const oracleSecret = Buffer.from(oracleKp.secretKey).toString("base64");
      const startRes = await fetch("/api/simulation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slabAddress: slabKp.publicKey.toBase58(), oracleSecret, startPriceE6: Number(INITIAL_PRICE_E6), intervalMs: 5000 / speed }),
      });
      if (!startRes.ok) {
        const err = await startRes.json();
        throw new Error(err.details || err.error || "Failed to start simulation");
      }

      setState({ running: true, slabAddress: slabKp.publicKey.toBase58(), price: Number(INITIAL_PRICE_E6), scenario: null, model: "random-walk", uptime: 0 });
      setPhase("running");
    } catch (err: unknown) {
      console.error("Launch error:", err);
      setError(extractError(err));
      setPhase("idle");
    }
  };

  /* ─── Stop ─── */
  const handleStop = async () => {
    setLoading(true);
    try {
      await fetch("/api/simulation/stop", { method: "POST" });
      setState({ running: false, slabAddress: null, price: 1_000_000, scenario: null, model: "random-walk", uptime: 0 });
      setPhase("ended");
    } catch (err) { console.error("Stop error:", err); }
    finally { setLoading(false); }
  };

  const handleRestart = () => {
    setPhase("idle");
    setSlabAddress(null);
    setMintAddress(null);
    setError(null);
    setStepNum(0);
    fetchTokenPreview();
  };

  const handleScenarioSelect = async (scenarioId: string, params?: Record<string, number>) => {
    try {
      const res = await fetch("/api/simulation/scenario", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: scenarioId, params }) });
      if (res.ok) setState((s) => ({ ...s, scenario: scenarioId }));
    } catch (err) { console.error("Scenario error:", err); }
  };

  const handlePriceOverride = async (priceE6: number) => {
    try {
      await fetch("/api/simulation/price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priceE6 }) });
      setState((s) => ({ ...s, price: priceE6 }));
    } catch (err) { console.error("Price override error:", err); }
  };

  const formatUptime = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  const isLaunching = phase === "funding-wallet" || phase === "creating" || phase === "funding" || phase === "starting";

  const phaseOrder = (check: Phase): boolean => {
    const order: Phase[] = ["funding-wallet", "creating", "funding", "starting"];
    return order.indexOf(check) < order.indexOf(phase);
  };

  /* ─── Setup Flow ─── */
  if (phase !== "running") {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
          <div className="mx-auto max-w-2xl">
            <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">// SIMULATION</p>
            <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>Self-Service Demo</h1>
            <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">One-click simulation -- connect wallet, approve once, everything else is automatic</p>
          </div>
        </div>

        <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
          {/* Token Preview */}
          {tokenPreview && (
            <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-2">Your Token</p>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--accent)]">{tokenPreview.symbol}</p>
                  <p className="text-[14px] font-bold text-[var(--text)] mt-0.5">{tokenPreview.name}</p>
                  <p className="text-[10px] text-[var(--text-dim)] mt-0.5">{tokenPreview.description}</p>
                </div>
                <button onClick={fetchTokenPreview} disabled={isLaunching} className="border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors disabled:opacity-40">Reroll</button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="border border-[var(--short)]/30 bg-[var(--short)]/[0.04] p-3">
              <p className="text-[10px] text-[var(--short)] break-all">{error}</p>
            </div>
          )}

          {/* Idle */}
          {phase === "idle" && (
            <div className="space-y-3">
              {!connected ? (
                <div className="flex items-center justify-between border border-[var(--border)]/30 bg-[var(--bg)]/80 p-4">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Connect Wallet</p>
                    <p className="text-[9px] text-[var(--text-dim)] mt-0.5">You will approve one transfer of {FUND_AMOUNT_SOL} SOL. Everything else is automatic.</p>
                  </div>
                  <WalletMultiButton />
                </div>
              ) : (
                <div className="flex items-center gap-2 border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-3">
                  <div className="h-2 w-2" style={{ backgroundColor: "var(--long)" }} />
                  <span className="text-[11px] font-mono text-[var(--text)]">{publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}</span>
                  <span className="text-[9px] text-[var(--text-dim)] ml-auto">Cost: ~{FUND_AMOUNT_SOL} SOL (devnet)</span>
                </div>
              )}
              <button onClick={handleLaunch} disabled={!connected} className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-4 text-[13px] font-bold uppercase tracking-[0.2em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:opacity-40 disabled:cursor-not-allowed">Launch Simulation</button>
            </div>
          )}

          {/* Progress */}
          {isLaunching && (
            <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.02] p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                <span className="text-[11px] text-[var(--text)]">{stepLabel || "Working..."}</span>
              </div>
              {stepTotal > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[9px] text-[var(--text-dim)]">
                    <span>Step {stepNum} of {stepTotal}</span>
                    <span>{Math.round((stepNum / stepTotal) * 100)}%</span>
                  </div>
                  <div className="h-1 bg-[var(--border)]">
                    <div className="h-1 bg-[var(--accent)] transition-all" style={{ width: `${(stepNum / stepTotal) * 100}%` }} />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-4 text-[9px] text-[var(--text-dim)]">
                {(["funding-wallet", "creating", "funding", "starting"] as Phase[]).map((p) => (
                  <span key={p} className="flex items-center gap-1.5">
                    <div className="h-1.5 w-1.5" style={{ backgroundColor: phase === p ? "var(--accent)" : phaseOrder(p) ? "var(--long)" : "var(--text-dim)" }} />
                    {p === "funding-wallet" ? "Fund" : p === "creating" ? "Market" : p === "funding" ? "Tokens" : "Start"}
                  </span>
                ))}
              </div>
              <p className="text-[9px] text-[var(--text-dim)]">One approval done. Everything else is automatic.</p>
            </div>
          )}

          {/* Ended */}
          {phase === "ended" && (
            <div className="border border-[var(--border)] bg-[var(--bg)]/80 p-5 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Simulation Ended</p>
              {slabAddress && <p className="text-[10px] font-mono text-[var(--text-secondary)]">Market: {slabAddress.slice(0, 12)}...{slabAddress.slice(-12)}</p>}
              <button onClick={handleRestart} className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-all">Start New Simulation</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ─── Running Dashboard ─── */
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
        <div className="mx-auto max-w-7xl">
          <div className="flex items-start justify-between">
            <div>
              <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">// SIMULATION</p>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>{tokenPreview?.symbol || "SIM"}</h1>
                <span className="text-[12px] text-[var(--text-secondary)]">{tokenPreview?.name || "Simulation"}</span>
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">Self-service simulation -- real on-chain market</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="border border-[var(--border)]/50 bg-[var(--bg-elevated)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2" style={{ backgroundColor: state.running ? "var(--long)" : "var(--short)" }} />
                  <div className="text-right">
                    <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{state.running ? "Running" : "Stopped"}</p>
                    {state.running && state.uptime > 0 && <p className="text-[9px] font-mono text-[var(--text)]">{formatUptime(state.uptime)}</p>}
                  </div>
                </div>
              </div>
              <button onClick={handleStop} disabled={loading} className="border border-[var(--short)]/50 bg-[var(--short)]/[0.08] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--short)] hover:bg-[var(--short)]/[0.15] transition-all disabled:opacity-50">{loading ? "Ending..." : "End & Cleanup"}</button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-3 py-3">
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-3">
          <div className="space-y-3">
            <SimulationControls isRunning={state.running} currentSlab={state.slabAddress || slabAddress} speed={speed} onStart={async () => {}} onStop={handleStop} onSpeedChange={(s: number) => setSpeed(s)} onPriceOverride={handlePriceOverride} />
            {state.running && (
              <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
                <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">Current Oracle Price</p>
                <p className="text-[24px] font-bold font-mono text-[var(--text)]">${(state.price / 1e6).toFixed(2)}</p>
              </div>
            )}
            {tokenPreview && (
              <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-3">
                <p className="text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] mb-1">Market Token</p>
                <p className="text-[14px] font-bold text-[var(--text)]">{tokenPreview.symbol}</p>
                <p className="text-[10px] text-[var(--text-secondary)]">{tokenPreview.name}</p>
                {mintAddress && <p className="text-[9px] font-mono text-[var(--text-dim)] mt-1 truncate">{mintAddress}</p>}
              </div>
            )}
            <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-3">Scenarios</h3>
              <ScenarioSelector activeScenario={state.scenario} onScenarioSelect={handleScenarioSelect} disabled={loading} />
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <SimulationMetrics isSimulationRunning={state.running} />
              <LiveEventFeed isSimulationRunning={state.running} />
            </div>
            <BotLeaderboard isSimulationRunning={state.running} />
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t border-[var(--border)]/30 bg-[var(--bg)]/95 backdrop-blur-sm px-4 py-2">
        <div className="mx-auto max-w-7xl flex items-center justify-between">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{state.running ? `Model: ${state.model} | Scenario: ${state.scenario || "none"} | Speed: ${speed}x` : "Simulation paused"}</p>
          {(state.slabAddress || slabAddress) && <p className="text-[9px] font-mono text-[var(--text-secondary)]">{(state.slabAddress || slabAddress || "").slice(0, 8)}...{(state.slabAddress || slabAddress || "").slice(-8)}</p>}
        </div>
      </div>
    </div>
  );
}
