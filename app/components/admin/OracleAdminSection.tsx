"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { explorerTxUrl } from "@/lib/config";
import { useAdminActions } from "@/hooks/useAdminActions";
import type { DiscoveredMarket } from "@percolator/sdk";

// ─── Style tokens (matches admin/page.tsx) ────────────────────────────────────
const card =
  "rounded-none bg-[var(--panel-bg)] border border-[var(--border)]";
const labelStyle =
  "text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]";
const inputStyle =
  "w-full rounded-none border border-[var(--border)] bg-[#0D0D14] px-3 py-2 text-[12px] text-white placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors font-mono";

function truncatePk(pk: string) {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={labelStyle}>{children}</div>
      <div className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

// ─── Market row ───────────────────────────────────────────────────────────────

function MarketRow({
  market,
  selected,
  onClick,
}: {
  market: DiscoveredMarket;
  selected: boolean;
  onClick: () => void;
}) {
  const slabStr = market.slabAddress.toBase58();
  const oracleStr = market.config.oracleAuthority.toBase58();
  const adminStr = market.header.admin.toBase58();
  const isPaused = market.header.paused;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 hover:bg-[var(--bg-elevated)] transition-colors border-b border-[var(--border)] last:border-0 ${
        selected ? "bg-[var(--accent-subtle)] border-l-2 border-l-[var(--accent)]" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Slab address */}
          <div className="flex items-center gap-2 mb-1">
            <span
              className="inline-block w-[6px] h-[6px] rounded-full shrink-0"
              style={{ backgroundColor: isPaused ? "var(--short)" : "var(--long)" }}
            />
            <span className="text-[12px] font-mono text-white font-medium">
              {truncatePk(slabStr)}
            </span>
            {isPaused && (
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 border border-[var(--short)] text-[var(--short)]">
                PAUSED
              </span>
            )}
          </div>
          {/* Oracle authority */}
          <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
            <span className="text-[var(--text-dim)]">oracle:</span>
            <span className="font-mono text-[var(--cyan)]">{truncatePk(oracleStr)}</span>
          </div>
          {/* Admin */}
          <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
            <span className="text-[var(--text-dim)]">admin:</span>
            <span className="font-mono text-[var(--text-secondary)]">{truncatePk(adminStr)}</span>
          </div>
        </div>
        <div className="shrink-0">
          <span
            className={`text-[10px] font-bold uppercase tracking-[0.1em] px-2 py-0.5 border ${
              selected
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--text-dim)]"
            }`}
          >
            {selected ? "Selected" : "Select"}
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OracleAdminSection() {
  const wallet = useWalletCompat();
  const { markets, loading: marketsLoading, error: marketsError } = useMarketDiscovery();
  const { setOracleAuthority, loading: actionLoading } = useAdminActions();

  const [selectedMarket, setSelectedMarket] = useState<DiscoveredMarket | null>(null);
  const [newAuthority, setNewAuthority] = useState("");
  const [txResult, setTxResult] = useState<{ sig?: string; error?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const connected = !!wallet.publicKey && !!wallet.signTransaction;
  const walletStr = wallet.publicKey?.toBase58() ?? "";

  async function handleSetOracleAuthority() {
    if (!selectedMarket || !newAuthority.trim()) return;
    setSubmitting(true);
    setTxResult(null);
    try {
      const result = await setOracleAuthority(selectedMarket, newAuthority.trim());
      setTxResult({ sig: (result as any)?.signature ?? (result as any)?.sig ?? String(result) });
    } catch (err) {
      setTxResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  const isAdminOfSelected =
    selectedMarket && walletStr
      ? selectedMarket.header.admin.toBase58() === walletStr
      : false;

  const canSubmit =
    connected &&
    selectedMarket &&
    (() => { try { new PublicKey(newAuthority.trim()); return true; } catch { return false; } })() &&
    !submitting &&
    actionLoading !== "setOracleAuthority";

  return (
    <div className="mb-8">
      <SectionHeader>Oracle Authority</SectionHeader>

      {/* Wallet status banner */}
      <div className={`${card} p-4 mb-4 flex items-center justify-between gap-4`}>
        <div>
          <div className={`${labelStyle} mb-1`}>Connected Wallet</div>
          {connected ? (
            <div className="font-mono text-[12px] text-[var(--long)]">{walletStr}</div>
          ) : (
            <div className="text-[12px] text-[var(--short)]">
              No wallet connected — use the wallet button in the header to connect your creator wallet.
            </div>
          )}
        </div>
        {connected && (
          <span
            className="text-[10px] font-bold uppercase px-2 py-1 border shrink-0"
            style={{ borderColor: "var(--long)", color: "var(--long)" }}
          >
            Connected
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Market list */}
        <div className={`${card} overflow-hidden`}>
          <div className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
            <span className={labelStyle}>
              {marketsLoading
                ? "Discovering markets…"
                : `${markets.length} Market${markets.length !== 1 ? "s" : ""}`}
            </span>
            {marketsError && (
              <span className="text-[10px] text-[var(--short)] font-mono">{marketsError}</span>
            )}
          </div>
          {marketsLoading ? (
            <div className="p-6 text-center text-[11px] text-[var(--text-muted)]">
              Loading markets…
            </div>
          ) : markets.length === 0 ? (
            <div className="p-6 text-center text-[11px] text-[var(--text-muted)]">
              No markets found
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {markets.map((m) => (
                <MarketRow
                  key={m.slabAddress.toBase58()}
                  market={m}
                  selected={selectedMarket?.slabAddress.toBase58() === m.slabAddress.toBase58()}
                  onClick={() => {
                    setSelectedMarket(m);
                    setNewAuthority("");
                    setTxResult(null);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Action panel */}
        <div className={`${card} p-4`}>
          {!selectedMarket ? (
            <div className="text-center text-[var(--text-muted)] text-[12px] py-10 px-4">
              Select a market to configure oracle authority
            </div>
          ) : (
            <div className="space-y-4">
              {/* Selected market info */}
              <div>
                <div className={`${labelStyle} mb-2`}>Selected Market</div>
                <div className="p-3 bg-[#0D0D14] border border-[var(--border)] space-y-1.5">
                  <div className="text-[11px]">
                    <span className="text-[var(--text-dim)]">Slab: </span>
                    <span className="font-mono text-white">{selectedMarket.slabAddress.toBase58()}</span>
                  </div>
                  <div className="text-[11px]">
                    <span className="text-[var(--text-dim)]">Current oracle authority: </span>
                    <span className="font-mono text-[var(--cyan)]">
                      {selectedMarket.config.oracleAuthority.toBase58()}
                    </span>
                  </div>
                  <div className="text-[11px]">
                    <span className="text-[var(--text-dim)]">Admin: </span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {selectedMarket.header.admin.toBase58()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Not admin warning */}
              {connected && !isAdminOfSelected && (
                <div className="p-3 border border-[var(--warning)] bg-[rgba(255,183,0,0.05)]">
                  <div className="text-[11px] text-[var(--warning)]">
                    ⚠ Your connected wallet is not the admin of this market. The transaction will fail on-chain.
                  </div>
                </div>
              )}

              {/* New authority input */}
              <div>
                <div className={`${labelStyle} mb-1`}>New Oracle Authority</div>
                <input
                  type="text"
                  value={newAuthority}
                  onChange={(e) => {
                    setNewAuthority(e.target.value);
                    setTxResult(null);
                  }}
                  className={inputStyle}
                  placeholder="Enter Solana pubkey…"
                  spellCheck={false}
                />
                <div className="mt-1 text-[10px] text-[var(--text-dim)]">
                  The new account that will be permitted to push oracle prices for this market.
                </div>
              </div>

              {/* Submit */}
              <button
                onClick={handleSetOracleAuthority}
                disabled={!canSubmit}
                className="w-full rounded-none bg-[var(--accent)] px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.15em] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting || actionLoading === "setOracleAuthority"
                  ? "Signing…"
                  : "Set Oracle Authority"}
              </button>

              {!connected && (
                <div className="text-[11px] text-[var(--text-muted)] text-center">
                  Connect your wallet above to sign transactions.
                </div>
              )}

              {/* Result */}
              {txResult && (
                <div
                  className={`p-3 border ${
                    txResult.error
                      ? "border-[var(--short)] bg-[rgba(255,60,60,0.05)]"
                      : "border-[var(--long)] bg-[rgba(0,200,83,0.05)]"
                  }`}
                >
                  {txResult.error ? (
                    <div className="text-[11px] text-[var(--short)] break-all">
                      ✗ {txResult.error}
                    </div>
                  ) : (
                    <div>
                      <div className="text-[11px] text-[var(--long)] mb-1">
                        ✓ Oracle authority updated
                      </div>
                      <a
                        href={explorerTxUrl(txResult.sig!)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] font-mono text-[var(--accent)] hover:underline break-all"
                      >
                        {txResult.sig}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
