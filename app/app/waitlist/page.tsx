"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignMessage } from "@privy-io/react-auth/solana";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { resolveActiveWallet, usePreferredWallet } from "@/hooks/usePreferredWallet";
import bs58 from "bs58";

type State =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "signing" }
  | { kind: "submitting" }
  | { kind: "done"; position: number | null }
  | { kind: "error"; reason: string };

const MESSAGE_PREFIX = "Joining the Percolator waitlist at ";

function buildMessage(pubkey: string): string {
  const ts = new Date().toISOString();
  return `${MESSAGE_PREFIX}${ts} | ${pubkey}`;
}

// Tiny smooth count-up. Starts at zero, animates to the target over ~1.2s.
function useCountUp(target: number, durationMs = 1200) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (target === 0) {
      setV(0);
      return;
    }
    const start = performance.now();
    const from = v;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - k, 3);
      setV(Math.round(from + (target - from) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return v;
}

export default function WaitlistPage() {
  return (
    <div className="waitlist-root">
      <BackdropAurora />
      <div className="waitlist-container">
        <header className="waitlist-header">
          <div className="waitlist-mark mono">PERCOLATOR</div>
          <Link href="/pitch" className="waitlist-pitch-link mono" aria-label="Open pitch deck">
            for investors ↗
          </Link>
        </header>

        <main className="waitlist-hero">
          <h1 className="waitlist-headline">
            Permissionless perpetuals on Solana.
          </h1>
          <p className="waitlist-sub">
            Mainnet opens after our external audit clears. Connect your Solana wallet to claim a spot — high-intent only, no email required.
          </p>

          <SignupFlow />

          <ul className="waitlist-bullets">
            <li>
              <span className="waitlist-bullet-num mono">60s</span>
              <span>to launch a market on any SPL token — no team approval, no auction</span>
            </li>
            <li>
              <span className="waitlist-bullet-num mono">15M+</span>
              <span>tokens incumbents refuse to list</span>
            </li>
            <li>
              <span className="waitlist-bullet-num mono">Apache 2.0</span>
              <span>fully open source · 17 public repos · fork it tomorrow</span>
            </li>
          </ul>
        </main>

        <CountFooter />
      </div>

      <style>{`
        :root { color-scheme: dark; }
        .waitlist-root {
          min-height: 100dvh;
          background: #0d0d0f;
          color: #f1f1f4;
          font-family: var(--font-inter, "Inter"), system-ui, sans-serif;
          position: relative;
          overflow-x: hidden;
        }
        .waitlist-container {
          max-width: 720px;
          margin: 0 auto;
          padding: 1.5rem 1.5rem 4rem;
          display: flex;
          flex-direction: column;
          min-height: 100dvh;
          position: relative;
          z-index: 1;
        }
        .waitlist-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.5rem 0 4rem;
          letter-spacing: 0.18em;
          font-size: 0.7rem;
          color: rgba(255,255,255,0.55);
        }
        .waitlist-mark { color: rgba(255,255,255,0.85); }
        .waitlist-pitch-link {
          color: rgba(255,255,255,0.45);
          text-decoration: none;
          transition: color 220ms ease;
        }
        .waitlist-pitch-link:hover { color: rgba(34, 211, 238, 0.85); }

        .waitlist-hero { flex: 1; display: flex; flex-direction: column; gap: 1.5rem; }
        .waitlist-headline {
          font-size: clamp(2rem, 5.5vw, 3rem);
          line-height: 1.1;
          font-weight: 600;
          letter-spacing: -0.01em;
          margin: 0;
        }
        .waitlist-sub {
          font-size: 1rem;
          line-height: 1.55;
          color: rgba(255,255,255,0.7);
          max-width: 540px;
          margin: 0;
        }

        .waitlist-bullets {
          list-style: none;
          padding: 0;
          margin: 2.5rem 0 0;
          display: grid;
          gap: 0.75rem;
        }
        .waitlist-bullets li {
          display: grid;
          grid-template-columns: 88px 1fr;
          gap: 1rem;
          align-items: baseline;
          padding: 0.75rem 0;
          border-top: 1px solid rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.7);
          font-size: 0.9rem;
          line-height: 1.45;
        }
        .waitlist-bullet-num {
          color: rgba(34, 211, 238, 0.92);
          font-size: 0.85rem;
          letter-spacing: 0.02em;
        }

        .waitlist-cta-wrap { display: flex; flex-direction: column; gap: 0.75rem; align-items: flex-start; }
        .waitlist-cta {
          font: 600 0.95rem/1 var(--font-inter, "Inter"), system-ui, sans-serif;
          letter-spacing: 0.04em;
          padding: 0.95rem 1.5rem;
          border-radius: 8px;
          border: 1px solid rgba(34, 211, 238, 0.45);
          background: linear-gradient(180deg, rgba(34, 211, 238, 0.18), rgba(34, 211, 238, 0.08));
          color: rgba(255, 255, 255, 0.95);
          cursor: pointer;
          transition: transform 200ms cubic-bezier(.22,1,.36,1), border-color 200ms ease, box-shadow 200ms ease;
          text-transform: uppercase;
        }
        .waitlist-cta:hover { transform: translateY(-1px); border-color: rgba(34, 211, 238, 0.85); box-shadow: 0 8px 24px rgba(34, 211, 238, 0.12); }
        .waitlist-cta:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }

        .waitlist-twitter-input {
          width: 100%;
          max-width: 360px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.95);
          padding: 0.75rem 0.95rem;
          border-radius: 8px;
          font: 0.9rem var(--font-mono, "JetBrains Mono"), monospace;
          outline: none;
          transition: border-color 200ms ease;
        }
        .waitlist-twitter-input:focus { border-color: rgba(34, 211, 238, 0.65); }
        .waitlist-twitter-label { font-size: 0.75rem; color: rgba(255,255,255,0.5); letter-spacing: 0.04em; }

        .waitlist-status {
          padding: 0.75rem 1rem;
          border-radius: 8px;
          font-size: 0.85rem;
          line-height: 1.5;
          margin-top: 0.5rem;
        }
        .waitlist-status-ok { background: rgba(34, 211, 238, 0.08); border: 1px solid rgba(34, 211, 238, 0.22); color: rgba(220, 250, 255, 0.95); }
        .waitlist-status-err { background: rgba(255, 100, 100, 0.06); border: 1px solid rgba(255, 100, 100, 0.2); color: rgba(255, 200, 200, 0.95); }
        .waitlist-pos-num { font-family: var(--font-mono, "JetBrains Mono"), monospace; color: rgba(34, 211, 238, 0.92); }

        .waitlist-count-footer {
          margin-top: 3rem;
          padding-top: 1.5rem;
          border-top: 1px solid rgba(255,255,255,0.06);
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.75rem;
          color: rgba(255,255,255,0.45);
          font-size: 0.78rem;
          letter-spacing: 0.04em;
        }
        .waitlist-count-num { font-family: var(--font-mono, "JetBrains Mono"), monospace; color: rgba(255,255,255,0.78); font-size: 0.95rem; }

        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
        .waitlist-pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: rgba(34, 211, 238, 0.85); margin-right: 0.4rem; animation: pulse 1.4s ease-in-out infinite; }

        .backdrop-aurora { position: absolute; inset: 0; pointer-events: none; z-index: 0; opacity: 0.35; }
      `}</style>
    </div>
  );
}

function SignupFlow() {
  const privyAvailable = usePrivyAvailable();

  if (!privyAvailable) {
    return (
      <div className="waitlist-cta-wrap">
        <div className="waitlist-status waitlist-status-err">
          Wallet provider not configured. Please reload the page.
        </div>
      </div>
    );
  }

  return <SignupFlowInner />;
}

function SignupFlowInner() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { preferredAddress } = usePreferredWallet();

  const activeWallet = useMemo(
    () => resolveActiveWallet(wallets, preferredAddress),
    [wallets, preferredAddress],
  );
  const pubkey = activeWallet?.address ?? null;

  const [state, setState] = useState<State>({ kind: "idle" });
  const [twitter, setTwitter] = useState("");

  const onConnect = useCallback(() => {
    setState({ kind: "connecting" });
    login();
  }, [login]);

  const onSign = useCallback(async () => {
    if (!activeWallet || !pubkey) {
      setState({ kind: "error", reason: "no wallet active" });
      return;
    }
    setState({ kind: "signing" });
    try {
      const message = buildMessage(pubkey);
      const messageBytes = new TextEncoder().encode(message);
      const { signature } = await signMessage({
        message: messageBytes,
        wallet: activeWallet,
      });
      const signatureB58 = bs58.encode(signature);

      setState({ kind: "submitting" });
      const url = new URL(window.location.href);
      const source = url.searchParams.get("ref") ?? url.searchParams.get("utm_source") ?? null;
      const res = await fetch("/api/waitlist/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkey,
          signature: signatureB58,
          message,
          twitter_handle: twitter.trim() || undefined,
          source: source ?? undefined,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; position?: number | null };
      if (!res.ok || !json.ok) {
        setState({ kind: "error", reason: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({ kind: "done", position: json.position ?? null });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "sign cancelled";
      setState({ kind: "error", reason: msg });
    }
  }, [activeWallet, pubkey, signMessage, twitter]);

  // When Privy finishes connecting, advance from "connecting" to "ready"
  useEffect(() => {
    if (state.kind === "connecting" && ready && authenticated && pubkey) {
      setState({ kind: "ready" });
    }
  }, [state, ready, authenticated, pubkey]);

  if (state.kind === "done") {
    return (
      <div className="waitlist-cta-wrap">
        <div className="waitlist-status waitlist-status-ok">
          You&apos;re in.
          {state.position ? (
            <>
              {" "}You&apos;re #<span className="waitlist-pos-num">{state.position}</span> on the waitlist.
            </>
          ) : null}
          {" "}We&apos;ll DM you on X when mainnet opens.
        </div>
        <a
          className="waitlist-cta"
          href={`https://x.com/intent/post?text=${encodeURIComponent(
            "Just joined the @percolatortrade waitlist — permissionless perpetuals on Solana. percolator.trade",
          )}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Share on X
        </a>
      </div>
    );
  }

  if (state.kind === "ready" || state.kind === "signing" || state.kind === "submitting") {
    const busy = state.kind !== "ready";
    return (
      <div className="waitlist-cta-wrap">
        <span className="waitlist-twitter-label mono">
          OPTIONAL — your X handle
        </span>
        <input
          className="waitlist-twitter-input"
          placeholder="@yourhandle"
          value={twitter}
          onChange={(e) => setTwitter(e.target.value)}
          disabled={busy}
          maxLength={30}
        />
        <button className="waitlist-cta" onClick={onSign} disabled={busy}>
          {state.kind === "signing"
            ? "Sign in your wallet…"
            : state.kind === "submitting"
              ? "Submitting…"
              : "Sign to join the waitlist"}
        </button>
        <div className="waitlist-status waitlist-status-ok">
          Connected: <span className="waitlist-pos-num">{pubkey?.slice(0, 6)}…{pubkey?.slice(-4)}</span>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="waitlist-cta-wrap">
        <button className="waitlist-cta" onClick={() => setState({ kind: "idle" })}>
          Try again
        </button>
        <div className="waitlist-status waitlist-status-err">
          {state.reason}
        </div>
      </div>
    );
  }

  // idle / connecting
  return (
    <div className="waitlist-cta-wrap">
      <button
        className="waitlist-cta"
        onClick={onConnect}
        disabled={state.kind === "connecting"}
      >
        {state.kind === "connecting" ? "Connecting…" : "Connect wallet to join"}
      </button>
    </div>
  );
}

function CountFooter() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/waitlist/count")
      .then((r) => r.json())
      .then((d) => {
        if (alive && typeof d?.count === "number") setCount(d.count);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const animated = useCountUp(count ?? 0);
  return (
    <footer className="waitlist-count-footer">
      <span>
        <span className="waitlist-pulse" />
        <span className="waitlist-count-num">{count === null ? "—" : animated.toLocaleString()}</span>{" "}
        on the waitlist
      </span>
      <span>
        <a
          href="https://x.com/percolatortrade"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          @percolatortrade
        </a>
        {" · "}
        <a
          href="mailto:dark@percolator.trade"
          style={{ color: "inherit", textDecoration: "none" }}
        >
          dark@percolator.trade
        </a>
      </span>
    </footer>
  );
}

function BackdropAurora() {
  return (
    <svg className="backdrop-aurora" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <radialGradient id="aurora1" cx="20%" cy="20%" r="50%">
          <stop offset="0%" stopColor="#9945FF" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#9945FF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="aurora2" cx="80%" cy="60%" r="50%">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="800" height="600" fill="url(#aurora1)" />
      <rect width="800" height="600" fill="url(#aurora2)" />
    </svg>
  );
}
