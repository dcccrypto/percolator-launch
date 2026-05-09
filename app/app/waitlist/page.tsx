"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useLoginWithEmail } from "@privy-io/react-auth";
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
        <SeparatorMono label="Architecture" />
        <ArchitectureSection />
        <SeparatorMono label="Mainnet status" />
        <StatusReadout />
        <SeparatorMono label="Origin" />
        <OriginSection />
        <SeparatorMono label="Reserve your spot" />
        <SignupSection />
        <SeparatorMono label="How we'll reach you" />
        <NotifySection />
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
      <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--text-secondary)]">
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
    <section className="max-w-[820px]">
      {/* Top status row */}
      <div className="mb-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cyan)]" />
        <span className="text-[var(--cyan)]">live on mainnet</span>
        <span className="text-[var(--text-dim)]">/</span>
        <span>audit Q3 · public open after</span>
      </div>

      <h1
        className="text-[44px] font-bold leading-[1.02] tracking-[-0.025em] text-[var(--text)] sm:text-[60px] md:text-[76px]"
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

      <p className="mt-6 max-w-[640px] text-[16px] leading-[1.6] text-[var(--text-secondary)] sm:text-[17px]">
        A creator launches a leveraged market on any SPL token in 60 seconds — no team approval, no auction. Forked from{" "}
        <span className="text-[var(--text)]">Anatoly Yakovenko&apos;s</span> open-source reference program and extended on chain with LP vault, transferable Token-2022 NFT positions, dispute resolution, and audit-crank invariants.
      </p>

      {/* Specs row — looks like a struct field block, not a trust-badge row */}
      <div className="mt-9 grid max-w-[640px] grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-4">
        <SpecField k="status" v="lab mode" highlight="cyan" />
        <SpecField k="proofs" v="422 / 422 ✓" highlight="cyan" />
        <SpecField k="repos" v="17 · Apache 2.0" />
        <SpecField k="markets" v="220 on devnet" />
      </div>

      {/* Hero CTA — clean, confident, no theatrics */}
      <div className="mt-12 flex flex-wrap items-center gap-5">
        <a
          href="#reserve"
          className="inline-flex items-center gap-2.5 rounded-md bg-[var(--accent)] px-6 py-3 text-[14px] font-semibold text-white shadow-[0_4px_14px_-4px_rgba(153,69,255,0.4)] transition-all duration-200 hover:bg-[var(--accent-muted)] hover:shadow-[0_8px_24px_-6px_rgba(153,69,255,0.55)]"
        >
          Reserve your spot
          <span aria-hidden className="text-[15px] leading-none">↓</span>
        </a>
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
          wallet or email · 30 seconds
        </span>
      </div>
    </section>
  );
}

function SpecField({
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
    <div className="flex flex-col gap-0.5 border-l border-[var(--border)] pl-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        {k}
      </span>
      <span className={`font-mono text-[12.5px] ${color}`} style={{ fontVariantNumeric: "tabular-nums" }}>
        {v}
      </span>
    </div>
  );
}

// ============================================================================
// SIGNUP CARD — feels like a CLI prompt, not a "join" form
// ============================================================================

