"use client";

/**
 * The playground gate.
 *
 * Devnet v2 opens to the waitlist in position order, so this page answers one
 * question: is the person in front of it on the list, and is their position
 * inside the cohort currently open?
 *
 * EVERY part of that answer is decided server-side by /api/playground/authorize,
 * which verifies the Privy session against Privy with the app secret and reads
 * the position from the same `waitlist_position` RPC members already see on the
 * waitlist page. Nothing here decides anything: this file renders a verdict it
 * was handed. Editing client state cannot manufacture access, because access is
 * not a thing the client holds — entry is a signed token this page never mints.
 *
 * Two ways in, because people joined the waitlist two ways: the wallet they
 * signed up with, or the email they signed up with. Privy covers both, and the
 * server resolves either to the same waitlist row.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePrivy, useLoginWithEmail } from "@privy-io/react-auth";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { usePlaygroundAccess } from "@/hooks/usePlaygroundAccess";
import { EnterPlaygroundButton } from "@/components/playground/EnterPlaygroundButton";

/** Slow drifting field behind the card — the "something is running in there" layer. */
function Starfield() {
  // Positions are deterministic, not random: a random field re-seeds on every
  // render and shimmers distractingly. Deterministic also means SSR and the
  // client agree, so there is no hydration mismatch.
  const motes = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        left: (i * 37) % 100,
        top: (i * 61) % 100,
        delay: (i % 9) * 0.7,
        dur: 7 + (i % 5) * 1.6,
        size: i % 7 === 0 ? 2 : 1,
      })),
    [],
  );
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {motes.map((m, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-[var(--accent)]/25 motion-safe:animate-[pg-drift_var(--d)_ease-in-out_infinite]"
          style={{
            left: `${m.left}%`,
            top: `${m.top}%`,
            width: m.size,
            height: m.size,
            ["--d" as string]: `${m.dur}s`,
            animationDelay: `${m.delay}s`,
          }}
        />
      ))}
      {/* A single slow scanline. One is atmospheric; several would be a screensaver. */}
      <span className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-[var(--accent)]/20 to-transparent motion-safe:animate-[pg-scan_11s_linear_infinite]" />
    </div>
  );
}

