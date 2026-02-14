"use client";

import { useState } from "react";

interface SimulationControlsProps {
  isRunning: boolean;
  currentSlab: string | null;
  speed: number;
  onStart: (slabAddress: string, startPrice?: number) => Promise<void>;
  onStop: () => Promise<void>;
  onSpeedChange: (speed: number) => void;
  onPriceOverride: (priceE6: number) => Promise<void>;
}

const SPEED_OPTIONS = [
  { value: 1, label: "1x" },
  { value: 2, label: "2x" },
  { value: 5, label: "5x" },
];

export function SimulationControls({
  isRunning,
  currentSlab,
  speed,
  onStart,
  onStop,
  onSpeedChange,
  onPriceOverride,
}: SimulationControlsProps) {
  const [slabInput, setSlabInput] = useState("");
  const [startPriceInput, setStartPriceInput] = useState("100");
  const [priceOverrideInput, setPriceOverrideInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleStartStop = async () => {
    setLoading(true);
    try {
      if (isRunning) {
        await onStop();
      } else {
        const slab = slabInput.trim() || currentSlab;
        if (!slab) {
          alert("Please enter a slab address");
          return;
        }
        const startPrice = parseFloat(startPriceInput) || 100;
        await onStart(slab, startPrice * 1e6);
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePriceOverride = async () => {
    const price = parseFloat(priceOverrideInput);
    if (isNaN(price) || price <= 0) {
      alert("Invalid price");
      return;
    }
    
    setLoading(true);
    try {
      await onPriceOverride(Math.round(price * 1e6));
      setPriceOverrideInput("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Simulation Control
        </h3>
        
        {/* Status Indicator */}
        <div className="flex items-center gap-1.5">
          <div 
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: isRunning ? "var(--long)" : "var(--short)" }}
          />
          <span className="text-[9px] uppercase tracking-[0.15em] font-mono" style={{ color: isRunning ? "var(--long)" : "var(--short)" }}>
            {isRunning ? "Running" : "Stopped"}
          </span>
        </div>
      </div>

      {/* Current Market */}
      {currentSlab && (
        <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] px-2 py-1.5">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">
            Active Market
          </p>
          <p className="text-[9px] font-mono text-[var(--text)] truncate">
            {currentSlab.slice(0, 8)}...{currentSlab.slice(-8)}
          </p>
        </div>
      )}

      {/* Slab Address Input (when not running) */}
      {!isRunning && (
        <div>
          <label className="block text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Market Address
          </label>
          <input
            type="text"
            value={slabInput}
            onChange={(e) => setSlabInput(e.target.value)}
            placeholder={currentSlab || "Enter slab address..."}
            className="w-full rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[10px] font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
      )}

      {/* Start Price Input (when not running) */}
      {!isRunning && (
        <div>
          <label className="block text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Starting Price USD
          </label>
          <input
            type="number"
            value={startPriceInput}
            onChange={(e) => setStartPriceInput(e.target.value)}
            placeholder="100"
            step="0.01"
            min="0"
            className="w-full rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[10px] font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
      )}

      {/* Speed Control (when running) */}
      {isRunning && (
        <div>
          <label className="block text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Update Speed
          </label>
          <div className="flex gap-1">
            {SPEED_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => onSpeedChange(option.value)}
                className={`
                  flex-1 rounded-none border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] transition-colors
                  ${speed === option.value
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "border-[var(--border)]/50 bg-[var(--bg)]/80 text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
                  }
                `}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Manual Price Override (when running) */}
      {isRunning && (
        <div>
          <label className="block text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Manual Price Override
          </label>
          <div className="flex gap-1">
            <input
              type="number"
              value={priceOverrideInput}
              onChange={(e) => setPriceOverrideInput(e.target.value)}
              placeholder="Enter price..."
              step="0.01"
              min="0"
              className="flex-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[10px] font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              onClick={handlePriceOverride}
              disabled={!priceOverrideInput || loading}
              className="rounded-none border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Set
            </button>
          </div>
        </div>
      )}

      {/* Start/Stop Button */}
      <button
        onClick={handleStartStop}
        disabled={loading}
        className={`
          w-full rounded-none border px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] transition-all
          ${isRunning
            ? "border-[var(--short)] bg-[var(--short)]/10 text-[var(--short)] hover:bg-[var(--short)]/20"
            : "border-[var(--long)] bg-[var(--long)]/10 text-[var(--long)] hover:bg-[var(--long)]/20"
          }
          ${loading ? "opacity-50 cursor-not-allowed" : ""}
        `}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <div className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            {isRunning ? "Stopping..." : "Starting..."}
          </span>
        ) : (
          isRunning ? "Stop Simulation" : "Start Simulation"
        )}
      </button>
    </div>
  );
}
