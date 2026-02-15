"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction, TransactionInstruction, PublicKey, Keypair } from "@solana/web3.js";
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

type SetupStep = "connect" | "preview" | "creating" | "funding" | "running" | "ended";

export default function SimulationPage() {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [setupStep, setSetupStep] = useState<SetupStep>("connect");
  const [tokenPreview, setTokenPreview] = useState<TokenPreview | null>(null);
  const [estimatedCost, setEstimatedCost] = useState<number>(0);
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
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [airdropping, setAirdropping] = useState(false);

  // Fetch SOL balance
  useEffect(() => {
    if (!publicKey || !connected) { setSolBalance(null); return; }
    const fetch = async () => {
      try {
        const bal = await connection.getBalance(publicKey);
        setSolBalance(bal / 1e9);
      } catch { setSolBalance(null); }
    };
    fetch();
    const iv = setInterval(fetch, 5000);
    return () => clearInterval(iv);
  }, [publicKey, connected, connection]);

  const handleAirdrop = async () => {
    if (!publicKey) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(publicKey, 2e9); // 2 SOL
      await connection.confirmTransaction(sig, "confirmed");
      const bal = await connection.getBalance(publicKey);
      setSolBalance(bal / 1e9);
    } catch (e) {
      console.error("Airdrop failed:", e);
    } finally {
      setAirdropping(false);
    }
  };

  // Update step based on wallet connection
  useEffect(() => {
    if (!connected && setupStep === "connect") return;
    if (connected && setupStep === "connect") {
      setSetupStep("preview");
      fetchTokenPreview();
    }
    if (!connected && setupStep !== "connect") {
      setSetupStep("connect");
      setTokenPreview(null);
    }
  }, [connected]);

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

  // Poll simulation state when running
  useEffect(() => {
    if (setupStep !== "running") return;

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
            setSetupStep("ended");
          }
        }
      } catch (error) {
        console.error("Failed to fetch simulation state:", error);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 2000);
    return () => clearInterval(interval);
  }, [setupStep]);

  const refreshToken = () => {
    fetchTokenPreview();
  };

  interface InstructionGroupData {
    label: string;
    instructions: {
      programId: string;
      keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string; // base64
    }[];
    signers: string[]; // base64 secret keys
  }

  const sendInstructionGroups = async (groups: InstructionGroupData[]): Promise<boolean> => {
    if (!signTransaction || !publicKey) return false;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      setTxProgress({ current: i + 1, total: groups.length, label: group.label });

      try {
        // Get fresh blockhash for each transaction
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        const tx = new Transaction();
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = publicKey;

        // Add instructions
        for (const ix of group.instructions) {
          tx.add(new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map(k => ({
              pubkey: new PublicKey(k.pubkey),
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            data: Buffer.from(ix.data, 'base64'),
          }));
        }

        // Partial sign with server-provided keypairs
        if (group.signers.length > 0) {
          const keypairs = group.signers.map(s => Keypair.fromSecretKey(Buffer.from(s, 'base64')));
          tx.partialSign(...keypairs);
        }

        // Wallet sign
        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction(sig, "confirmed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed at step ${i + 1} (${group.label}): ${msg}`);
      }
    }

    return true;
  };

  const handleCreateAndStart = async () => {
    if (!publicKey) return;
    setError(null);
    setSetupStep("creating");

    try {
      // Step 1: Create market
      setTxProgress({ current: 0, total: 5, label: "Preparing market..." });

      const createRes = await fetch("/api/simulation/create-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payerPublicKey: publicKey.toBase58() }),
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
      setEstimatedCost(createData.estimatedCostSol);

      // Sign and send create transactions (fresh blockhash per tx)
      await sendInstructionGroups(createData.instructionGroups);

      // Step 2: Fund market
      setSetupStep("funding");
      setTxProgress({ current: 0, total: 2, label: "Minting tokens..." });

      const fundRes = await fetch("/api/simulation/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payerPublicKey: publicKey.toBase58(),
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

      await sendInstructionGroups(fundData.instructionGroups);

      // Step 3: Start simulation
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

      setSetupStep("running");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSetupStep("preview");
    }
  };

  const handleStop = async () => {
    if (!publicKey) return;
    setLoading(true);

    try {
      await fetch("/api/simulation/stop", { method: "POST" });
      await fetch("/api/simulation/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payerPublicKey: publicKey.toBase58() }),
      });

      setState({ running: false, slabAddress: null, price: 100_000000, scenario: null, model: "random-walk", uptime: 0 });
      setSetupStep("ended");
    } catch (err) {
      console.error("Stop error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = () => {
    setSetupStep("preview");
    setSlabAddress(null);
    setMintAddress(null);
    setError(null);
    setTokenPreview(null);
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
    } catch (error) {
      console.error("Set scenario error:", error);
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
    } catch (error) {
      console.error("Price override error:", error);
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

  // ─── Setup Flow (not yet running) ───
  if (setupStep !== "running") {
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
              Create a market, mint tokens, and run a bot trading simulation
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
          {/* Step 1: Connect Wallet */}
          <StepCard
            number={1}
            title="Connect Wallet"
            active={setupStep === "connect"}
            complete={connected}
          >
            {!connected ? (
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-[var(--text-secondary)]">
                  Connect your Solana wallet to get started. You will need ~0.5 SOL for rent.
                </p>
                <WalletMultiButton />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2" style={{ backgroundColor: "var(--long)" }} />
                  <span className="text-[11px] font-mono text-[var(--text)]">
                    {publicKey?.toBase58().slice(0, 8)}...{publicKey?.toBase58().slice(-8)}
                  </span>
                  {solBalance !== null && (
                    <span className={`text-[11px] font-mono ${solBalance < 0.5 ? "text-[var(--short)]" : "text-[var(--text-secondary)]"}`}>
                      {solBalance.toFixed(3)} SOL
                    </span>
                  )}
                </div>
                {solBalance !== null && solBalance < 0.5 && (
                  <div className="flex items-center justify-between border border-[var(--short)]/20 bg-[var(--short)]/[0.04] p-2">
                    <span className="text-[10px] text-[var(--short)]">
                      Need ~0.5 SOL. This is devnet — airdrop is free.
                    </span>
                    <button
                      onClick={handleAirdrop}
                      disabled={airdropping}
                      className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-3 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:opacity-50"
                    >
                      {airdropping ? "Airdropping..." : "Airdrop 2 SOL"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </StepCard>

          {/* Step 2: Token Preview */}
          <StepCard
            number={2}
            title="Random Token"
            active={setupStep === "preview"}
            complete={setupStep === "creating" || setupStep === "funding" || setupStep === "ended"}
          >
            {setupStep === "preview" && tokenPreview ? (
              <div className="space-y-3">
                <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
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
                      onClick={refreshToken}
                      className="border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors"
                    >
                      Reroll
                    </button>
                  </div>
                </div>
                <p className="text-[9px] text-[var(--text-dim)]">
                  A random memecoin-style token will be created on-chain. The actual token is revealed after creation.
                </p>
              </div>
            ) : tokenPreview && (setupStep === "creating" || setupStep === "funding") ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-[var(--accent)]">{tokenPreview.symbol}</span>
                <span className="text-[11px] text-[var(--text)]">{tokenPreview.name}</span>
              </div>
            ) : null}
          </StepCard>

          {/* Step 3: Create & Start */}
          <StepCard
            number={3}
            title="Create Market & Start"
            active={setupStep === "preview" || setupStep === "creating" || setupStep === "funding"}
            complete={setupStep === "ended"}
          >
            {setupStep === "preview" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between border border-[var(--border)] bg-[var(--bg)] p-3">
                  <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                    Estimated Cost
                  </span>
                  <span className="text-[13px] font-bold font-mono text-[var(--text)]">
                    ~0.5 SOL <span className="text-[9px] text-[var(--text-dim)] font-normal">(reclaimable)</span>
                  </span>
                </div>
                <p className="text-[9px] text-[var(--text-dim)]">
                  Creates an SPL mint, market slab, vault, and LP. You will sign ~5 transactions.
                  Rent is reclaimable by closing the market after.
                </p>

                {error && (
                  <div className="border border-[var(--short)]/30 bg-[var(--short)]/[0.04] p-3">
                    <p className="text-[10px] text-[var(--short)]">{error}</p>
                  </div>
                )}

                <button
                  onClick={handleCreateAndStart}
                  disabled={!connected}
                  className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[12px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create Market & Start Simulation
                </button>
              </div>
            )}

            {(setupStep === "creating" || setupStep === "funding") && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                  <span className="text-[11px] text-[var(--text)]">{txProgress.label}</span>
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
                <p className="text-[9px] text-[var(--text-dim)]">
                  Please approve each transaction in your wallet. Do not close this page.
                </p>
              </div>
            )}
          </StepCard>

          {/* Ended state */}
          {setupStep === "ended" && (
            <div className="border border-[var(--border)] bg-[var(--bg)]/80 p-5 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                Simulation Ended
              </p>
              {slabAddress && (
                <p className="text-[10px] font-mono text-[var(--text-secondary)]">
                  Market: {slabAddress.slice(0, 12)}...{slabAddress.slice(-12)}
                </p>
              )}
              <p className="text-[10px] text-[var(--text-dim)]">
                The market remains on-chain. Close the slab account to reclaim rent (~0.5 SOL).
              </p>
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
              {/* Status Badge */}
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

              {/* End Button */}
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
          {/* Left Sidebar - Controls */}
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

            {/* Current Price Display */}
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

            {/* Token Info */}
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

            {/* Scenario Selector */}
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

          {/* Right Side - Dashboard */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <SimulationMetrics isSimulationRunning={state.running} />
              <LiveEventFeed isSimulationRunning={state.running} />
            </div>
            <BotLeaderboard isSimulationRunning={state.running} />
          </div>
        </div>
      </div>

      {/* Info Footer */}
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
}

// ─── Step Card Component ───

function StepCard({
  number,
  title,
  active,
  complete,
  children,
}: {
  number: number;
  title: string;
  active: boolean;
  complete: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`border p-4 transition-colors ${
        active
          ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.02]"
          : complete
          ? "border-[var(--accent)]/20 bg-[var(--bg)]/80"
          : "border-[var(--border)]/30 bg-[var(--bg)]/80 opacity-50"
      }`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className={`flex h-5 w-5 items-center justify-center border text-[9px] font-bold ${
            complete
              ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.08] text-[var(--accent)]"
              : active
              ? "border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-dim)]"
          }`}
        >
          {complete ? "\u2713" : number}
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          {title}
        </span>
      </div>
      {(active || complete) && children}
    </div>
  );
}