/** Monospaced position, counted up once so the number lands rather than appears. */
function PositionReveal({ position }: { position: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(position);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const DUR = 900;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      // Ease out — fast at first, settling onto the real number.
      setShown(Math.round(position * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setShown(position);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [position]);

  return (
    <span
      className="tabular-nums text-[var(--accent)]"
      style={{ fontFamily: "var(--font-jetbrains-mono), ui-monospace, monospace" }}
    >
      #{shown.toLocaleString()}
    </span>
  );
}

/**
 * This page owns its animations rather than adding them to globals.css.
 *
 * They are used nowhere else, and keeping them here means the gate can land,
 * change or be reverted without touching a stylesheet every other page shares
 * -- and without colliding with any other branch editing the same file.
 * `motion-safe:` on the consumers already honours prefers-reduced-motion.
 */
const GATE_KEYFRAMES = `
@keyframes pg-drift {
  0%, 100% { transform: translate3d(0, 0, 0); opacity: 0.25; }
  50%      { transform: translate3d(6px, -10px, 0); opacity: 0.7; }
}
@keyframes pg-scan {
  0%   { top: -5%; opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  100% { top: 105%; opacity: 0; }
}
@keyframes pg-pulse {
  0%, 100% { opacity: 0.25; transform: scaleX(0.6); }
  50%      { opacity: 1;    transform: scaleX(1); }
}`;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-[calc(100dvh-48px)] items-center justify-center px-4 py-16">
      <style>{GATE_KEYFRAMES}</style>
      <Starfield />
      <section className="relative w-full max-w-md border border-[var(--border)] bg-[var(--panel-bg)]/80 p-7 backdrop-blur-sm">
        {/* Hairline accent along the top edge — the card reads as a terminal. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--accent)]/50 to-transparent"
        />
        {children}
      </section>
    </main>
  );
}

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-2 text-[10px] uppercase tracking-[0.22em] text-[var(--text-secondary)]">{children}</p>
);

export default function PlaygroundGatePage() {
  const privyAvailable = usePrivyAvailable();
  const { ready, authenticated, login, logout } = usePrivy();
  const { state, recheck } = usePlaygroundAccess();

  // Email path. `sendCode` then `loginWithCode` — the same pair the waitlist
  // page uses, so a member signs in exactly the way they signed up.
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailStage, setEmailStage] = useState<"closed" | "email" | "code" | "sending">("closed");
  const [emailError, setEmailError] = useState<string | null>(null);

  async function onSendCode() {
    setEmailError(null);
    setEmailStage("sending");
    try {
      // Only send a code to an address that is on the waitlist (checked against the waitlist DB).
      const pre = await fetch("/api/playground/precheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      })
        .then((r) =>
          r.status === 429
            ? { onList: false, limited: true }
            : r.ok
              ? (r.json() as Promise<{ onList?: boolean; limited?: boolean }>)
              : { onList: true },
        )
        .catch(() => ({ onList: true }));
      if ("limited" in pre && pre.limited) {
        setEmailError("Too many tries from this network. Wait 10 minutes, then try again.");
        setEmailStage("email");
        return;
      }
      if (!pre.onList) {
        setEmailError(
          "We don't see that email on the waitlist. Check it's the exact address you joined with. If you joined with a wallet, use Connect wallet instead.",
        );
        setEmailStage("email");
        return;
      }
      await sendCode({ email: email.trim() });
      setEmailStage("code");
    } catch {
      setEmailError("Could not send that code. Check the address and try again.");
      setEmailStage("email");
    }
  }

  async function onSubmitCode() {
    setEmailError(null);
    try {
      await loginWithCode({ code: code.trim() });
      // No navigation here. Signing in flips `authenticated`, the access hook
      // re-asks the server, and the verdict below re-renders.
    } catch {
      setEmailError("That code did not work. Request a new one.");
    }
  }

  if (!privyAvailable) {
    return (
      <Shell>
        <Eyebrow>Playground</Eyebrow>
        <h1 className="text-lg font-semibold text-[var(--text)]">Sign-in is unavailable</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          We could not load the sign-in service. Refresh, or try again shortly.
        </p>
      </Shell>
    );
  }

  // ── Verified ────────────────────────────────────────────────────────────
  if (state.status === "granted") {
    return (
      <Shell>
        <Eyebrow>Verified</Eyebrow>
        <h1 className="text-xl font-semibold text-[var(--text)]">You&apos;re on the list.</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Waitlist position <PositionReveal position={state.position} />. You are in the opening
          group for devnet&nbsp;v2.
        </p>
        {state.open ? (
          // Launch is open. The button posts to this site; the server
          // re-verifies and only its redirect names the playground.
          <div className="mt-6">
            <EnterPlaygroundButton className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.10] px-4 py-2.5 text-[12px] uppercase tracking-[0.14em] text-[var(--text)] transition-all hover:border-[var(--accent)]/80 hover:bg-[var(--accent)]/[0.16] disabled:opacity-60">
              Enter Playground →
            </EnterPlaygroundButton>
          </div>
        ) : (
          <div className="mt-6 border border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] p-3">
            <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
              You&apos;re in. Opens at launch — come back here, or use the Playground tab, and it
              will let you straight through.
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={() => logout()}
          className="mt-5 text-[11px] uppercase tracking-[0.14em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
        >
          Not you? Sign out
        </button>
      </Shell>
    );
  }

  // ── On the list, further back than the open cohort ──────────────────────
  if (state.status === "queued") {
    return (
      <Shell>
        <Eyebrow>Not yet</Eyebrow>
        <h1 className="text-xl font-semibold text-[var(--text)]">You&apos;re in the queue.</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {state.position != null ? (
            <>
              You are <PositionReveal position={state.position} />, and we have opened the first{" "}
              {state.cutoff.toLocaleString()}. We are letting people in steadily — your turn is
              coming.
            </>
          ) : (
            <>You are on the waitlist, but not in the group that is open yet.</>
          )}
        </p>
        <p className="mt-4 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Moving up is simple: every person who joins with your referral link moves you forward.
        </p>
        <Link
          href="/waitlist"
          className="mt-5 inline-block text-[11px] uppercase tracking-[0.14em] text-[var(--accent)] transition-opacity hover:opacity-80"
        >
          Get your referral link →
        </Link>
      </Shell>
    );
  }

  // ── Signed in, not on the waitlist ──────────────────────────────────────
  if (state.status === "not-member") {
    return (
      <Shell>
        <Eyebrow>No match</Eyebrow>
        <h1 className="text-xl font-semibold text-[var(--text)]">We don&apos;t see you on the list.</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          This wallet and email are not on the waitlist. If you signed up with a different one, sign
          out and try that instead.
        </p>
        <div className="mt-6 flex items-center gap-4">
          <Link
            href="/waitlist"
            className="text-[11px] uppercase tracking-[0.14em] text-[var(--accent)] transition-opacity hover:opacity-80"
          >
            Join the waitlist →
          </Link>
          <button
            type="button"
            onClick={() => logout()}
            className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
          >
            Sign out
          </button>
        </div>
      </Shell>
    );
  }

  // ── Something went wrong — retryable, and never a grant ──────────────────
  if (state.status === "error") {
    return (
      <Shell>
        <Eyebrow>Interrupted</Eyebrow>
        <h1 className="text-xl font-semibold text-[var(--text)]">We couldn&apos;t check that.</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Something went wrong on the way to our server — not on your side. Your place in the queue
          is unaffected.
        </p>
        <button
          type="button"
          onClick={recheck}
          className="mt-5 border border-[var(--border)] px-4 py-2 text-[12px] uppercase tracking-[0.14em] text-[var(--text)] transition-colors hover:border-[var(--accent)]/50"
        >
          Try again
        </button>
      </Shell>
    );
  }

  // ── Checking ────────────────────────────────────────────────────────────
  if (!ready || state.status === "checking" || (authenticated && state.status === "idle")) {
    return (
      <Shell>
        <Eyebrow>Playground</Eyebrow>
        <h1 className="text-xl font-semibold text-[var(--text)]">Checking the list…</h1>
        <div className="mt-5 flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1 w-8 bg-[var(--accent)]/30 motion-safe:animate-[pg-pulse_1.4s_ease-in-out_infinite]"
              style={{ animationDelay: `${i * 0.18}s` }}
            />
          ))}
        </div>
        <p className="sr-only" role="status">
          Verifying your waitlist position
        </p>
      </Shell>
    );
  }

  // ── Not signed in: the two ways in ──────────────────────────────────────
  return (
    <Shell>
      <Eyebrow>Playground · devnet v2</Eyebrow>
      <h1 className="text-xl font-semibold text-[var(--text)]">Prove you&apos;re on the list.</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
        We are opening devnet&nbsp;v2 to the waitlist in order. Sign in the way you signed up — the
        wallet you used, or the email you used.
      </p>

      {emailStage === "closed" && (
        <div className="mt-6 space-y-2.5">
          <button
            type="button"
            onClick={() => login()}
            className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.08] px-4 py-2.5 text-[12px] uppercase tracking-[0.14em] text-[var(--text)] transition-all hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.14]"
          >
            Connect wallet
          </button>
          <button
            type="button"
            onClick={() => setEmailStage("email")}
            className="w-full border border-[var(--border)] px-4 py-2.5 text-[12px] uppercase tracking-[0.14em] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]"
          >
            Continue with email
          </button>
        </div>
      )}

      {(emailStage === "email" || emailStage === "sending") && (
        <div className="mt-6 space-y-2.5">
          <label htmlFor="pg-email" className="sr-only">
            Email address
          </label>
          <input
            id="pg-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="the email you joined with"
            className="w-full border border-[var(--border)] bg-transparent px-3 py-2.5 text-[13px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-secondary)]/60 focus:border-[var(--accent)]/60"
          />
          <button
            type="button"
            disabled={emailStage === "sending" || email.trim().length < 3}
            onClick={onSendCode}
            className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.08] px-4 py-2.5 text-[12px] uppercase tracking-[0.14em] text-[var(--text)] transition-all hover:border-[var(--accent)]/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {emailStage === "sending" ? "Sending…" : "Send me a code"}
          </button>
        </div>
      )}

      {emailStage === "code" && (
        <div className="mt-6 space-y-2.5">
          <label htmlFor="pg-code" className="sr-only">
            Sign-in code
          </label>
          <input
            id="pg-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            className="w-full border border-[var(--border)] bg-transparent px-3 py-2.5 text-center text-[15px] tracking-[0.4em] text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]/60"
            style={{ fontFamily: "var(--font-jetbrains-mono), ui-monospace, monospace" }}
          />
          <button
            type="button"
            disabled={code.trim().length < 4}
            onClick={onSubmitCode}
            className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.08] px-4 py-2.5 text-[12px] uppercase tracking-[0.14em] text-[var(--text)] transition-all hover:border-[var(--accent)]/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Verify
          </button>
        </div>
      )}

      {emailError && (
        <p role="alert" className="mt-3 text-[12px] text-[var(--short)]">
          {emailError}
        </p>
      )}

      {emailStage !== "closed" && (
        <button
          type="button"
          onClick={() => {
            setEmailStage("closed");
            setEmailError(null);
            setCode("");
          }}
          className="mt-4 text-[11px] uppercase tracking-[0.14em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
        >
          ← Back
        </button>
      )}

      <p className="mt-7 border-t border-[var(--border)] pt-4 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        Not on the waitlist yet?{" "}
        <Link href="/waitlist" className="text-[var(--accent)] transition-opacity hover:opacity-80">
          Join here
        </Link>
        .
      </p>
    </Shell>
  );
}
