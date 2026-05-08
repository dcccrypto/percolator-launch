"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignMessage } from "@privy-io/react-auth/solana";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { resolveActiveWallet, usePreferredWallet } from "@/hooks/usePreferredWallet";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GradientText } from "@/components/ui/GradientText";
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

// ── Shared design tokens (match /guide and other pages) ─────────────────────
const sectionTag =
  "mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60";
const sectionTitle =
  "text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl";
const sectionSub =
  "mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)] max-w-2xl";
const cardClass =
  "border border-[var(--border)] bg-[var(--panel-bg)] rounded-md";
const bodyText =
  "text-[13px] leading-relaxed text-[var(--text-secondary)]";

function Section({
  tag,
  title,
  children,
}: {
  tag: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <ScrollReveal>
      <section className="space-y-4">
        <div>
          <div className={sectionTag}>// {tag}</div>
          <h2
            className={sectionTitle}
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {title}
          </h2>
        </div>
        {children}
      </section>
    </ScrollReveal>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function WaitlistPage() {
  return (
    <div className="relative min-h-[calc(100dvh-48px)]">
      <div className="absolute inset-x-0 top-0 h-[480px] bg-grid pointer-events-none opacity-40" />
      <div className="absolute inset-x-0 top-0 h-[480px] bg-gradient-to-b from-[var(--accent)]/[0.04] to-transparent pointer-events-none" />

      <main className="relative mx-auto max-w-4xl px-4 py-12 space-y-16 sm:py-16">
        <Hero />
        <Why />
        <Architecture />
        <Origin />
        <FAQ />
        <CountFooter />
      </main>
    </div>
  );
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <ScrollReveal>
      <div className="space-y-6">
        <div className={sectionTag}>// mainnet · audit pending · q3 2026</div>
        <h1
          className="text-3xl font-bold leading-[1.05] tracking-[-0.02em] text-[var(--text)] sm:text-4xl md:text-5xl"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Permissionless perpetual futures
          <br className="hidden sm:block" />{" "}
          <GradientText variant="solana">on Solana</GradientText>.
        </h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-[var(--text-secondary)] sm:text-[15px]">
          Anyone launches a leveraged market on any SPL token in 60 seconds. No team approval, no auction. We took{" "}
          <span className="text-[var(--text)] font-medium">Anatoly Yakovenko&apos;s</span> open research and turned it into a production protocol — with our own LP vault, transferable Token-2022 NFT positions, dispute resolution, and audit-crank invariant checks. Public mainnet trading opens after the external audit clears.
        </p>
        <SignupCard />
      </div>
    </ScrollReveal>
  );
}

function SignupCard() {
  const privyAvailable = usePrivyAvailable();
  return (
    <div className={`${cardClass} p-5 max-w-xl`}>
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

  if (state.kind === "done") {
    return (
      <div className="space-y-3">
        <StatusOk>
          You&apos;re in.
          {state.position ? (
            <>
              {" "}You&apos;re #
              <span className="font-mono font-semibold text-[var(--accent)]">
                {state.position}
              </span>{" "}
              on the waitlist.
            </>
          ) : null}
          {" "}We&apos;ll DM you on X when mainnet opens.
        </StatusOk>
        <a
          className={`${ctaSecondary}`}
          href={`https://x.com/intent/post?text=${encodeURIComponent(
            "Just joined the @percolatortrade waitlist — permissionless perpetual futures on Solana. percolator.trade",
          )}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Share on X
        </a>
      </div>
    );
  }

  if (
    state.kind === "ready" ||
    state.kind === "signing" ||
    state.kind === "submitting"
  ) {
    const busy = state.kind !== "ready";
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            X handle (optional)
          </label>
          <input
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]/50 focus:ring-1 focus:ring-[var(--accent)]/20"
            placeholder="@yourhandle"
            value={twitter}
            onChange={(e) => setTwitter(e.target.value)}
            disabled={busy}
            maxLength={30}
          />
        </div>
        <button className={ctaPrimary} onClick={onSign} disabled={busy}>
          {state.kind === "signing"
            ? "Sign in your wallet…"
            : state.kind === "submitting"
              ? "Submitting…"
              : "Sign to claim your spot"}
        </button>
        <StatusOk>
          Connected:{" "}
          <span className="font-mono font-semibold text-[var(--accent)]">
            {pubkey?.slice(0, 6)}…{pubkey?.slice(-4)}
          </span>
        </StatusOk>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-3">
        <button className={ctaPrimary} onClick={() => setState({ kind: "idle" })}>
          Try again
        </button>
        <StatusErr>{state.reason}</StatusErr>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        className={ctaPrimary}
        onClick={onConnect}
        disabled={state.kind === "connecting"}
      >
        {state.kind === "connecting" ? "Connecting…" : "Connect wallet to claim spot"}
      </button>
      <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        Phantom · Solflare · Backpack · Jupiter — wallet-gated, no email required, no gas to sign.
      </p>
    </div>
  );
}

const ctaPrimary =
  "w-full rounded-md border border-[var(--accent)]/40 bg-gradient-to-b from-[var(--accent)]/20 to-[var(--accent)]/10 px-5 py-3 text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--text)] transition-all hover:border-[var(--accent)]/70 hover:from-[var(--accent)]/25 hover:shadow-[0_8px_24px_-8px_rgba(153,69,255,0.4)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none";

const ctaSecondary =
  "block w-full rounded-md border border-[var(--border)] bg-transparent px-5 py-3 text-center text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]";

function StatusOk({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--cyan)]/20 bg-[var(--cyan)]/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
      {children}
    </div>
  );
}
function StatusErr({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--short)]/25 bg-[var(--short)]/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

// ── Why join ─────────────────────────────────────────────────────────────────

function Why() {
  const items = [
    {
      n: "01",
      t: "First access to mainnet creator markets",
      d: "When public trading opens after the audit, waitlist wallets get priority before broader access.",
    },
    {
      n: "02",
      t: "Eligible for the launch creator-fee rebate",
      d: "First ten markets launched after mainnet opening get 50% creator-fee rebate for 90 days. Your wallet on the waitlist is the reservation.",
    },
    {
      n: "03",
      t: "No spam, no email, no pressure",
      d: "One signed message and you're in. We won't email you, won't auto-follow you. We reach you through the @percolatortrade X handle.",
    },
    {
      n: "04",
      t: "Verifiable on chain",
      d: "Mainnet program ESa89R5E…D4edv is already live in OSS-contributor closed beta. Audit posture is in the deck.",
    },
  ];

  return (
    <Section tag="why join" title="High-intent only. Wallet-gated.">
      <p className={sectionSub}>
        We&apos;re not collecting emails. Signing with your wallet proves you&apos;re a real Solana user, dedupes by pubkey, and lets us reach early adopters cleanly when mainnet opens.
      </p>
      <ul className="mt-2 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        {items.map((it) => (
          <li key={it.n} className="grid grid-cols-[64px_1fr] gap-4 py-4 sm:grid-cols-[80px_1fr]">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--accent)]/70">
              {it.n}
            </span>
            <div>
              <div className="text-[13px] font-medium text-[var(--text)]">{it.t}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">{it.d}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── Architecture cards ───────────────────────────────────────────────────────

function Architecture() {
  const cards = [
    { tag: "tag 37–40", t: "LP vault", d: "Per-market liquidity pool — anyone deposits USDC, becomes a passive maker, earns spread + fee share. Risk isolated per market." },
    { tag: "tag 64–69", t: "NFT positions", d: "Open positions wrap as Token-2022 NFTs with a transfer hook. First transferable perpetual positions on Solana." },
    { tag: "tag 43–44", t: "Dispute resolution", d: "Resolved markets have a challenge window with a bond. Bad settlements get caught before users get drained." },
    { tag: "tag 53", t: "Audit-crank invariants", d: "Anyone cranks an on-chain invariant check. If something doesn't balance, the market auto-pauses before the bug compounds." },
    { tag: "DEX EWMA", t: "Hyperp markets", d: "For tokens without Pyth coverage, the oracle reads a pinned Raydium CLMM pool's EWMA on chain. No external dep." },
    { tag: "Kani · 422", t: "Formally verified", d: "422 Kani proofs cover the H + A/K risk engine — haircut conservation, ADL fairness, funding zero-sum." },
  ];

  return (
    <Section tag="what you're joining" title="Not an order book. Not a traditional AMM.">
      <p className={sectionSub}>
        Trades execute against an on-chain LP vault using oracle-derived pricing. Two matcher modes per market — passive LP (oracle ± spread) or vAMM (virtual constant-impact curve). Same engine, different pricing knob, picked at launch.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <div key={c.t} className={`${cardClass} p-4 space-y-2`}>
            <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--accent)]/70">
              {c.tag}
            </div>
            <div className="text-[13.5px] font-semibold text-[var(--text)]">{c.t}</div>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{c.d}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Origin ───────────────────────────────────────────────────────────────────

function Origin() {
  return (
    <Section tag="origin" title="From Anatoly's research to a live product.">
      <p className={sectionSub}>
        Solana co-founder Anatoly Yakovenko authored the H + A/K risk engine and a reference program. We took it from research to a production system on Solana mainnet — building the on-chain product layer (LP vault, dispute resolution, transferable NFT positions, withdrawal queue, audit-crank invariants, admin lifecycle tooling) plus the SDK, indexer, keeper fleet, and frontend. Both co-founders have each won one of his public bounties.
      </p>
      <div className={`${cardClass} mt-2 p-5`}>
        <div className="font-mono text-[11px] text-[var(--accent)]/80">
          github.com/aeyakovenko/percolator-prog → github.com/dcccrypto
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--border)] pt-4">
          <Stat n="49" label="Fork-only handlers" />
          <Stat n="51" label="Fork-only instructions" />
          <Stat n="134" label="Wrapper commits past reference" />
        </div>
      </div>
    </Section>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div className="font-mono text-2xl font-bold text-[var(--text)]">{n}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

// ── FAQ ──────────────────────────────────────────────────────────────────────

function FAQ() {
  const items = [
    {
      q: "When does mainnet open for public trading?",
      a: "After the external audit clears. We're targeting Q3 2026. The mainnet program is already deployed and running in lab mode with the first SOL/USDC Hyperp market — restricted to OSS contributors until audit clears.",
    },
    {
      q: "Why a waitlist instead of letting me trade now?",
      a: "Pre-audit, public trading puts user funds at risk. We won't do that. The waitlist is how we line up early adopters and creators so they get priority access the moment audit clears.",
    },
    {
      q: "Why connect a wallet — why not just take my email?",
      a: "Wallet signatures dedupe by pubkey, prove you're a real Solana user, and let us scope future creator-fee rebates and access tiers cleanly to specific wallets. No email = no spam list to leak. We don't collect emails at all.",
    },
    {
      q: "What does signing do? Does it cost gas?",
      a: "No gas. Signing produces an offline ed25519 signature over a short message proving you control the wallet. We never send a transaction, never request token approvals, never see your private key. Server-side we verify the signature with tweetnacl before adding you to the list.",
    },
    {
      q: "How is this different from Hyperliquid or Drift?",
      a: "Hyperliquid HIP-1 is permissionless but auction-gated (historically up to $19M+ per market, on its own L1). Drift is curated and Solana-native. Percolator is permissionless and Solana-native — anyone can launch a market on any SPL token in 60 seconds. Long-tail tokens get perp access for the first time.",
    },
    {
      q: "Is the code open source?",
      a: "Apache 2.0 across 17 public repos at github.com/dcccrypto. The wrapper, engine, matcher, NFT contract, SDK, indexer, keeper, and frontend are all public. Fork it tomorrow.",
    },
    {
      q: "Will my LP get drained if I deposit liquidity?",
      a: "Pre-audit, no LP deposits. Mainnet is in lab mode with first-party capital only. After audit, LP risk is per-market — each LP vault is isolated, and the insurance reserve sits between user PnL and LP equity.",
    },
    {
      q: "Can I unsubscribe?",
      a: "We don't have an email list to unsubscribe from. If you want your wallet removed from the waitlist, DM @percolatortrade on X with the same wallet that signed up.",
    },
  ];

  return (
    <Section tag="faq" title="What you're probably wondering.">
      <div className="mt-2">
        {items.map((item, i) => (
          <details
            key={i}
            className="group border-b border-[var(--border)] py-4 last:border-b-0 [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer items-start justify-between gap-4 text-[13.5px] font-medium text-[var(--text)] transition-colors hover:text-[var(--accent)]">
              <span>{item.q}</span>
              <span className="mt-1 shrink-0 font-mono text-[14px] leading-none text-[var(--accent)]/70 transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </Section>
  );
}

// ── Counter footer ───────────────────────────────────────────────────────────

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
    <ScrollReveal>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-6 text-[12px] text-[var(--text-muted)]">
        <span className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cyan)]" />
          <span className="font-mono text-[14px] font-semibold text-[var(--text)]">
            {count === null ? "—" : animated.toLocaleString()}
          </span>
          <span className="uppercase tracking-[0.08em]">on the waitlist</span>
        </span>
        <span className="font-mono text-[11px]">
          <a
            href="https://x.com/percolatortrade"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
          >
            @percolatortrade
          </a>
          <span className="mx-2 text-[var(--border-hover)]">·</span>
          <a
            href="mailto:dark@percolator.trade"
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
          >
            dark@percolator.trade
          </a>
        </span>
      </div>
    </ScrollReveal>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
