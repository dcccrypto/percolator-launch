"use client";

import { useState, useEffect } from "react";
import { ScenarioSelector } from "@/components/simulation/ScenarioSelector";
import { SimulationControls } from "@/components/simulation/SimulationControls";
import { LiveEventFeed } from "@/components/simulation/LiveEventFeed";
import { SimulationMetrics } from "@/components/simulation/SimulationMetrics";
import { BotLeaderboard } from "@/components/simulation/BotLeaderboard";

interface SimulationState {
  running: boolean;
  slabAddress: string | null;
  price: number;
  scenario: string | null;
  model: string;
  uptime: number;
}

export default function SimulationPage() {
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

  // Poll simulation state every 2 seconds
  useEffect(() => {
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
        }
      } catch (error) {
        console.error("Failed to fetch simulation state:", error);
      }
    };

    // Initial fetch
    fetchState();

    // Poll every 2 seconds
    const interval = setInterval(fetchState, 2000);

    return () => clearInterval(interval);
  }, []);

  const handleStart = async (slabAddress: string, startPriceE6?: number) => {
    setLoading(true);
    try {
      const response = await fetch("/api/simulation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slabAddress,
          startPriceE6,
          scenario: state.scenario,
          intervalMs: 5000 / speed,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to start simulation: ${error.details || error.error}`);
        return;
      }

      const data = await response.json();
      setState({
        running: true,
        slabAddress: data.state.slabAddress,
        price: data.state.startPriceE6,
        scenario: data.state.scenario,
        model: data.state.model,
        uptime: 0,
      });
    } catch (error) {
      console.error("Start simulation error:", error);
      alert("Failed to start simulation");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/simulation/stop", {
        method: "POST",
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to stop simulation: ${error.details || error.error}`);
        return;
      }

      setState({
        running: false,
        slabAddress: null,
        price: 100_000000,
        scenario: null,
        model: "random-walk",
        uptime: 0,
      });
    } catch (error) {
      console.error("Stop simulation error:", error);
      alert("Failed to stop simulation");
    } finally {
      setLoading(false);
    }
  };

  const handleScenarioSelect = async (scenarioId: string, params?: Record<string, number>) => {
    try {
      const response = await fetch("/api/simulation/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario: scenarioId,
          params,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to set scenario: ${error.details || error.error}`);
        return;
      }

      setState((prev) => ({ ...prev, scenario: scenarioId }));
    } catch (error) {
      console.error("Set scenario error:", error);
      alert("Failed to set scenario");
    }
  };

  const handlePriceOverride = async (priceE6: number) => {
    try {
      const response = await fetch("/api/simulation/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceE6 }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Failed to set price: ${error.details || error.error}`);
        return;
      }

      setState((prev) => ({ ...prev, price: priceE6 }));
    } catch (error) {
      console.error("Price override error:", error);
      alert("Failed to override price");
    }
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    // If simulation is running, we'd need to restart with new interval
    // For now, just update local state
  };

  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

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
              <h1 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
                Control Panel
              </h1>
              <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
                Real-time bot trading simulation dashboard
              </p>
            </div>

            {/* Status Badge */}
            <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg-elevated)] px-3 py-2">
              <div className="flex items-center gap-2">
                <div 
                  className="h-2 w-2 rounded-full"
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
              currentSlab={state.slabAddress}
              speed={speed}
              onStart={handleStart}
              onStop={handleStop}
              onSpeedChange={handleSpeedChange}
              onPriceOverride={handlePriceOverride}
            />

            {/* Current Price Display */}
            {state.running && (
              <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
                <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
                  Current Oracle Price
                </p>
                <p className="text-[24px] font-bold font-mono text-[var(--text)]">
                  ${(state.price / 1e6).toFixed(2)}
                </p>
              </div>
            )}

            {/* Scenario Selector */}
            <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
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
            {/* Top Row - Metrics & Events */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <SimulationMetrics isSimulationRunning={state.running} />
              <LiveEventFeed isSimulationRunning={state.running} />
            </div>

            {/* Bottom Row - Leaderboard */}
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
              : "Configure simulation parameters and start to begin"
            }
          </p>
          
          {state.slabAddress && (
            <p className="text-[9px] font-mono text-[var(--text-secondary)]">
              {state.slabAddress.slice(0, 8)}...{state.slabAddress.slice(-8)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
