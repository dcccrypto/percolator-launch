"use client";

import bs58 from "bs58";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildVoteMessage, VOTE_CHOICE_LABELS, VOTE_CHOICES, VOTE_NONCE_RE, VOTE_TS_RE, type VoteChoice } from "@/lib/allocation-vote/vote-message";
import { connectWallet, discoverWallets, signText, type StdAccount, type StdWallet } from "./wallet-standard";

type Status = { state: "not_started" | "open" | "closed"; starts_at: string | null; ends_at: string | null; server_now: string | null };
type Results = {
  winner: VoteChoice;
  results: Record<VoteChoice, { balance: string; wallets: number; share_of_votes_percent: string }>;
  turnout: { voted_balance: string; eligible_balance: string; percent: string };
};
type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: string }
  | { kind: "done"; choice: VoteChoice; revision: number }
  | { kind: "error"; message: string };

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "omit" });

function fmtTime(iso: string | null) {
  return iso ? new Date(iso).toUTCString().replace("GMT", "UTC") : "";
}

export function VoteClient() {
  const [status, setStatus] = useState<Status | null | "unavailable">(null);
  const [results, setResults] = useState<Results | null>(null);
  const [wallets, setWallets] = useState<StdWallet[]>([]);
  const [wallet, setWallet] = useState<StdWallet | null>(null);
  const [account, setAccount] = useState<StdAccount | null>(null);
  const [choice, setChoice] = useState<VoteChoice | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/vote/status", { cache: "no-store", credentials: "omit" });
      const b = await r.json().catch(() => null);
      if (!r.ok || b?.status !== "ok") return setStatus("unavailable");
      setStatus(b as Status);
      if (b.state === "closed") {
        const rr = await fetch("/api/vote/results", { cache: "no-store", credentials: "omit" });
        const rb = await rr.json().catch(() => null);
        if (rr.ok && rb?.status === "final") setResults(rb as Results);
      }
    } catch {
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    void load();
    return discoverWallets(setWallets);
  }, [load]);

  async function onConnect(w: StdWallet) {
    setPhase({ kind: "idle" });
    try {
      const a = await connectWallet(w);
      if (!a) throw new Error("no account");
      setWallet(w);
      setAccount(a);
    } catch {
      setPhase({ kind: "error", message: "Wallet connection was cancelled or failed." });
    }
  }

  async function onVote() {
    if (!wallet || !account || !choice || busy.current) return;
    busy.current = true;
    try {
      setPhase({ kind: "busy", step: "Requesting a one-time signature request" });
      const cr = await post("/api/vote/challenge", { wallet: account.address, choice });
      const c = await cr.json().catch(() => null);
      if (!cr.ok || c?.status !== "ok") throw new Error(c?.error ?? "Vote unavailable. Try again later.");
      if (typeof c.nonce !== "string" || !VOTE_NONCE_RE.test(c.nonce) || typeof c.issuedAt !== "string" || !VOTE_TS_RE.test(c.issuedAt) || typeof c.expiresAt !== "string" || !VOTE_TS_RE.test(c.expiresAt)) {
        throw new Error("Unexpected signature request. Nothing was signed.");
      }
      // Sign only the text this page expects for this wallet and choice.
      const expected = buildVoteMessage({ choice, wallet: account.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt });
      if (c.message !== expected || c.wallet !== account.address || c.choice !== choice) throw new Error("Unexpected signature request. Nothing was signed.");
      setPhase({ kind: "busy", step: "Approve the message in your wallet (no transaction, no fees)" });
      let sig: Uint8Array;
      try {
        sig = await signText(wallet, account, expected);
      } catch {
        throw new Error("Signing was cancelled or is not supported by this wallet.");
      }
      setPhase({ kind: "busy", step: "Recording your vote" });
      const sr = await post("/api/vote/submit", {
        wallet: account.address, choice, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, signature: bs58.encode(sig),
      });
      const s = await sr.json().catch(() => null);
      if (!sr.ok || s?.status !== "recorded") throw new Error(s?.error ?? "Vote unavailable. Try again later.");
      setPhase({ kind: "done", choice: s.choice, revision: s.revision });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Vote unavailable. Try again later." });
    } finally {
      busy.current = false;
    }
  }

  if (status === null) return <p className="text-[14px] text-[var(--text-secondary)]">Loading vote status</p>;
  if (status === "unavailable") {
    return <p data-testid="vote-state" data-state="unavailable" role="alert" className="text-[14px] text-[var(--text)]">Vote unavailable. Try again later.</p>;
  }
  if (status.state === "not_started") {
    return <p data-testid="vote-state" data-state="not_started" className="text-[15px] text-[var(--text)]">Voting has not started yet.</p>;
  }
  if (status.state === "closed") {
    return (
      <div data-testid="vote-state" data-state="closed">
        <p className="mb-3 text-[15px] text-[var(--text)]">Voting closed {fmtTime(status.ends_at)}.</p>
        {results ? (
          <div data-testid="vote-results" className="text-[14px] text-[var(--text)]">
            <p className="mb-2 font-semibold">Result: {VOTE_CHOICE_LABELS[results.winner]}</p>
            {VOTE_CHOICES.map((k) => (
              <p key={k} className="font-mono text-[13px]">
                {VOTE_CHOICE_LABELS[k]}: {results.results[k].balance} PERC ({results.results[k].share_of_votes_percent}%), {results.results[k].wallets} wallets
              </p>
            ))}
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">Turnout {results.turnout.percent}% of eligible snapshot balance.</p>
          </div>
        ) : (
          <p className="text-[14px] text-[var(--text-secondary)]">Final results are being tallied and appear shortly after close. Refresh in a minute.</p>
        )}
      </div>
    );
  }

  return (
    <div data-testid="vote-state" data-state="open">
      <p className="mb-4 text-[15px] text-[var(--text)]">Voting is open until {fmtTime(status.ends_at)}.</p>
      {!account ? (
        <div className="mb-6">
          {wallets.length === 0 ? (
            <p className="text-[14px] text-[var(--text-secondary)]">No Solana wallet with message signing was found in this browser.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {wallets.map((w) => (
                <button key={w.name} type="button" onClick={() => onConnect(w)} className="rounded border border-[var(--border)] px-3 py-2 text-[14px] text-[var(--text)]">
                  Connect {w.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p data-testid="vote-wallet" className="mb-4 break-all font-mono text-[13px] text-[var(--text-secondary)]">Wallet: {account.address}</p>
      )}
      <fieldset className="mb-4" disabled={phase.kind === "busy"}>
        <legend className="mb-2 text-[14px] text-[var(--text)]">Your choice</legend>
        {VOTE_CHOICES.map((k) => (
          <label key={k} className="mb-1 flex items-center gap-2 text-[14px] text-[var(--text)]">
            <input type="radio" name="vote-choice" value={k} checked={choice === k} onChange={() => setChoice(k)} />
            {VOTE_CHOICE_LABELS[k]}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        data-testid="vote-submit"
        onClick={onVote}
        disabled={!account || !choice || phase.kind === "busy"}
        className="rounded border border-[var(--border)] px-4 py-2 text-[14px] font-semibold text-[var(--text)] disabled:opacity-50"
      >
        Sign and vote
      </button>
      <div aria-live="polite" className="mt-4 text-[14px] text-[var(--text)]">
        {phase.kind === "busy" && <p>{phase.step}</p>}
        {phase.kind === "done" && (
          <p data-testid="vote-result" data-status="recorded">
            Vote recorded: {VOTE_CHOICE_LABELS[phase.choice]}{phase.revision > 1 ? " (replaces your earlier vote)" : ""}. You can change it until voting closes.
          </p>
        )}
        {phase.kind === "error" && <p data-testid="vote-result" data-status="error" role="alert">{phase.message}</p>}
      </div>
    </div>
  );
}
