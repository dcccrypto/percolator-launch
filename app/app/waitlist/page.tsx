"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { usePrivy, useLoginWithEmail } from "@privy-io/react-auth";
import { useWallets, useSignMessage } from "@privy-io/react-auth/solana";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { resolveActiveWallet, usePreferredWallet } from "@/hooks/usePreferredWallet";
import { useWaitlistWhoami } from "@/hooks/useWaitlistWhoami";
import bs58 from "bs58";

/**
 * Reads the inbound referrer code from the URL.
 *
 * Two sources are accepted:
 *   • ?referrer=<code> — set by /r/[code]/page.tsx when someone lands on a
 *     share link. Path-based (/r/AB23XYZ9) is what we generate and share;
 *     ?referrer is the internal forwarding param.
 *   • ?ref=<code> — legacy / direct query-string form. The existing source
 *     handling uses ?ref for analytics, so we deliberately don't read from
 *     there for attribution; mention it only because the search ordering
 *     here is "referrer-first".
 *
 * Returns the uppercased code or empty string. Shape validation lives on
 * the server — bad codes are rejected at submit, not at input.
 */
function readReferrerFromUrl(): string {
  if (typeof window === "undefined") return "";
  const raw = new URL(window.location.href).searchParams.get("referrer");
  return raw ? raw.trim().toUpperCase() : "";
}

type CodeStatus =
  | "empty"
  | "typing"
  | "checking"
  | "valid"
  | "invalid"
  | "error";

/**
 * Debounced live-validation against /api/waitlist/check-code.
 *
 * Both Wallet and Email flows gate their submit CTA on `status === "valid"`,
 * so a user with a bogus code gets a green/red signal before being sent
 * through Privy OTP or being asked to sign a wallet message.
 *
 * `"invalid"` means the server actively rejected the code (wrong, revoked,
 * or never existed). `"error"` means we couldn't determine — network
 * failure, server unreachable — and the UI tells the user to retry rather
 * than implying the code is bad.
 */