function SignupCard() {
  const privyAvailable = usePrivyAvailable();
  const [tab, setTab] = useState<"wallet" | "email">("wallet");
  return (
    <div className="relative w-full max-w-[460px]">
      {/* Static accent gradient halo behind the card — gives it presence */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-md opacity-60 blur-sm"
        style={{
          background:
            "linear-gradient(135deg, rgba(153,69,255,0.55), rgba(20,241,149,0.30) 70%)",
        }}
      />
      <div
        className="relative w-full rounded-md border border-[var(--border)] bg-[var(--panel-bg)]/95 p-5 backdrop-blur-sm"
        style={{
          boxShadow:
            "0 24px 48px -24px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.04) inset",
        }}
      >
        {/* Top frame label — terminal-window aesthetic */}
        <div className="mb-4 flex items-center justify-between border-b border-[var(--border)] pb-3">
          <div className="flex items-center gap-2">
            <span className="block h-2 w-2 rounded-full bg-[var(--short)]/70" />
            <span className="block h-2 w-2 rounded-full bg-[#fbbf24]/70" />
            <span className="block h-2 w-2 rounded-full bg-[var(--cyan)]/80" />
            <span className="ml-3 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
              waitlist · v1
            </span>
          </div>
          <span className="font-mono text-[10.5px] text-[var(--text-secondary)]">
            {tab === "wallet" ? "ed25519" : "smtp"}
          </span>
        </div>

        {/* Tab selector */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--bg)] p-1">
          <TabButton active={tab === "wallet"} onClick={() => setTab("wallet")}>
            Wallet
          </TabButton>
          <TabButton active={tab === "email"} onClick={() => setTab("email")}>
            Email
          </TabButton>
        </div>

        {tab === "wallet" ? (
          privyAvailable ? (
            <SignupFlow />
          ) : (
            <StatusErr>Wallet provider not configured. Reload the page.</StatusErr>
          )
        ) : (
          <EmailFlow />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "rounded-sm bg-[var(--bg-elevated)] px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text)] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-all"
          : "rounded-sm bg-transparent px-3 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
      }
    >
      {children}
    </button>
  );
}

// ============================================================================
// EMAIL FLOW — Privy email login → embedded Solana wallet → sign + submit
// (so email signups also get the dApp gate, not just the email confirmation)
// ============================================================================

type EmailState =
  | { kind: "idle" }
  | { kind: "sending-code"; email: string }
  | { kind: "awaiting-code"; email: string }
  | { kind: "verifying" }
  | { kind: "signing"; email: string }
  | { kind: "submitting"; email: string }
  | { kind: "done"; email: string; position: number | null }
  | { kind: "error"; reason: string };

function EmailFlow() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [twitter, setTwitter] = useState("");
  const [state, setState] = useState<EmailState>({ kind: "idle" });

  const { sendCode, loginWithCode } = useLoginWithEmail({
    onComplete: () => {
      // Privy login complete — useEffect below picks up the new wallet
      // and runs sign + submit
    },
    onError: (err) => {
      setState({ kind: "error", reason: typeof err === "string" ? err : "login failed" });
    },
  });

  const { user, ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();

  const onSendCode = useCallback(async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      setState({ kind: "error", reason: "that email looks off" });
      return;
    }
    setState({ kind: "sending-code", email: trimmed });
    try {
      await sendCode({ email: trimmed });
      setState({ kind: "awaiting-code", email: trimmed });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "could not send code";
      setState({ kind: "error", reason: msg });
    }
  }, [email, sendCode]);

  const onVerifyCode = useCallback(async () => {
    if (state.kind !== "awaiting-code") return;
    if (!code || code.length < 4) {
      setState({ kind: "error", reason: "enter the 6-digit code from your inbox" });
      return;
    }
    setState({ kind: "verifying" });
    try {
      await loginWithCode({ code: code.trim() });
      // useEffect below will continue: sign + submit
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "code didn't verify";
      setState({ kind: "error", reason: msg });
    }
  }, [code, state, loginWithCode]);

  // After Privy login completes: auto-sign with the embedded wallet
  // (created by Privy because config.embeddedWallets.solana.createOnLogin
  // = "users-without-wallets") and submit to the waitlist API.
  useEffect(() => {
    if (state.kind !== "verifying") return;
    if (!ready || !authenticated || !user) return;
    const wallet = wallets.find((w) => w.address);
    if (!wallet) return; // wait one tick for embedded wallet to register
    const userEmail = user.email?.address ?? state.kind === "verifying" ? email.trim().toLowerCase() : null;
    if (!userEmail) {
      setState({ kind: "error", reason: "missing email after login" });
      return;
    }

    setState({ kind: "signing", email: userEmail });
    (async () => {
      try {
        const message = buildMessage(wallet.address);
        const messageBytes = new TextEncoder().encode(message);
        const { signature } = await signMessage({
          message: messageBytes,
          wallet,
        });
        const signatureB58 = bs58.encode(signature);
        setState({ kind: "submitting", email: userEmail });

        const url = new URL(window.location.href);
        const source =
          url.searchParams.get("ref") ?? url.searchParams.get("utm_source") ?? null;
        const res = await fetch("/api/waitlist/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: userEmail,
            pubkey: wallet.address,
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
        setState({ kind: "done", email: userEmail, position: json.position ?? null });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "sign / submit failed";
        setState({ kind: "error", reason: msg });
      }
    })();
  }, [state, ready, authenticated, user, wallets, signMessage, twitter, email]);

  if (state.kind === "done") {
    return (
      <div className="space-y-4">
        <PromptLine prefix="$" text="email_signup" status="ok" />
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
            Confirmation sent to <span className="font-mono text-[var(--accent)]">{state.email}</span>. We also created an embedded Solana wallet under your email — when mainnet opens, the dApp recognises you automatically.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "awaiting-code" || state.kind === "verifying") {
    const busy = state.kind === "verifying";
    return (
      <div className="space-y-3.5">
        <PromptLine prefix="$" text={`code_sent ${state.kind === "awaiting-code" ? state.email : ""}`} status="pending" />
        <div className="space-y-1.5">
          <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            6-digit code
          </label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[15px] tracking-[0.4em] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15"
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            disabled={busy}
            maxLength={6}
            autoFocus
          />
        </div>
        <button className={ctaPrimary} onClick={onVerifyCode} disabled={busy || code.length < 6}>
          {busy ? "Verifying…" : "Verify & join"}
        </button>
        <button
          className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
          onClick={() => setState({ kind: "idle" })}
        >
          ← change email
        </button>
      </div>
    );
  }

  if (state.kind === "signing" || state.kind === "submitting") {
    return (
      <div className="space-y-3">
        <PromptLine
          prefix="$"
          text={state.kind === "signing" ? "signing_with_embedded_wallet" : "submitting"}
          status="pending"
        />
        <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Privy created an embedded Solana wallet for {state.email}. We&apos;re signing the join message with it now — no prompt, no gas.
        </p>
      </div>
    );
  }

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

  // idle / sending-code
  const sending = state.kind === "sending-code";
  return (
    <div className="space-y-3.5">
      <PromptLine prefix="$" text="email_signup" status="idle" />
      <div className="space-y-1.5">
        <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          email
        </label>
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15"
          placeholder="you@domain.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={sending}
          maxLength={254}
        />
      </div>
      <div className="space-y-1.5">
        <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          x_handle (optional)
        </label>
        <input
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15"
          placeholder="@yourhandle"
          value={twitter}
          onChange={(e) => setTwitter(e.target.value)}
          disabled={sending}
          maxLength={30}
        />
      </div>
      <button className={ctaPrimary} onClick={onSendCode} disabled={sending}>
        {sending ? "Sending code…" : "Send 6-digit code →"}
      </button>
      <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
        We&apos;ll email you a 6-digit code, then create an embedded Solana wallet under your email so you also get the on-chain dApp gate when mainnet opens.
      </p>
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
          <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
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
      <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
        Phantom · Solflare · Backpack · Jupiter
        <br />
        sign-only · no gas · idempotent
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
  "block w-full rounded-md border border-[var(--accent)]/60 bg-gradient-to-b from-[var(--accent)]/[0.28] to-[var(--accent)]/[0.10] px-4 py-3.5 text-center text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--text)] transition-all duration-200 hover:border-[var(--accent)] hover:from-[var(--accent)]/40 hover:to-[var(--accent)]/[0.16] hover:shadow-[0_14px_36px_-12px_rgba(153,69,255,0.7)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none";

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
// SIGNUP SECTION — anchored card, the actual reservation step
// ============================================================================

function SignupSection() {
  return (
    <section
      id="reserve"
      className="scroll-mt-20 grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_1.1fr]"
    >
      <div>
        <h2
          className="text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Wallet or email.
          <br />
          Both get the dApp gate.
        </h2>
        <p className="mt-4 max-w-[420px] text-[14px] leading-[1.65] text-[var(--text-secondary)]">
          Two paths to the same list. Either connect a Solana wallet and sign once, or drop an email and verify with a 6-digit code — Privy creates an embedded Solana wallet under your email automatically, so the dApp at percolator.trade recognises you when mainnet opens either way.
        </p>
        <div className="mt-6 space-y-3 font-mono text-[12px] text-[var(--text-secondary)]">
          <SignupBullet color="cyan">Wallet path: connect Phantom / Solflare / Backpack / Jupiter. Sign once. Done.</SignupBullet>
          <SignupBullet color="cyan">Email path: 6-digit code → embedded wallet → automatic message sign. Same result.</SignupBullet>
          <SignupBullet color="cyan">Optional X handle on either path for a backup DM channel.</SignupBullet>
        </div>
      </div>
      <div className="flex justify-start lg:justify-end">
        <SignupCard />
      </div>
    </section>
  );
}

function SignupBullet({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "cyan" | "purple";
}) {
  const c = color === "cyan" ? "var(--cyan)" : "var(--accent)";
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className="mt-[7px] inline-block h-1 w-3 shrink-0 rounded-sm"
        style={{ background: c, opacity: 0.85 }}
      />
      <span>{children}</span>
    </div>
  );
}

// ============================================================================
// NOTIFY — how we actually reach you when mainnet opens
// ============================================================================

function NotifySection() {
  const channels: { tag: string; t: string; d: string; accent?: "cyan" }[] = [
    {
      tag: "every signup",
      t: "Automatic dApp gating",
      d: "When the same wallet reconnects to percolator.trade after mainnet opens, the page unlocks priority access for that pubkey. Email signups get this too — Privy creates a Solana embedded wallet under your email at signup, so the dApp recognises you when you come back.",
      accent: "cyan",
    },
    {
      tag: "wallet signups",
      t: "On-chain memo from our project wallet",
      d: "Your wallet receives a memo-only transaction from our project wallet when mainnet opens — visible in Phantom, Solflare, Backpack, or Solscan as an incoming tx with a short message and a claim link. No payload, no value, no token-approval prompt.",
    },
    {
      tag: "email signups",
      t: "Transactional email at the milestone",
      d: "Confirmation lands instantly at signup. The next email is the mainnet-open milestone. No drips, no marketing campaigns. One email per major milestone, max.",
      accent: "cyan",
    },
    {
      tag: "if provided",
      t: "X DM to your handle",
      d: "Optional on either path. If you dropped your @handle, we'll DM you on X as a backup channel.",
    },
  ];
  return (
    <section className="grid gap-x-12 gap-y-10 lg:grid-cols-[1fr_2fr]">
      <div>
        <h2
          className="text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] text-[var(--text)]"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Both paths reach you.
          <br />
          Pick your inbox.
        </h2>
        <p className="mt-4 max-w-[330px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          Email signups get an embedded Solana wallet from Privy automatically — so they get the dApp gate too, not just the email. Wallet signups also get the on-chain memo.
        </p>
      </div>
      <div className="space-y-3">
        {channels.map((c) => (
          <div
            key={c.tag}
            className="grid grid-cols-[110px_1fr] items-baseline gap-5 border-b border-[var(--border)] py-3 last:border-b-0"
          >
            <span
              className={`font-mono text-[11px] uppercase tracking-[0.05em] ${c.accent === "cyan" ? "text-[var(--cyan)]" : "text-[var(--accent)]"}`}
            >
              {c.tag}
            </span>
            <div>
              <div className="text-[14px] font-semibold leading-tight text-[var(--text)]">
                {c.t}
              </div>
              <p className="mt-1.5 max-w-[600px] text-[13px] leading-[1.6] text-[var(--text-secondary)]">
                {c.d}
              </p>
            </div>
          </div>
        ))}
      </div>
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
        <span className="font-mono text-[11px] text-[var(--text-dim)]">
          updated 2026-05
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <ReadoutCell
          label="Mainnet"
          value="lab mode"
          sub="1 active market · audit pending"
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
  const isLive = accent === "cyan" || accent === "purple";
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--border)] p-5 transition-colors last:border-b-0 hover:bg-[var(--bg-elevated)]/40 sm:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(4n)]:border-r-0">
      <div className="flex items-center gap-1.5">
        {isLive && (
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${accent === "cyan" ? "bg-[var(--cyan)]" : "bg-[var(--accent)]"}`}
          />
        )}
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          {label}
        </span>
      </div>
      <span
        className={`font-mono text-[26px] font-bold leading-none tracking-[-0.01em] ${colorClass}`}
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
    <div className="group relative grid grid-cols-[120px_1fr] items-baseline gap-5 border-b border-[var(--border)] py-4 transition-all last:border-b-0 hover:border-[var(--border-hover)]">
      {/* Hover left-edge indicator — subtle bar on the left when hovered */}
      <span
        aria-hidden
        className="absolute -left-2 top-4 bottom-4 w-px scale-y-0 bg-[var(--accent)] transition-transform duration-200 group-hover:scale-y-100"
      />
      <span className={`font-mono text-[11px] uppercase tracking-[0.08em] ${tagColor}`}>
        {tag}
      </span>
      <div>
        <div className="text-[14.5px] font-semibold leading-tight tracking-[-0.005em] text-[var(--text)] transition-colors group-hover:text-[var(--text)]">
          {t}
        </div>
        <p className="mt-1.5 max-w-[600px] text-[13px] leading-[1.6] text-[var(--text-secondary)]">
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
          Toly&apos;s math.
          <br />
          Forked &amp; extended.
        </h2>
        <p className="mt-3 max-w-[300px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          Anatoly Yakovenko authored the H + A/K risk-engine math and an open-source reference program. We forked the program and extended it on chain — without the work below it&apos;d still be a reference, not a product.
        </p>
      </div>
      <div>
        {/* Visual fork delta: toly → us */}
        <div className="rounded-md border border-[var(--border)] bg-[var(--panel-bg)] p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11.5px]">
            <span className="text-[var(--text-secondary)]">github.com/</span>
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
            Net new in the fork: LP vault, dispute resolution, transferable Token-2022 NFT positions, a withdrawal queue, audit-crank invariant checks, two-step admin handover, DEX-pool oracle pinning — none of which exist in Toly&apos;s reference. Plus the SDK, indexer, keeper fleet, and frontend that wrap the program. Mainnet is deployed in lab mode; public trading opens after the external audit.{" "}
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
    <div className="group flex flex-col gap-1.5 bg-[var(--panel-bg)] px-4 py-5 transition-colors hover:bg-[var(--bg-elevated)] sm:px-5">
      <span
        className="bg-clip-text font-mono text-[32px] font-bold leading-none text-transparent"
        style={{
          fontVariantNumeric: "tabular-nums",
          backgroundImage:
            "linear-gradient(135deg, #B97AFF 0%, #9945FF 50%, #14F195 110%)",
        }}
      >
        {n}
      </span>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
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
      "Wallet vs email — which should I pick?",
      <>
        Either works. Wallet path: connect your existing Solana wallet, sign once. Email path: drop your email, verify with a 6-digit code; Privy creates an embedded Solana wallet under your email so you also get the on-chain dApp gate when mainnet opens — not just the email confirmation. Email path is the lower-friction option if you don&apos;t already have a Solana wallet.
      </>,
    ],
    [
      "How will I actually be notified when mainnet opens?",
      <>
        Both paths get automatic dApp gating — when you come back to percolator.trade, the page recognises your wallet (yours or the embedded one) and unlocks priority access. Wallet path additionally gets an on-chain memo from our project wallet (visible in Phantom / Solflare / Backpack / Solscan). Email path gets a one-shot transactional email at the milestone. Optional X DM on either path if you dropped a handle.
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
// FOOTER — status pill + contacts, mono-styled (waitlist count intentionally
// hidden from the public page)
// ============================================================================

function Footer() {
  return (
    <div className="mt-24 grid gap-y-3 border-t border-[var(--border)] pt-6 sm:flex sm:items-center sm:justify-between">
      <div className="flex items-center gap-3 font-mono">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cyan)]" />
        <span className="text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          live · pre-audit · audit Q3
        </span>
      </div>
      <div className="font-mono text-[11.5px]">
        <a
          href="https://x.com/percolatortrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
        >
          @percolatortrade
        </a>
        <span className="mx-2 text-[var(--text-dim)]">·</span>
        <a
          href="mailto:contact@percolator.trade"
          className="text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
        >
          contact@percolator.trade
        </a>
        <span className="mx-2 text-[var(--text-dim)]">·</span>
        <a
          href="https://github.com/dcccrypto"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
        >
          github
        </a>
      </div>
    </div>
  );
}

