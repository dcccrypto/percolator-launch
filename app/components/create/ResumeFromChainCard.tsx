"use client";

import { FC, useEffect, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { isV17Account, parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { searchVerifiedPools } from "@/hooks/useDexPoolSearch";
import { fetchTokenMeta } from "@/lib/tokenMeta";
import { getConfig, getNetwork } from "@/lib/config";
import { isMarketauthComplete } from "@/lib/market-completeness";
import { readMarketGroupHeader } from "@/lib/v18-wire";
import { leverageFromMarginBps } from "@/lib/market-params";
import { parseHumanAmount } from "@/lib/parseAmount";
import {
  adoptRecoveredLaunch,
  atomsToHuman,
  CANNOT_RESUME_COPY,
  inferResumeStep,
  recoverLaunchFromChain,
  RECOVERY_COPY,
  type RecoveredLaunch,
} from "@/lib/launch-recovery";

/** What the chain says about the slab a creator asked to resume. */
export type ResumeChainState =
  | { kind: "loading" }
  | { kind: "unreadable" }
  | { kind: "not-a-market" }
  | { kind: "not-yours" }
  | { kind: "finished" }
  | { kind: "ready"; step: 1 | 2 | 3; funded: boolean };

/** Pure: classify a slab's bytes for a resume by `wallet`. Exported for the test. */
export function classifyResumeSlab(
  data: Uint8Array | null | undefined,
  slab: PublicKey,
  wallet: PublicKey,
  completeFn: (marketauth: PublicKey, slab: PublicKey) => boolean = isMarketauthComplete,
): ResumeChainState {
  if (!data) return { kind: "not-a-market" };
  try {
    if (!isV17Account(data)) return { kind: "not-a-market" };
    const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
    // The creator is marketauth until the final step rotates it. Anyone else gets nothing here.
    if (completeFn(cfg.marketauth, slab)) return { kind: "finished" };
    if (!cfg.marketauth.equals(wallet)) return { kind: "not-yours" };
    const h = readMarketGroupHeader(data);
    return { kind: "ready", step: inferResumeStep({ portfolios: h.materializedPortfolioCount, cTot: h.cTot }), funded: h.cTot > 0n };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * /create?resume=<slab>: continue an unfinished launch from any browser (#3267). Reads the market from
 * chain, asks for the token's address (the one fact the chain does not carry in the clear), proves the
 * answer against the registration memo in the creation transaction, and only then hands the verified
 * launch to the wizard. Nothing is signed or sent here.
 */
export const ResumeFromChainCard: FC<{
  slab: string;
  onVerified: (launch: RecoveredLaunch, step: 1 | 2 | 3) => void;
}> = ({ slab, onVerified }) => {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [chain, setChain] = useState<ResumeChainState>({ kind: "loading" });
  const [ca, setCa] = useState("");
  const [lp, setLp] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [verified, setVerified] = useState<RecoveredLaunch | null>(null);
  const walletB58 = wallet.publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!wallet.publicKey) return;
    let cancelled = false;
    setChain({ kind: "loading" });
    const slabPk = new PublicKey(slab);
    connection
      .getAccountInfo(slabPk)
      .then((info) => {
        if (!cancelled) setChain(classifyResumeSlab(info ? new Uint8Array(info.data) : null, slabPk, wallet.publicKey!));
      })
      .catch(() => {
        if (!cancelled) setChain({ kind: "unreadable" });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, slab, walletB58]); // eslint-disable-line react-hooks/exhaustive-deps

  const verify = async () => {
    if (!wallet.publicKey || chain.kind !== "ready") return;
    setBusy(true);
    setNote(null);
    const r = await recoverLaunchFromChain(
      {
        connection,
        wrapperProgramId: getConfig().programId as string,
        crankWallet: getConfig().crankWallet as string | undefined,
        isDevnetEnv: getNetwork() === "devnet",
        searchPools: (m) => searchVerifiedPools(m),
        fetchMeta: (m) => fetchTokenMeta(connection, m),
      },
      { slab, wallet: wallet.publicKey.toBase58(), mainnetCA: ca, lpCandidates: lp.trim() ? [parseHumanAmount(lp, 6)] : undefined },
    );
    setBusy(false);
    if (!r.ok) {
      setNote(RECOVERY_COPY[r.reason]);
      return;
    }
    // Same files the launching browser would have written, so the registration at the end of the
    // launch finds the exact proof and payload the memo bound.
    adoptRecoveredLaunch(r.launch);
    setVerified(r.launch);
    onVerified(r.launch, chain.step);
  };

  const box = "mb-4 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] p-4";
  const short = `${slab.slice(0, 6)}…${slab.slice(-4)}`;

  if (!wallet.publicKey) {
    return <div data-testid="resume-chain-card" className={box}><p className="text-[11px] text-[var(--text-secondary)]">Connect the wallet that launched {short} to continue it.</p></div>;
  }
  if (chain.kind === "loading") {
    return <div data-testid="resume-chain-card" className={box}><p className="text-[11px] text-[var(--text-secondary)]">Reading {short} from the chain…</p></div>;
  }
  if (chain.kind !== "ready") {
    const msg =
      chain.kind === "finished"
        ? "This launch is already finished. If its live price isn't connected, do that from My Markets."
        : chain.kind === "not-yours"
          ? "This launch wasn't made by the connected wallet, so it can't be continued from here."
          : chain.kind === "not-a-market"
            ? `${short} isn't an initialised market, so there is nothing on chain to continue. ${CANNOT_RESUME_COPY.step0}`
            : "Couldn't read this launch from the chain just now. Try again in a moment.";
    return (
      <div data-testid="resume-chain-card" data-state={chain.kind} className={box}>
        <p className="text-[11px] text-[var(--text-secondary)]">{msg}</p>
        <Link href="/my-markets" className="mt-2 inline-block text-[10px] uppercase tracking-[0.1em] text-[var(--accent)] hover:brightness-125">My Markets →</Link>
      </div>
    );
  }

  return (
    <div data-testid="resume-chain-card" data-state={verified ? "verified" : "ready"} className={box}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent)]">Continue launch {short}</p>
      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
        This browser didn&apos;t start this launch, so it rebuilds it from the chain. The one thing the chain doesn&apos;t
        say is which token the market prices: enter that token&apos;s mainnet address and it is checked against the
        registration signed in the launch&apos;s first transaction. Nothing is sent until you launch.
      </p>
      {!verified ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            data-testid="resume-chain-ca"
            value={ca}
            onChange={(e) => setCa(e.target.value)}
            placeholder="token address (mainnet)"
            className="min-w-[16rem] flex-1 border border-[var(--border)]/50 bg-transparent px-3 py-2 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]/40"
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <button
            type="button"
            data-testid="resume-chain-verify"
            disabled={busy || !ca.trim()}
            onClick={verify}
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15] disabled:opacity-50"
          >
            {busy ? "checking…" : "verify and continue"}
          </button>
          {!chain.funded && (
            <input
              data-testid="resume-chain-lp"
              value={lp}
              onChange={(e) => setLp(e.target.value)}
              placeholder="liquidity you chose (if nothing is deposited yet)"
              inputMode="decimal"
              className="min-w-[16rem] flex-1 border border-[var(--border)]/50 bg-transparent px-3 py-2 text-[11px] text-[var(--text)] outline-none focus:border-[var(--accent)]/40"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          )}
        </div>
      ) : (
        <div data-testid="resume-chain-summary" className="mt-3 text-[11px] text-[var(--text)]">
          <p>
            Verified: <span className="font-semibold">{verified.symbol}</span> ({verified.name}) on pool {verified.poolAddress.slice(0, 6)}…, {leverageFromMarginBps(verified.initialMarginBps)}x,{" "}
            {verified.tradingFeeBps} bps fee, {atomsToHuman(verified.lpCollateralAtoms, 6)} liquidity seed.
          </p>
          <p className="mt-1 text-[var(--text-secondary)]">
            It resumes at step {chain.step} and skips whatever already landed. Continue below to review and launch.
          </p>
        </div>
      )}
      {note && <p data-testid="resume-chain-note" className="mt-2 text-[10px] text-[var(--short)]">{note}</p>}
      <p className="mt-3 text-[10px] text-[var(--text-dim)]">
        {chain.funded ? "Its funds are already in the market; finishing it is the only way forward." : "Nothing is deposited yet: instead of continuing you can reclaim its rent from My Markets."}
      </p>
    </div>
  );
};