function useReferralCodeValidation(code: string): { status: CodeStatus } {
  const [status, setStatus] = useState<CodeStatus>("empty");

  useEffect(() => {
    if (!code) {
      setStatus("empty");
      return;
    }
    if (code.length < 8) {
      // Too short to plausibly be a real code — keep the rest of the form
      // locked but don't burn a request on every keystroke.
      setStatus("typing");
      return;
    }
    setStatus("typing");
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (controller.signal.aborted) return;
      setStatus("checking");
      try {
        const res = await fetch(
          `/api/waitlist/check-code?code=${encodeURIComponent(code)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const json = (await res.json()) as { valid?: boolean };
        if (controller.signal.aborted) return;
        setStatus(json.valid ? "valid" : "invalid");
      } catch (err) {
        if (controller.signal.aborted) return;
        // AbortError on cleanup — not a real failure
        if (err instanceof Error && err.name === "AbortError") return;
        setStatus("error");
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [code]);

  return { status };
}

type State =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "signing" }
  | { kind: "submitting" }
  | {
      kind: "done";
      position: number | null;
      referralCode: string | null;
      // True when this signup was a no-op idempotent re-submit (wallet
      // already on the list). Used by the success card to switch from
      // "you're in" to "welcome back" copy.
      returning: boolean;
    }
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
          invite-only · referral code required
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

  // Auto-detect: if the visitor is already a Privy user *and* already on
  // the waitlist (by DID / wallet / email), skip the signup form entirely
  // and surface their existing referral code. Returns "idle" / "checking"
  // / "not-found" / "found" — we only intercept the rendering on "found".
  const whoami = useWaitlistWhoami();

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
          {whoami.status === "found" ? (
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--cyan)]/50 bg-[var(--cyan)]/[0.12] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--cyan)]">
              ✓ on the list
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--accent)]/50 bg-[var(--accent)]/[0.12] px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--accent)]">
              <svg
                aria-hidden
                viewBox="0 0 12 12"
                className="h-2.5 w-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
              >
                <rect x="3" y="5.5" width="6" height="5" rx="0.6" />
                <path d="M4.25 5.5V3.75a1.75 1.75 0 1 1 3.5 0V5.5" />
              </svg>
              Invite only
            </span>
          )}
        </div>

        {whoami.status === "found" ? (
          <WelcomeBackPanel
            referralCode={whoami.referralCode}
            position={whoami.position}
          />
        ) : (
          <>
            {/* Tab selector */}
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-md border border-[var(--border)] bg-[var(--bg)] p-1">
              <TabButton active={tab === "wallet"} onClick={() => setTab("wallet")}>
                Wallet
              </TabButton>
              <TabButton active={tab === "email"} onClick={() => setTab("email")}>
                Email
              </TabButton>
            </div>

            {whoami.status === "checking" && (
              <div className="mb-3 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--text-dim)]">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
                checking_session...
              </div>
            )}

            {tab === "wallet" ? (
              privyAvailable ? (
                <SignupFlow />
              ) : (
                <StatusErr>Wallet provider not configured. Reload the page.</StatusErr>
              )
            ) : (
              <EmailFlow />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Returning-user UI. Shown when /api/waitlist/whoami resolves to "found"
 * via Privy session — usually a single fetch after page load, no manual
 * sign / submit step required from the user.
 *
 * Reuses ReferralCard for the code + share link block so the visual
 * language matches the post-signup state of the existing flows.
 */
function WelcomeBackPanel({
  referralCode,
  position,
}: {
  referralCode: string;
  position: number | null;
}) {
  const shareUrl = `https://percolator.trade/r/${referralCode}`;
  return (
    <div className="space-y-3.5">
      <PromptLine prefix="$" text="welcome_back" status="ok" />
      <div className="rounded-md border border-[var(--cyan)]/25 bg-[var(--cyan)]/[0.05] p-3.5">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--cyan)]">
          ✓ already on the list
        </div>
        {position ? (
          <div
            className="mt-1.5 font-mono text-[28px] font-bold leading-none text-[var(--text)]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            #{position.toLocaleString()}
          </div>
        ) : null}
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          We recognised you from your Privy session — no need to sign again.
          Your referral code is below.
        </p>
      </div>
      <ReferralCard code={referralCode} shareUrl={shareUrl} />
      <a
        className={ctaSecondary}
        href={`https://x.com/intent/post?text=${encodeURIComponent(
          `Just got my Percolator waitlist code: ${referralCode}. Permissionless perp futures on Solana. ${shareUrl}`,
        )}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        → Share on X
      </a>
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
  | { kind: "submitting"; email: string }
  | {
      kind: "done";
      email: string;
      position: number | null;
      referralCode: string | null;
    }
  | { kind: "error"; reason: string };

function EmailFlow() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [twitter, setTwitter] = useState("");
  const [referredBy, setReferredBy] = useState("");
  const [state, setState] = useState<EmailState>({ kind: "idle" });
  const { status: refStatus } = useReferralCodeValidation(referredBy);

  // Pre-fill the referrer input from /r/<code> landings, then scrub the
  // query param so users who copy from the address bar later don't end up
  // sharing someone else's referrer code instead of their own.
  useEffect(() => {
    const fromUrl = readReferrerFromUrl();
    if (fromUrl) {
      setReferredBy(fromUrl);
      try {
        window.history.replaceState({}, "", "/waitlist#reserve");
      } catch {
        /* SSR / older browsers — non-fatal */
      }
    }
  }, []);

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
  // The embedded-wallet binding step is gone — see the submit effect below
  // for why. useWallets / useSignMessage are no longer needed in EmailFlow.

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

  // After Privy login completes, submit the email to the waitlist API.
  //
  // The earlier flow had the embedded Privy Solana wallet sign the join
  // message and submitted (email, pubkey, signature). The server skipped
  // the on-chain existence check on this combined shape on the assumption
  // that Privy's OTP gate proved real intent — but the server never
  // actually verified anything from Privy, so any caller could pair a
  // self-controlled keypair with an arbitrary email and pre-empt that
  // email's row. The server now rejects the combined shape; here we just
  // submit the email-only shape and rely on Privy at mainnet open to
  // re-derive the user's embedded wallet from their verified email.
  useEffect(() => {
    if (state.kind !== "verifying") return;
    if (!ready || !authenticated || !user) return;
    const userEmail =
      user.email?.address?.trim().toLowerCase() ?? email.trim().toLowerCase();
    if (!userEmail) {
      setState({ kind: "error", reason: "missing email after login" });
      return;
    }

    setState({ kind: "submitting", email: userEmail });
    (async () => {
      try {
        const url = new URL(window.location.href);
        const source =
          url.searchParams.get("ref") ?? url.searchParams.get("utm_source") ?? null;
        const res = await fetch("/api/waitlist/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: userEmail,
            twitter_handle: twitter.trim() || undefined,
            source: source ?? undefined,
            referred_by_code: referredBy.trim() || undefined,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          position?: number | null;
          referral_code?: string | null;
        };
        if (!res.ok || !json.ok) {
          setState({ kind: "error", reason: json.error ?? `HTTP ${res.status}` });
          return;
        }
        setState({
          kind: "done",
          email: userEmail,
          position: json.position ?? null,
          referralCode: json.referral_code ?? null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "submit failed";
        setState({ kind: "error", reason: msg });
      }
    })();
  }, [state, ready, authenticated, user, twitter, email, referredBy]);

  if (state.kind === "done") {
    const shareUrl = state.referralCode
      ? `https://percolator.trade/r/${state.referralCode}`
      : null;
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
            {state.referralCode ? (
              <>
                Confirmation + referral code sent to{" "}
                <span className="font-mono text-[var(--accent)]">{state.email}</span>.
              </>
            ) : (
              <>
                You&apos;re already on the list under{" "}
                <span className="font-mono text-[var(--accent)]">{state.email}</span>.
                Your referral code is in the confirmation email we sent on your first signup.
              </>
            )}
          </p>
        </div>
        {state.referralCode && shareUrl ? (
          <ReferralCard code={state.referralCode} shareUrl={shareUrl} />
        ) : null}
      </div>
    );
  }

  if (state.kind === "awaiting-code" || state.kind === "verifying") {
    const busy = state.kind === "verifying";
    return (
      <div className="space-y-3.5">
        <PromptLine prefix="$" text={`code_sent ${state.kind === "awaiting-code" ? state.email : ""}`} status="pending" />
        <div className="space-y-1.5">
          <label
            htmlFor="otp-code"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]"
          >
            6-digit code
          </label>
          <input
            id="otp-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[15px] tracking-[0.4em] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15"
            placeholder="000000"
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

  if (state.kind === "submitting") {
    return (
      <div className="space-y-3">
        <PromptLine prefix="$" text="submitting" status="pending" />
        <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Verified {state.email}. Adding you to the list now.
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
  const formUnlocked = refStatus === "valid";
  return (
    <div className="space-y-3.5">
      <PromptLine prefix="$" text="email_signup" status="idle" />
      <ReferralCodeInput
        value={referredBy}
        onChange={setReferredBy}
        status={refStatus}
        disabled={sending}
      />
      <FormGateDivider unlocked={formUnlocked} />
      <div
        className={`space-y-3.5 transition-opacity duration-200 ${
          formUnlocked ? "" : "pointer-events-none select-none opacity-40"
        }`}
        aria-hidden={!formUnlocked}
      >
        <div className="space-y-1.5">
          <label
            htmlFor="signup-email"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]"
          >
            email
          </label>
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15 disabled:opacity-50"
            placeholder="you@domain.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sending || !formUnlocked}
            maxLength={254}
            tabIndex={formUnlocked ? 0 : -1}
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="x-handle"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]"
          >
            x_handle (optional)
          </label>
          <input
            id="x-handle"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15 disabled:opacity-50"
            placeholder="@yourhandle"
            value={twitter}
            onChange={(e) => setTwitter(e.target.value)}
            disabled={sending || !formUnlocked}
            maxLength={30}
            tabIndex={formUnlocked ? 0 : -1}
          />
        </div>
        <button
          className={ctaPrimary}
          onClick={onSendCode}
          disabled={sending || !formUnlocked}
          tabIndex={formUnlocked ? 0 : -1}
        >
          {sending
            ? "Sending code…"
            : formUnlocked
              ? "Send 6-digit code →"
              : "Enter referral code to continue"}
        </button>
      </div>
      <NoCodeFallback />
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
  const [referredBy, setReferredBy] = useState("");
  const { status: refStatus } = useReferralCodeValidation(referredBy);

  // Pre-fill the referrer input from /r/<code> landings (forwarded as
  // ?referrer=<code> by the /r route). Scrub the query param after so
  // users who copy from the address bar later don't share someone else's
  // referrer instead of their own.
  useEffect(() => {
    const fromUrl = readReferrerFromUrl();
    if (fromUrl) {
      setReferredBy(fromUrl);
      try {
        window.history.replaceState({}, "", "/waitlist#reserve");
      } catch {
        /* SSR / older browsers — non-fatal */
      }
    }
  }, []);

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
          referred_by_code: referredBy.trim() || undefined,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        position?: number | null;
        referral_code?: string | null;
        returning?: boolean;
      };
      if (!res.ok || !json.ok) {
        setState({ kind: "error", reason: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({
        kind: "done",
        position: json.position ?? null,
        referralCode: json.referral_code ?? null,
        returning: json.returning === true,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "sign cancelled";
      setState({ kind: "error", reason: msg });
    }
  }, [activeWallet, pubkey, signMessage, twitter, referredBy]);

  useEffect(() => {
    if (state.kind === "connecting" && ready && authenticated && pubkey) {
      setState({ kind: "ready" });
    }
  }, [state, ready, authenticated, pubkey]);

  // Done state
  if (state.kind === "done") {
    const shareUrl = state.referralCode
      ? `https://percolator.trade/r/${state.referralCode}`
      : "https://percolator.trade";
    const shareText = state.referralCode
      ? `Just joined the @percolatortrade waitlist. Permissionless perp futures on Solana. Use my code ${state.referralCode}: ${shareUrl}`
      : "Just joined the @percolatortrade waitlist. Permissionless perp futures on Solana. percolator.trade";
    const headlineLabel = state.returning ? "✓ welcome back" : "✓ on the list";
    const subline = state.returning
      ? "You're already on the list — sharing your code below."
      : (
        <>
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
        </>
      );
    return (
      <div className="space-y-4">
        <PromptLine prefix="$" text="claim_spot" status="ok" />
        <div className="rounded-md border border-[var(--cyan)]/25 bg-[var(--cyan)]/[0.05] p-3.5">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--cyan)]">
            {headlineLabel}
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
            {subline}
          </p>
        </div>
        {state.referralCode ? (
          <ReferralCard code={state.referralCode} shareUrl={shareUrl} />
        ) : null}
        <a
          className={ctaSecondary}
          href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}`}
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
    const formUnlocked = refStatus === "valid";
    return (
      <div className="space-y-3.5">
        <PromptLine prefix="$" text={`connected ${pubkey?.slice(0, 6)}…${pubkey?.slice(-4)}`} status="ok" />
        <ReferralCodeInput
          value={referredBy}
          onChange={setReferredBy}
          status={refStatus}
          disabled={busy}
        />
        <FormGateDivider unlocked={formUnlocked} />
        {/* The x_handle is only relevant for NEW signups (it lands on the
            inserted row). For returning users it's ignored, so we keep
            it inside the locked container with the gate. The submit
            button moves OUT of the locked container so pre-invite users
            can sign in and look up their existing code without supplying
            an invite — the server returns it once the wallet signature
            proves ownership. */}
        <div
          className={`space-y-3.5 transition-opacity duration-200 ${
            formUnlocked ? "" : "pointer-events-none select-none opacity-40"
          }`}
          aria-hidden={!formUnlocked}
        >
          <div className="space-y-1.5">
            <label
              htmlFor="x-handle-wallet"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]"
            >
              x_handle (optional)
            </label>
            <input
              id="x-handle-wallet"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/15 disabled:opacity-50"
              placeholder="@yourhandle"
              value={twitter}
              onChange={(e) => setTwitter(e.target.value)}
              disabled={busy || !formUnlocked}
              maxLength={30}
              tabIndex={formUnlocked ? 0 : -1}
            />
          </div>
        </div>
        <button
          className={ctaPrimary}
          onClick={onSign}
          disabled={busy}
        >
          {state.kind === "signing"
            ? "Signing in your wallet…"
            : state.kind === "submitting"
              ? "Submitting…"
              : formUnlocked
                ? "Sign & claim spot →"
                : "Sign in to check / look up code →"}
        </button>
        {!formUnlocked && (
          <p className="font-mono text-[10.5px] leading-relaxed text-[var(--text-secondary)]">
            Already on the waitlist? Sign — we&apos;ll surface your existing
            referral code. New here? Enter a referral code above to claim
            your spot.
          </p>
        )}
        <NoCodeFallback />
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
  const formUnlocked = refStatus === "valid";
  return (
    <div className="space-y-3.5">
      <PromptLine
        prefix="$"
        text={state.kind === "connecting" ? "connecting…" : "connect_wallet"}
        status={state.kind === "connecting" ? "pending" : "idle"}
      />
      <ReferralCodeInput
        value={referredBy}
        onChange={setReferredBy}
        status={refStatus}
        disabled={state.kind === "connecting"}
      />
      <button
        className={ctaPrimary}
        onClick={onConnect}
        disabled={state.kind === "connecting" || !formUnlocked}
      >
        {state.kind === "connecting"
          ? "Connecting…"
          : formUnlocked
            ? "Connect wallet →"
            : "Enter referral code to continue"}
      </button>
      <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
        Phantom · Solflare · Backpack · Jupiter
        <br />
        sign-only · no gas · idempotent
      </p>
      <NoCodeFallback />
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

/**
 * Referral code input with inline live-validation status. Pinned to the top
 * of both signup flows because the form is gated on it (`status === "valid"`).
 *
 * Input is auto-uppercased and filtered to the Crockford base32 alphabet so
 * users can't type chars that would always fail server-side validation
 * (I, L, O, U look like 1, 1, 0, V — dropping them is faster feedback than
 * round-tripping a 400).
 *
 * Indicator copy is split four ways so the user can distinguish a wrong
 * code (red, "× not a valid code") from a network failure (amber,
 * "× couldn't check — retry"). The status pill is wrapped in `role=status`
 * + `aria-live=polite` so screen readers announce changes; the input has a
 * stable `id` matched by the label's `htmlFor` and described by the help
 * text below.
 */
let _referralInputCounter = 0;
function ReferralCodeInput({
  value,
  onChange,
  status,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  status: CodeStatus;
  disabled?: boolean;
}) {
  // Stable per-instance id — both wallet and email flows can render this on
  // the same page, so a hardcoded id would collide.
  const [inputId] = useState(() => `ref-code-${++_referralInputCounter}`);
  const helpId = `${inputId}-help`;

  const indicator = (() => {
    if (status === "valid") return { color: "var(--cyan)", text: "✓ accepted" };
    if (status === "invalid")
      return { color: "var(--short)", text: "× not a valid code" };
    if (status === "error")
      return { color: "#fbbf24", text: "× couldn't check — retry" };
    if (status === "checking")
      return { color: "var(--text-secondary)", text: "checking…" };
    if (status === "typing")
      return {
        color: "var(--text-secondary)",
        text: `${value.length}/8`,
      };
    return null;
  })();
  const borderClass =
    status === "valid"
      ? "border-[var(--cyan)]/50 focus:border-[var(--cyan)] focus:ring-[var(--cyan)]/20"
      : status === "invalid"
        ? "border-[var(--short)]/50 focus:border-[var(--short)] focus:ring-[var(--short)]/20"
        : status === "error"
          ? "border-[#fbbf24]/50 focus:border-[#fbbf24] focus:ring-[#fbbf24]/20"
          : "border-[var(--border)] focus:border-[var(--accent)]/50 focus:ring-[var(--accent)]/15";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label
          htmlFor={inputId}
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]"
        >
          referral code <span className="text-[var(--accent)]">· required</span>
        </label>
        <span
          role="status"
          aria-live="polite"
          className="font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: indicator?.color ?? "transparent" }}
        >
          {indicator?.text ?? "·"}
        </span>
      </div>
      <input
        id={inputId}
        aria-describedby={helpId}
        aria-invalid={status === "invalid" || status === "error"}
        className={`w-full rounded-md border bg-[var(--bg)] px-3 py-2.5 font-mono text-[15px] uppercase tracking-[0.12em] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:ring-1 ${borderClass}`}
        placeholder="AB23XYZ9"
        value={value}
        onChange={(e) =>
          onChange(
            e.target.value
              .toUpperCase()
              .replace(/[^0-9A-HJKMNP-TV-Z]/g, "")
              .slice(0, 8),
          )
        }
        disabled={disabled}
        maxLength={8}
        spellCheck={false}
        autoCapitalize="characters"
        autoComplete="off"
        inputMode="text"
      />
      <p
        id={helpId}
        className="font-mono text-[10px] leading-relaxed text-[var(--text-secondary)]"
      >
        8 characters · uses 0–9 and A–Z (no I, L, O, U)
      </p>
    </div>
  );
}

function NoCodeFallback() {
  return (
    <p className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
      Don&apos;t have a code?{" "}
      <a
        href="https://x.com/percolatortrade"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--accent)] underline-offset-2 hover:underline"
      >
        Follow @percolatortrade
      </a>{" "}
      — we drop codes on tweets every so often.
    </p>
  );
}

/**
 * Visual divider that sits between the referral code input and the rest of
 * the signup fields. The disabled-state `opacity-50` on the inputs below
 * isn't strong enough signal on its own — users tabbing into the email
 * field can't tell why it's inert. This adds an explicit "locked" / next-
 * step label so the gate is legible.
 */
function FormGateDivider({ unlocked }: { unlocked: boolean }) {
  if (unlocked) {
    return (
      <div className="flex items-center gap-2.5 py-0.5">
        <span className="h-px flex-1 bg-[var(--cyan)]/40" />
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--cyan)]">
          ↓ continue
        </span>
        <span className="h-px flex-1 bg-[var(--cyan)]/40" />
      </div>
    );
  }
  // Locked: stronger visual barrier with a lock icon. Pairs with the
  // dimmed pointer-events-none wrapper around the fields below.
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-dashed border-[var(--border)] bg-[var(--bg)]/60 px-3 py-2">
      <svg
        aria-hidden
        viewBox="0 0 14 14"
        className="h-3 w-3 text-[var(--text-secondary)]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
      >
        <rect x="3.5" y="6.5" width="7" height="5.5" rx="0.6" />
        <path d="M5 6.5V4.5a2 2 0 1 1 4 0V6.5" />
      </svg>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-secondary)]">
        Locked — referral code required to continue
      </span>
    </div>
  );
}

function ReferralCard({ code, shareUrl }: { code: string; shareUrl: string }) {
  const [copied, setCopied] = useState<"none" | "code" | "link">("none");
  const copy = async (which: "code" | "link", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      window.setTimeout(() => setCopied("none"), 1600);
    } catch {
      // Clipboard API unavailable (insecure context / older browser).
      // The values are visible in the UI — user can select-and-copy manually.
    }
  };

  // Personal referral count. Polls every 30s so the user can paste their
  // link in Discord, refresh, and watch the number climb. Failure is
  // silent: the row hides rather than showing a confusing zero state.
  const { data: countData } = useSWR<{ count: number }>(
    code ? `/api/waitlist/my-referrals?code=${encodeURIComponent(code)}` : null,
    swrFetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
  );
  const referralCount = countData?.count ?? null;

  return (
    <div className="rounded-md border border-[var(--accent)]/25 bg-[var(--accent)]/[0.05] p-3.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
          your referral code
        </span>
        <button
          onClick={() => copy("code", code)}
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
        >
          {copied === "code" ? "copied ✓" : "copy"}
        </button>
      </div>
      <div
        className="mt-1.5 font-mono text-[22px] font-bold leading-none tracking-[0.08em] text-[var(--text)]"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {code}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-[11.5px] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
        >
          {shareUrl.replace(/^https?:\/\//, "")}
        </a>
        <button
          onClick={() => copy("link", shareUrl)}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
        >
          {copied === "link" ? "copied ✓" : "copy link"}
        </button>
      </div>
      {referralCount !== null && (
        <div className="mt-3 flex items-center justify-between border-t border-[var(--accent)]/15 pt-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-dim)]">
            joined with your code
          </span>
          <span
            className="font-mono text-[14px] font-bold text-[var(--accent)]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {referralCount.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

const swrFetcher = (url: string) =>
  fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

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
          Invite-only.
          <br />
          Code required.
        </h2>
        <p className="mt-4 max-w-[420px] text-[14px] leading-[1.65] text-[var(--text-secondary)]">
          The waitlist is gated. Bring a referral code from an existing member — paste it in, the form unlocks, you finish in under a minute on wallet or email.
        </p>
        <div className="mt-6 space-y-3 font-mono text-[12px] text-[var(--text-secondary)]">
          <SignupBullet color="cyan">Got a code from someone? Paste it. Form unlocks. Pick wallet or email.</SignupBullet>
          <SignupBullet color="cyan">Landed via a share link? Code is already pre-filled — just finish.</SignupBullet>
          <SignupBullet color="cyan">No code yet? Follow @percolatortrade — we drop codes on tweets every so often.</SignupBullet>
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
      "Why do I need a referral code?",
      <>
        The waitlist is invite-only. We&apos;re keeping it tight while we&apos;re pre-audit — fewer, higher-intent people, less noise. Every member who joins gets a unique code they can share. If you don&apos;t have one yet, follow{" "}
        <a
          href="https://x.com/percolatortrade"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          @percolatortrade
        </a>{" "}
        — we drop codes on tweets every so often.
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

