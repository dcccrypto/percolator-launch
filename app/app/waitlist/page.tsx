"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
const buildMessage = (pubkey: string) =>
  `${MESSAGE_PREFIX}${new Date().toISOString()} | ${pubkey}`;

// ============================================================================
// PAGE
// ============================================================================

export default function WaitlistPage() {
  return (
    <div className="relative min-h-[calc(100dvh-48px)] overflow-hidden">
      <BackdropArt />

      <main className="relative mx-auto max-w-[1100px] px-6 pt-16 pb-24 sm:pt-20">
        <Hero />
        <SeparatorMono label="Why join" />
        <WhySection />
        <SeparatorMono label="Mainnet status" />
        <StatusReadout />
        <SeparatorMono label="Architecture" />
        <ArchitectureSection />
        <SeparatorMono label="Origin" />
        <OriginSection />
        <SeparatorMono label="FAQ" />
        <FAQSection />
        <Footer />
      </main>
    </div>
  );
}

// ============================================================================
// BACKDROP — single subtle aurora + grid, no card-y noise
// ============================================================================

function BackdropArt() {
  return (
    <>
      {/* Solana-purple wash, top-left → fade. One light source, not a glow farm. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[20%] left-[-15%] h-[700px] w-[700px] rounded-full opacity-50 blur-[140px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(153,69,255,0.55), rgba(153,69,255,0) 75%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-10%] top-[30%] h-[600px] w-[600px] rounded-full opacity-40 blur-[160px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(20,241,149,0.35), rgba(20,241,149,0) 70%)",
        }}
      />
      {/* Faint grid only above the fold */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[640px] opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--text) 1px, transparent 1px), linear-gradient(to bottom, var(--text) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage:
            "linear-gradient(to bottom, black 30%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 30%, transparent 100%)",
        }}
      />
    </>
  );
}

// ============================================================================
// MONO SEPARATOR — terminal-style section delimiters
// ============================================================================

function SeparatorMono({ label }: { label: string }) {
  return (
    <div className="mt-24 mb-10 flex items-center gap-4 sm:mt-28 sm:mb-12">
      <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--text-muted)]">
        ── {label}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-[var(--border)] via-[var(--border)] to-transparent" />
    </div>
  );
}

// ============================================================================
// HERO — split layout, signup directly inline with text
// ============================================================================

function Hero() {
  return (
    <section className="grid gap-10 sm:gap-14 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
      {/* Left — message */}
      <div>
        {/* Top status row */}
        <div className="mb-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cyan)]" />
          <span className="text-[var(--cyan)]">live on mainnet</span>
          <span className="text-[var(--text-dim)]">/</span>
          <span>audit Q3 · public open after</span>
        </div>

        <h1
          className="text-[40px] font-bold leading-[1.02] tracking-[-0.025em] text-[var(--text)] sm:text-[52px] md:text-[64px]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Perp futures
          <br />
          for{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(110deg, #B97AFF 0%, #9945FF 35%, #14F195 100%)",
            }}
          >
            every Solana token
          </span>
          .
        </h1>

        <p className="mt-6 max-w-[520px] text-[15px] leading-[1.65] text-[var(--text-secondary)]">
          A creator launches a leveraged market on any SPL token in 60 seconds — no team approval, no auction. Built on{" "}
          <span className="text-[var(--text)]">Anatoly Yakovenko&apos;s</span> open research, extended into a production protocol with our own LP vault, transferable Token-2022 NFT positions, dispute resolution, and audit-crank invariants.
        </p>

        {/* Specifics row — looks like a code line, not a "trust badge" */}
        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11.5px] text-[var(--text-muted)]">
          <SpecPill k="program" v="ESa89R5E…D4edv" />
          <SpecPill k="proofs" v="422 / 422 ✓" highlight="cyan" />
          <SpecPill k="repos" v="17 · Apache 2.0" />
          <SpecPill k="markets" v="220 on devnet" />
        </div>
      </div>

      {/* Right — signup card pinned beside hero text */}
      <div className="flex flex-col justify-end">
        <SignupCard />
      </div>
    </section>
  );
}

