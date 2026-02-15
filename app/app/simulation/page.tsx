"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Transaction, TransactionInstruction, PublicKey, Keypair, Connection, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { ScenarioSelector } from "@/components/simulation/ScenarioSelector";
import { SimulationControls } from "@/components/simulation/SimulationControls";
import { LiveEventFeed } from "@/components/simulation/LiveEventFeed";
import { SimulationMetrics } from "@/components/simulation/SimulationMetrics";
import { BotLeaderboard } from "@/components/simulation/BotLeaderboard";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const FUND_AMOUNT_SOL = 0.5;
const FUND_AMOUNT_LAMPORTS = FUND_AMOUNT_SOL * LAMPORTS_PER_SOL;

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
}

interface InstructionGroupData {
  label: string;
  instructions: {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  }[];
  signers: string[];
}

type LaunchPhase = "idle" | "funding-wallet" | "creating" | "funding" | "starting" | "running" | "ended";

export default function SimulationPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [disposableKeypair, setDisposableKeypair] = useState<Keypair | null>(null);
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [tokenPreview, setTokenPreview] = useState<TokenPreview | null>(null);
  const [slabAddress, setSlabAddress] = useState<string | null>(null);
  const [mintAddress, setMintAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txProgress, setTxProgress] = useState<{ current: number; total: number; label: string }>({ current: 0, total: 0, label: "" });

  const [state, setState] = useState<SimulationState>({
    running: false,
    slabAddress: null,
    price: 100_000000,
    scenario: null,
    model: "random-walk",
    uptime: 0,
  });
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);

  // Fetch random token preview on mount
  const fetchTokenPreview = useCallback(async () => {
    try {
      const res = await fetch("/api/simulation/random-token");
      if (res.ok) {
        const data = await res.json();
        setTokenPreview({ name: data.name, symbol: data.symbol, description: data.description });
      }
    } catch {
      setTokenPreview({ name: "Mystery Token", symbol: "???", description: "Could not load preview" });
    }
  }, []);

  useEffect(() => {
    fetchTokenPreview();
  }, [fetchTokenPreview]);

  // Poll simulation state when running
  useEffect(() => {
    if (phase !== "running") return;

    const fetchState = async () => {
      try {
        const response = await fetch("/api/simulation");
        if (response.ok) {
          const data = await response.json();
          setState({
            running: data.running,
            slabAddress: data.slabAddress,
            price: data.price,
            scenario: data.scenario,
            model: data.model,
            uptime: data.uptime,
          });
          if (!data.running) {
            setPhase("ended");
          }
        }
      } catch (err) {
        console.error("Failed to fetch simulation state:", err);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 2000);
    return () => clearInterval(interval);
  }, [phase]);

  const sendInstructionGroups = async (groups: InstructionGroupData[], signer: Keypair): Promise<boolean> => {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      setTxProgress({ current: i + 1, total: groups.length, label: group.label });

      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

        const tx = new Transaction();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = signer.publicKey;

        for (const ix of group.instructions) {
          tx.add(
            new TransactionInstruction({
              programId: new PublicKey(ix.programId),
              keys: ix.keys.map((k) => ({
                pubkey: new PublicKey(k.pubkey),
                isSigner: k.isSigner,
                isWritable: k.isWritable,
              })),
              data: Buffer.from(ix.data, "base64"),
            })
          );
        }

        // Partial sign with server-provided keypairs
        if (group.signers.length > 0) {
          const keypairs = group.signers.map((s) => Keypair.fromSecretKey(Buffer.from(s, "base64")));
          tx.partialSign(...keypairs);
        }

        // Sign with disposable keypair
        tx.partialSign(signer);

        const sig = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction(sig, "confirmed");
      } catch (err: unknown) {
        let msg = err instanceof Error ? err.message : String(err);
        // Extract logs from SendTransactionError
        const anyErr = err as Record<string, unknown>;
        if (anyErr?.logs) {
          const logs = anyErr.logs as string[];
          const failLog = logs.filter((l: string) => l.includes("failed") || l.includes("Error")).join("; ");
          if (failLog) msg += ` | Logs: ${failLog}`;
        }
        throw new Error(`Failed at step ${i + 1} (${group.label}): ${msg}`);
      }
    }

    return true;
  };

  const handleLaunch = async () => {
    if (!publicKey || !sendTransaction) return;
    setError(null);

    try {
      // Generate disposable keypair
      const kp = Keypair.generate();
      setDisposableKeypair(kp);

      // Fund disposable wallet from user's wallet (ONE approval)
      setPhase("funding-wallet");
      setTxProgress({ current: 0, total: 0, label: `Approve ${FUND_AMOUNT_SOL} SOL transfer...` });

      // Pre-fetch blockhash so Phantom popup appears instantly
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const fundTx = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: kp.publicKey,
          lamports: FUND_AMOUNT_LAMPORTS,
        })
      );
      const fundSig = await sendTransaction(fundTx, connection, { skipPreflight: true });
      setTxProgress({ current: 0, total: 0, label: "Confirming transfer..." });
      await connection.confirmTransaction(fundSig, "confirmed");

      // Create market
      setPhase("creating");
      setTxProgress({ current: 0, total: 5, label: "Preparing market..." });

      const createRes = await fetch("/api/simulation/create-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payerPublicKey: kp.publicKey.toBase58() }),
      });

      if (!createRes.ok) {
        const err = await createRes.json();
        throw new Error(err.details || err.error || "Failed to create market");
      }

      const createData = await createRes.json();
      setSlabAddress(createData.slabAddress);
      setMintAddress(createData.mintAddress);
      setTokenPreview({
        name: createData.tokenName,
        symbol: createData.tokenSymbol,
        description: createData.tokenDescription,
      });

      await sendInstructionGroups(createData.instructionGroups, kp);

      // Fund market
      setPhase("funding");
      setTxProgress({ current: 0, total: 2, label: "Minting tokens..." });

      const fundRes = await fetch("/api/simulation/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payerPublicKey: kp.publicKey.toBase58(),
          slabAddress: createData.slabAddress,
          mintAddress: createData.mintAddress,
          oracleSecret: createData.oracleSecret,
        }),
      });

      if (!fundRes.ok) {
        const err = await fundRes.json();
        throw new Error(err.details || err.error || "Failed to fund market");
      }

      const fundData = await fundRes.json();
      await sendInstructionGroups(fundData.instructionGroups, kp);

      // Start simulation
      setPhase("starting");
      setTxProgress({ current: 0, total: 0, label: "Starting simulation engine..." });

      const startRes = await fetch("/api/simulation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slabAddress: createData.slabAddress,
          oracleSecret: createData.oracleSecret,
          startPriceE6: createData.initialPriceE6,
          scenario: null,
          intervalMs: 5000 / speed,
        }),
      });

      if (!startRes.ok) {
        const err = await startRes.json();
        throw new Error(err.details || err.error || "Failed to start simulation");
      }

      const startData = await startRes.json();
      setState({
        running: true,
        slabAddress: createData.slabAddress,
        price: startData.state?.startPriceE6 || createData.initialPriceE6,
        scenario: null,
        model: "random-walk",
        uptime: 0,
      });

      setPhase("running");
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : String(err);
      // Try to extract more detail
      const anyErr = err as Record<string, unknown>;
      if (anyErr?.logs) msg += ` | ${(anyErr.logs as string[]).join("; ")}`;
      console.error("Simulation launch error:", err);
      setError(msg);
      setPhase("idle");
    }
  };

  const handleStop = async () => {
    setLoading(true);

    try {
      await fetch("/api/simulation/stop", { method: "POST" });
      if (disposableKeypair) {
        await fetch("/api/simulation/refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payerPublicKey: disposableKeypair.publicKey.toBase58() }),
        });
      }

      setState({ running: false, slabAddress: null, price: 100_000000, scenario: null, model: "random-walk", uptime: 0 });
      setPhase("ended");
    } catch (err) {
      console.error("Stop error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = () => {
    setPhase("idle");
    setSlabAddress(null);
    setMintAddress(null);
    setError(null);
    setDisposableKeypair(null);
    fetchTokenPreview();
  };

  const handleScenarioSelect = async (scenarioId: string, params?: Record<string, number>) => {
    try {
      const response = await fetch("/api/simulation/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: scenarioId, params }),
      });
      if (response.ok) {
        setState((prev) => ({ ...prev, scenario: scenarioId }));
      }
    } catch (err) {
      console.error("Set scenario error:", err);
    }
  };

  const handlePriceOverride = async (priceE6: number) => {
    try {
      await fetch("/api/simulation/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceE6 }),
      });
      setState((prev) => ({ ...prev, price: priceE6 }));
    } catch (err) {
      console.error("Price override error:", err);
    }
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
  };

  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const isLaunching = phase === "funding-wallet" || phase === "creating" || phase === "funding" || phase === "starting";

  const phaseLabel: Record<string, string> = {
    "funding-wallet": `Sending ${FUND_AMOUNT_SOL} SOL...`,
    creating: "Creating market...",
    funding: "Funding market...",
    starting: "Starting simulation...",
  };

  // ─── Setup Flow (not yet running) ───
  if (phase !== "running") {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        {/* Header */}
        <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
          <div className="mx-auto max-w-2xl">
            <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">
              // SIMULATION
            </p>
            <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
              Self-Service Demo
            </h1>
            <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
              One-click simulation — connect wallet, approve once, everything else is automatic
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
          {/* Token Preview */}
          {tokenPreview && (
            <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-2">
                Your Token
              </p>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--accent)]">
                    {tokenPreview.symbol}
                  </p>
                  <p className="text-[14px] font-bold text-[var(--text)] mt-0.5">
                    {tokenPreview.name}
                  </p>
                  <p className="text-[10px] text-[var(--text-dim)] mt-0.5">
                    {tokenPreview.description}
                  </p>
                </div>
                <button
                  onClick={fetchTokenPreview}
                  disabled={isLaunching}
                  className="border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors disabled:opacity-40"
                >
                  Reroll
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="border border-[var(--short)]/30 bg-[var(--short)]/[0.04] p-3">
              <p className="text-[10px] text-[var(--short)]">{error}</p>
            </div>
          )}

          {/* Wallet + Launch */}
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
                  <span className="text-[11px] font-mono text-[var(--text)]">
                    {publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}
                  </span>
                  <span className="text-[9px] text-[var(--text-dim)] ml-auto">Cost: ~{FUND_AMOUNT_SOL} SOL (devnet)</span>
                </div>
              )}
              <button
                onClick={handleLaunch}
                disabled={!connected}
                className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-4 text-[13px] font-bold uppercase tracking-[0.2em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Launch Simulation
              </button>
            </div>
          )}

          {/* Progress */}
          {isLaunching && (
            <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.02] p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                <span className="text-[11px] text-[var(--text)]">
                  {txProgress.label || phaseLabel[phase] || "Working..."}
                </span>
              </div>
              {txProgress.total > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[9px] text-[var(--text-dim)]">
                    <span>Step {txProgress.current} of {txProgress.total}</span>
                    <span>{Math.round((txProgress.current / txProgress.total) * 100)}%</span>
                  </div>
                  <div className="h-1 bg-[var(--border)]">
                    <div
                      className="h-1 bg-[var(--accent)] transition-all"
                      style={{ width: `${(txProgress.current / txProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-4 text-[9px] text-[var(--text-dim)]">
                <span className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5" style={{ backgroundColor: phase === "funding-wallet" ? "var(--accent)" : phaseOrder("funding-wallet") ? "var(--long)" : "var(--text-dim)" }} />
                  Fund
                </span>
                <span className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5" style={{ backgroundColor: phase === "creating" ? "var(--accent)" : phaseOrder("creating") ? "var(--long)" : "var(--text-dim)" }} />
                  Market
                </span>
                <span className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5" style={{ backgroundColor: phase === "funding" ? "var(--accent)" : phaseOrder("funding") ? "var(--long)" : "var(--text-dim)" }} />
                  Tokens
                </span>
                <span className="flex items-center gap-1.5">
                  <div className="h-1.5 w-1.5" style={{ backgroundColor: phase === "starting" ? "var(--accent)" : phaseOrder("starting") ? "var(--long)" : "var(--text-dim)" }} />
                  Start
                </span>
              </div>
              <p className="text-[9px] text-[var(--text-dim)]">
                One approval done. Everything else is automatic.
              </p>
            </div>
          )}

          {/* Ended state */}
          {phase === "ended" && (
            <div className="border border-[var(--border)] bg-[var(--bg)]/80 p-5 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                Simulation Ended
              </p>
              {slabAddress && (
                <p className="text-[10px] font-mono text-[var(--text-secondary)]">
                  Market: {slabAddress.slice(0, 12)}...{slabAddress.slice(-12)}
                </p>
              )}
              <button
                onClick={handleRestart}
                className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-all"
              >
                Start New Simulation
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Running Simulation Dashboard ───
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Header */}
      <div className="border-b border-[var(--border)]/30 bg-[var(--bg)]/95 px-4 py-3">
        <div className="mx-auto max-w-7xl">
          <div className="flex items-start justify-between">
            <div>
              <p className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/70">
                // SIMULATION
              </p>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
                  {tokenPreview?.symbol || "SIM"}
                </h1>
                <span className="text-[12px] text-[var(--text-secondary)]">
                  {tokenPreview?.name || "Simulation"}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
                Self-service simulation — real on-chain market
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="border border-[var(--border)]/50 bg-[var(--bg-elevated)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <div
                    className="h-2 w-2"
                    style={{ backgroundColor: state.running ? "var(--long)" : "var(--short)" }}
                  />
                  <div className="text-right">
                    <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                      {state.running ? "Running" : "Stopped"}
                    </p>
                    {state.running && state.uptime > 0 && (
                      <p className="text-[9px] font-mono text-[var(--text)]">
                        {formatUptime(state.uptime)}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <button
                onClick={handleStop}
                disabled={loading}
                className="border border-[var(--short)]/50 bg-[var(--short)]/[0.08] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--short)] hover:bg-[var(--short)]/[0.15] transition-all disabled:opacity-50"
              >
                {loading ? "Ending..." : "End & Cleanup"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-3 py-3">
        <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-3">
          <div className="space-y-3">
            <SimulationControls
              isRunning={state.running}
              currentSlab={state.slabAddress || slabAddress}
              speed={speed}
              onStart={async () => {}}
              onStop={handleStop}
              onSpeedChange={handleSpeedChange}
              onPriceOverride={handlePriceOverride}
            />

            {state.running && (
              <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
                <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
                  Current Oracle Price
                </p>
                <p className="text-[24px] font-bold font-mono text-[var(--text)]">
                  ${(state.price / 1e6).toFixed(2)}
                </p>
              </div>
            )}

            {tokenPreview && (
              <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-3">
                <p className="text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] mb-1">
                  Market Token
                </p>
                <p className="text-[14px] font-bold text-[var(--text)]">{tokenPreview.symbol}</p>
                <p className="text-[10px] text-[var(--text-secondary)]">{tokenPreview.name}</p>
                {mintAddress && (
                  <p className="text-[9px] font-mono text-[var(--text-dim)] mt-1 truncate">
                    {mintAddress}
                  </p>
                )}
              </div>
            )}

            <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-3">
                Scenarios
              </h3>
              <ScenarioSelector
                activeScenario={state.scenario}
                onScenarioSelect={handleScenarioSelect}
                disabled={loading}
              />
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
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            {state.running
              ? `Model: ${state.model} | Scenario: ${state.scenario || "none"} | Speed: ${speed}x`
              : "Simulation paused"
            }
          </p>
          {(state.slabAddress || slabAddress) && (
            <p className="text-[9px] font-mono text-[var(--text-secondary)]">
              {(state.slabAddress || slabAddress || "").slice(0, 8)}...{(state.slabAddress || slabAddress || "").slice(-8)}
            </p>
          )}
        </div>
      </div>
    </div>
  );

  function phaseOrder(check: LaunchPhase): boolean {
    const order: LaunchPhase[] = ["funding-wallet", "creating", "funding", "starting"];
    const currentIdx = order.indexOf(phase);
    const checkIdx = order.indexOf(check);
    return checkIdx < currentIdx;
  }
}