function SpecPill({
  k,
  v,
  highlight,
}: {
  k: string;
  v: string;
  highlight?: "cyan" | "purple";
}) {
  const color =
    highlight === "cyan"
      ? "text-[var(--cyan)]"
      : highlight === "purple"
        ? "text-[var(--accent)]"
        : "text-[var(--text)]";
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[var(--text-dim)]">{k}</span>
      <span className="text-[var(--text-dim)]">=</span>
      <span className={color}>{v}</span>
    </span>
  );
}

// ============================================================================
// SIGNUP CARD — feels like a CLI prompt, not a "join" form
// ============================================================================

function SignupCard() {
  const privyAvailable = usePrivyAvailable();
  return (
    <div
      className="relative w-full max-w-[460px] rounded-md border border-[var(--border)] bg-[var(--panel-bg)]/95 p-5 backdrop-blur-sm"
      style={{
        boxShadow:
          "0 24px 48px -24px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      {/* Top frame label — like a tmux pane or window title */}
      <div className="mb-4 flex items-center justify-between border-b border-[var(--border)] pb-3">
        <div className="flex items-center gap-2">
          <span className="block h-2 w-2 rounded-full bg-[var(--short)]/70" />
          <span className="block h-2 w-2 rounded-full bg-[#fbbf24]/70" />
          <span className="block h-2 w-2 rounded-full bg-[var(--cyan)]/80" />
          <span className="ml-3 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            waitlist · sign · v1
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-[var(--text-dim)]">
          ed25519
        </span>
      </div>

      {privyAvailable ? (
        <SignupFlow />
      ) : (
        <StatusErr>Wallet provider not configured. Reload the page.</StatusErr>
      )}
    </div>
  );
}

function SignupFlow() {
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
      const source =
        url.searchParams.get("ref") ?? url.searchParams.get("utm_source") ?? null;
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
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        position?: number | null;
      };
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

  useEffect(() => {
    if (state.kind === "connecting" && ready && authenticated && pubkey) {
      setState({ kind: "ready" });
    }
  }, [state, ready, authenticated, pubkey]);

  // Done state
  if (state.kind === "done") {
    return (
      <div className="space-y-4">
        <PromptLine prefix="$" text="claim_spot" status="ok" />
        <div className="rounded-md border border-[var(--cyan)]/25 bg-[var(--cyan)]/[0.05] p-3.5">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--cyan)]">
            ✓ on the list
          </div>
          {state.position ? (
            <div
              className="mt-1.5 font-mono text-[28px] font-bold leading-none text-[var(--text)]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              #{state.position.toLocaleString()}
            </div>
          ) : null}
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            We&apos;ll DM you on X at{" "}
            <a
              href="https://x.com/percolatortrade"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              @percolatortrade
            </a>{" "}
            when mainnet opens.
          </p>
        </div>
        <a
          className={ctaSecondary}
          href={`https://x.com/intent/post?text=${encodeURIComponent(
            "Just joined the @percolatortrade waitlist. Permissionless perp futures on Solana. percolator.trade",
          )}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          → Share on X
        </a>
      </div>
    );
  }

  // Ready / signing / submitting
  if (
    state.kind === "ready" ||
    state.kind === "signing" ||
    state.kind === "submitting"
  ) {
    const busy = state.kind !== "ready";
    return (
      <div className="space-y-3.5">
        <PromptLine prefix="$" text={`connected ${pubkey?.slice(0, 6)}…${pubkey?.slice(-4)}`} status="ok" />
        <div className="space-y-1.5">
          <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            x_handle (optional)
          </label>
          <input
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15"
            placeholder="@yourhandle"
            value={twitter}
            onChange={(e) => setTwitter(e.target.value)}
            disabled={busy}
            maxLength={30}
          />
        </div>
        <button className={ctaPrimary} onClick={onSign} disabled={busy}>
          {state.kind === "signing"
            ? "Signing in your wallet…"
            : state.kind === "submitting"
              ? "Submitting…"
              : "Sign & claim spot →"}
        </button>
      </div>
    );
  }

  // Error
  if (state.kind === "error") {
    return (
      <div className="space-y-3.5">
        <button className={ctaPrimary} onClick={() => setState({ kind: "idle" })}>
          Try again
        </button>
        <StatusErr>{state.reason}</StatusErr>
      </div>
    );
  }

  // Idle / connecting
  return (
    <div className="space-y-3.5">
      <PromptLine
        prefix="$"
        text={state.kind === "connecting" ? "connecting…" : "connect_wallet"}
        status={state.kind === "connecting" ? "pending" : "idle"}
      />
      <button
        className={ctaPrimary}
        onClick={onConnect}
        disabled={state.kind === "connecting"}
      >
        {state.kind === "connecting"
          ? "Connecting…"
          : "Connect wallet →"}
      </button>
      <p className="font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
        Phantom · Solflare · Backpack · Jupiter
        <br />
        wallet-gated · no email · no gas · idempotent
      </p>
    </div>
  );
}

function PromptLine({
  prefix,
  text,
  status,
}: {
  prefix: string;
  text: string;
  status: "ok" | "pending" | "idle" | "err";
}) {
  const color =
    status === "ok"
      ? "text-[var(--cyan)]"
      : status === "pending"
        ? "text-[#fbbf24]"
        : status === "err"
          ? "text-[var(--short)]"
          : "text-[var(--text-secondary)]";
  return (
    <div className="font-mono text-[12px] leading-none">
      <span className="text-[var(--text-dim)]">{prefix} </span>
      <span className={color}>{text}</span>
      {status === "pending" && (
        <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-[var(--text-secondary)] align-middle" />
      )}
    </div>
  );
}

const ctaPrimary =
  "block w-full rounded-md border border-[var(--accent)]/40 bg-gradient-to-b from-[var(--accent)]/[0.18] to-[var(--accent)]/[0.06] px-4 py-3 text-center text-[12.5px] font-bold uppercase tracking-[0.12em] text-[var(--text)] transition-all hover:border-[var(--accent)]/70 hover:from-[var(--accent)]/25 hover:to-[var(--accent)]/[0.10] hover:shadow-[0_12px_32px_-12px_rgba(153,69,255,0.55)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none";

const ctaSecondary =
  "block w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 text-center text-[12.5px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]";

function StatusErr({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--short)]/25 bg-[var(--short)]/[0.05] px-3 py-2.5 font-mono text-[12px] leading-relaxed text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

// ============================================================================
// WHY — numbered manifesto, opinionated copy
// ============================================================================

function WhySection() {
  const items: [string, string, string][] = [
    [
      "01",
      "Wallet-gated, not email-gated.",
      "We don't have an email list to leak. You sign with the wallet that gets the access. No drips, no spam, no scammer farming.",
    ],
    [
      "02",
      "Priority access at mainnet open.",
      "When the audit clears, waitlist wallets get in before broader public. The order you sign is the order you get notified.",
    ],
    [
      "03",
      "First ten markets · 50% creator-fee rebate · 90 days.",
      "If you're going to launch a market, get on the list. The first ten launched after public open keep half their creator fees rebated for 90 days.",
    ],
    [
      "04",
      "Verifiable, end to end.",
      "The mainnet program is already live in lab mode. The 422 Kani proofs run on every commit. Nothing is in marketing-deck-only territory.",
    ],
  ];
  return (
    <section className="grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_2fr]">
      <div>
        <h2
          className="text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          High-intent only.
          <br />
          Wallet-gated.
        </h2>
        <p className="mt-3 max-w-[280px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          Signing with a real Solana wallet is the only filter you need to weed out spam, dedupe by pubkey, and reach early adopters cleanly.
        </p>
      </div>
      <ol className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
        {items.map(([n, t, d]) => (
          <li
            key={n}
            className="grid grid-cols-[44px_1fr] gap-5 py-5 transition-colors hover:bg-[var(--bg-elevated)]/40"
          >
            <span
              className="font-mono text-[11px] tracking-[0.05em] text-[var(--accent)]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {n}
            </span>
            <div>
              <div className="text-[15px] font-semibold leading-tight text-[var(--text)]">
                {t}
              </div>
              <p className="mt-1.5 text-[13.5px] leading-[1.6] text-[var(--text-secondary)]">
                {d}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ============================================================================
// STATUS READOUT — the "marketing dashboard". Real on-chain numbers.
// ============================================================================

function StatusReadout() {
  return (
    <section
      className="rounded-md border border-[var(--border)] bg-[var(--panel-bg)]"
      style={{ backgroundImage: "linear-gradient(180deg, rgba(153,69,255,0.025), transparent 60%)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          [readout] mainnet · devnet · audit
        </div>
        <a
          href="https://explorer.solana.com/address/ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          view program ↗
        </a>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <ReadoutCell
          label="Mainnet program"
          value="ESa89R5E…D4edv"
          sub="lab mode · 1 active market"
          accent="purple"
        />
        <ReadoutCell
          label="Devnet markets"
          value="220"
          sub="across 3 program versions"
        />
        <ReadoutCell
          label="Kani proofs"
          value="422 / 422"
          sub="risk engine + wrapper"
          accent="cyan"
        />
        <ReadoutCell
          label="Open-source repos"
          value="17"
          sub="Apache 2.0 · github.com/dcccrypto"
        />
      </div>
    </section>
  );
}

function ReadoutCell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: "purple" | "cyan";
}) {
  const colorClass =
    accent === "purple"
      ? "text-[var(--accent)]"
      : accent === "cyan"
        ? "text-[var(--cyan)]"
        : "text-[var(--text)]";
  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--border)] p-5 last:border-b-0 sm:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(4n)]:border-r-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
        {label}
      </span>
      <span
        className={`font-mono text-[22px] font-bold leading-none ${colorClass}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
      <span className="font-mono text-[11px] leading-tight text-[var(--text-secondary)]">
        {sub}
      </span>
    </div>
  );
}

// ============================================================================
// ARCHITECTURE — instruction-tag callouts, terminal-styled list
// ============================================================================

function ArchitectureSection() {
  return (
    <section className="grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_2fr]">
      <div>
        <h2
          className="text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Not an order book.
          <br />
          Not a traditional AMM.
        </h2>
        <p className="mt-3 max-w-[300px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          Trades execute against an on-chain LP vault using oracle-derived pricing. Two matcher modes per market — passive LP{" "}
          <span className="font-mono text-[var(--text)]">(oracle ± spread)</span>{" "}
          or vAMM{" "}
          <span className="font-mono text-[var(--text)]">(virtual constant-impact)</span>. Same engine, different pricing knob.
        </p>
      </div>
      <div className="space-y-3">
        <ArchRow tag="ix 37–40" t="LP vault" d="Per-market liquidity pool — anyone deposits USDC, becomes a passive maker, earns spread + fee share. Risk isolated per market." />
        <ArchRow tag="ix 64–69" t="Token-2022 NFT positions" d="Open positions wrap as NFTs with a transfer hook. First transferable perpetual positions on Solana." accent="cyan" />
        <ArchRow tag="ix 43–44" t="Dispute resolution" d="Resolved markets have a challenge window with a bond. Bad settlements get caught before users get drained." />
        <ArchRow tag="ix 53" t="Audit-crank invariants" d="Anyone can crank an on-chain invariant check. If something doesn't balance, the market auto-pauses before the bug compounds." />
        <ArchRow tag="DEX EWMA" t="Hyperp markets" d="For tokens without Pyth coverage, the oracle reads a pinned Raydium CLMM pool's EWMA on chain. No external dependency." />
        <ArchRow tag="kani · 422" t="Formally verified" d="422 model-checking proofs cover the H + A/K risk engine — haircut conservation, ADL fairness, funding zero-sum." accent="cyan" />
      </div>
    </section>
  );
}

function ArchRow({
  tag,
  t,
  d,
  accent,
}: {
  tag: string;
  t: string;
  d: string;
  accent?: "cyan";
}) {
  const tagColor = accent === "cyan" ? "text-[var(--cyan)]" : "text-[var(--accent)]";
  return (
    <div className="group grid grid-cols-[110px_1fr] items-baseline gap-5 border-b border-[var(--border)] py-3 transition-colors last:border-b-0 hover:border-[var(--border-hover)]">
      <span className={`font-mono text-[11px] uppercase tracking-[0.05em] ${tagColor}`}>
        {tag}
      </span>
      <div>
        <div className="text-[14px] font-semibold leading-tight text-[var(--text)]">
          {t}
        </div>
        <p className="mt-1 max-w-[600px] text-[13px] leading-[1.55] text-[var(--text-secondary)]">
          {d}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// ORIGIN — single block with the lineage callout
// ============================================================================

function OriginSection() {
  return (
    <section className="grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_2fr]">
      <div>
        <h2
          className="text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Built on Toly&apos;s research.
          <br />
          Shipped by us.
        </h2>
        <p className="mt-3 max-w-[280px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          Anatoly Yakovenko authored the H + A/K risk-engine math and a reference program. We took it from a research artifact to a production system on Solana mainnet.
        </p>
      </div>
      <div>
        {/* Visual fork delta: toly → us */}
        <div className="rounded-md border border-[var(--border)] bg-[var(--panel-bg)] p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11.5px]">
            <span className="text-[var(--text-muted)]">github.com/</span>
            <span className="text-[var(--text)]">aeyakovenko/percolator-prog</span>
            <span className="text-[var(--text-dim)]">→</span>
            <span className="rounded bg-[var(--accent)]/[0.12] px-2 py-0.5 text-[var(--accent)]">
              dcccrypto
            </span>
            <span className="ml-auto text-[var(--text-dim)]">+134 commits past divergence</span>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)]">
            <ForkStat n="49" label="fork-only handlers" />
            <ForkStat n="51" label="fork-only instructions" />
            <ForkStat n="22" label="fork-only error variants" />
          </div>

          <p className="mt-5 text-[13px] leading-[1.6] text-[var(--text-secondary)]">
            On the wrapper alone we shipped LP vault, dispute resolution, transferable Token-2022 NFT positions, a withdrawal queue, audit-crank invariant checks, two-step admin handover, and DEX-pool oracle pinning — none of which exist in the reference program. Plus the SDK, indexer, keeper fleet, and frontend.{" "}
            <span className="text-[var(--text)]">
              Both co-founders won one of his public bounties.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

function ForkStat({ n, label }: { n: string; label: string }) {
  return (
    <div className="flex flex-col gap-1 bg-[var(--panel-bg)] px-4 py-4 sm:px-5">
      <span
        className="font-mono text-[26px] font-bold leading-none text-[var(--text)]"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {n}
      </span>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {label}
      </span>
    </div>
  );
}

// ============================================================================
// FAQ — denser, bolder Q/A typography
// ============================================================================

function FAQSection() {
  const items: [string, React.ReactNode][] = [
    [
      "When does mainnet open?",
      <>
        After the external audit clears — targeting Q3 2026. The mainnet program is already deployed and running in OSS-contributor closed beta with the first SOL/USDC Hyperp market.
      </>,
    ],
    [
      "Why a waitlist instead of letting me trade now?",
      <>
        Pre-audit, public trading puts user funds at risk. We won&apos;t do that. The waitlist is how we line up early adopters and creators so they get priority access the moment audit clears.
      </>,
    ],
    [
      "Why connect a wallet — why not just take my email?",
      <>
        Wallet signatures dedupe by pubkey, prove you&apos;re a real Solana user, and let us scope future creator-fee rebates and access tiers cleanly. No email = no spam list to leak. We don&apos;t collect emails at all.
      </>,
    ],
    [
      "Does signing cost gas?",
      <>
        No. Signing produces an offline ed25519 signature over a short message proving you control the wallet. We never send a transaction, never request token approvals, never see your private key. Server-side we verify with{" "}
        <code className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--accent)]">
          tweetnacl
        </code>{" "}
        before adding you to the list.
      </>,
    ],
    [
      "How is this different from Hyperliquid or Drift?",
      <>
        Hyperliquid HIP-1 is permissionless but auction-gated (historically up to $19M+ per market, on its own L1). Drift is curated and Solana-native. Percolator is permissionless and Solana-native — anyone launches a market on any SPL token in 60 seconds. Long-tail tokens get perp access for the first time.
      </>,
    ],
    [
      "Is the code open source?",
      <>
        Apache 2.0 across 17 public repos at{" "}
        <a
          href="https://github.com/dcccrypto"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          github.com/dcccrypto
        </a>
        . Wrapper, engine, matcher, NFT contract, SDK, indexer, keeper, frontend — all public. Fork it tomorrow.
      </>,
    ],
    [
      "Will my LP get drained?",
      <>
        Pre-audit, no LP deposits. Mainnet is in lab mode with first-party capital only. After audit, LP risk is per-market — each LP vault is isolated, and the insurance reserve sits between user PnL and LP equity.
      </>,
    ],
    [
      "Can I unsubscribe?",
      <>
        We don&apos;t have an email list to unsubscribe from. If you want your wallet removed, DM{" "}
        <a
          href="https://x.com/percolatortrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          @percolatortrade
        </a>{" "}
        on X with the same wallet that signed up.
      </>,
    ],
  ];
  return (
    <section className="grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_2fr]">
      <div>
        <h2
          className="text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          What you&apos;re probably wondering.
        </h2>
      </div>
      <div className="border-t border-[var(--border)]">
        {items.map(([q, a], i) => (
          <details
            key={i}
            className="group border-b border-[var(--border)] py-5 [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer items-start justify-between gap-4 text-[15px] font-semibold leading-tight text-[var(--text)] transition-colors hover:text-[var(--accent)]">
              <span>{q}</span>
              <span className="mt-0.5 shrink-0 font-mono text-[16px] leading-none text-[var(--accent)] transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <div className="mt-3 max-w-3xl text-[13.5px] leading-[1.7] text-[var(--text-secondary)]">
              {a}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// FOOTER — counter + contacts, mono-styled
// ============================================================================

function Footer() {
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
    <div className="mt-24 grid gap-y-3 border-t border-[var(--border)] pt-6 sm:flex sm:items-center sm:justify-between">
      <div className="flex items-baseline gap-3 font-mono">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cyan)]" />
        <span
          className="text-[20px] font-bold leading-none text-[var(--text)]"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {count === null ? "—" : animated.toLocaleString()}
        </span>
        <span className="text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          on the waitlist
        </span>
      </div>
      <div className="font-mono text-[11.5px]">
        <a
          href="https://x.com/percolatortrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          @percolatortrade
        </a>
        <span className="mx-2 text-[var(--text-dim)]">·</span>
        <a
          href="mailto:dark@percolator.trade"
          className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          dark@percolator.trade
        </a>
        <span className="mx-2 text-[var(--text-dim)]">·</span>
        <a
          href="https://github.com/dcccrypto"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          github
        </a>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

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
