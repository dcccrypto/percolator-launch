"use client";

// ─── Intro / teaser deck (/pitch/intro) ─────────────────────────────────────
//
// 8 slides, minimal words, built for a cold async read (a VC skims in <2 min,
// decides in the first 3 slides). One bold statement per slide, one support
// line max. Separate, leaner artifact from the full /pitch deck — it exists to
// earn the meeting, not close the round. Reuses the PitchDeck runner + CSS from
// ../_deck so it stays on-brand. The full deck lives at /pitch.

import { useEffect, useState } from "react";
import { PitchDeck, type SlideDef, type SlideProps } from "../_deck";

// ── Inline data-as-hero charts (dependency-free, on-brand) ───────────────────
// Every number below is cited in the caption; do not change a value without
// updating the source. Brand fill = purple→cyan gradient; rest = faint white.

const BRAND_FILL = "linear-gradient(135deg, #9945FF, #22D3EE)";

// A single bar split into a small "has it" portion and a large "doesn't"
// portion — the long-tail perp gap.
function GapBar() {
  return (
    <div style={{ width: "100%", maxWidth: "720px", margin: "1.75rem auto 0" }}>
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "0.55rem",
          fontSize: "0.72rem",
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ color: "#22D3EE", fontWeight: 700 }}>~13% get a perp</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>
          ~87% have none, anywhere
        </span>
      </div>
      <div
        style={{
          display: "flex",
          height: "30px",
          borderRadius: "8px",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <div style={{ width: "13%", background: BRAND_FILL }} />
        <div style={{ width: "87%", background: "rgba(255,255,255,0.06)" }} />
      </div>
      <div
        className="mono"
        style={{
          marginTop: "0.7rem",
          fontSize: "0.66rem",
          color: "rgba(255,255,255,0.4)",
          lineHeight: 1.5,
        }}
      >
        Of every new token launched since 2025, only ~13% ever get a perp on any
        venue. Source: CoinGecko, State of Crypto Perpetuals 2026.
      </div>
    </div>
  );
}

// Two proportional bars: Solana perps record vs prior peak (momentum).
function ScaleBars() {
  const rows = [
    { label: "May 2026 — new record", value: 77, display: "$77B" },
    { label: "Nov 2025 — prior peak", value: 57, display: "$57B" },
  ];
  const max = 77;
  return (
    <div
      style={{
        width: "100%",
        maxWidth: "720px",
        margin: "1.75rem auto 0",
        display: "flex",
        flexDirection: "column",
        gap: "0.9rem",
      }}
    >
      {rows.map((r, i) => (
        <div key={r.label}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.8rem",
              marginBottom: "0.35rem",
              color: "rgba(255,255,255,0.7)",
            }}
          >
            <span>{r.label}</span>
            <span className="mono">{r.display} / mo</span>
          </div>
          <div
            style={{
              height: "22px",
              borderRadius: "6px",
              background: "rgba(255,255,255,0.05)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(r.value / max) * 100}%`,
                height: "100%",
                borderRadius: "6px",
                background: i === 0 ? BRAND_FILL : "rgba(255,255,255,0.18)",
              }}
            />
          </div>
        </div>
      ))}
      <div
        className="mono"
        style={{
          fontSize: "0.66rem",
          color: "rgba(255,255,255,0.4)",
          lineHeight: 1.5,
        }}
      >
        Solana perps just set an all-time high, +35% over the prior peak. Then
        the #1 venue was drained and went dark; the volume re-routed within
        weeks. Source: DefiLlama, 2026.
      </div>
    </div>
  );
}

// ── 1 · One-liner ────────────────────────────────────────────────────────────
function IntroTitle(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/logo.png" alt="Percolator" className="pitch-logo" />
        <p className="pitch-hero-headline">
          Perpetual futures for every token on Solana.
        </p>
        <p className="pitch-hero-body">
          Anyone can open a leverage market for any token, in about a minute.
        </p>
        <p className="pitch-url">percolator.trade</p>
      </div>
      <div className="pitch-bg-grid" aria-hidden />
    </div>
  );
}

// ── 2 · Problem ──────────────────────────────────────────────────────────────
function IntroProblem(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">The problem</div>
        <p className="pitch-hero-headline">
          Almost no Solana token can be traded with leverage.
        </p>
        <p className="pitch-hero-body">
          Hundreds of thousands of tokens trade on Solana. Barely a hundred
          have a perp market, all curated down to the same majors.
        </p>
        <GapBar />
      </div>
    </div>
  );
}

// ── 3 · Why now ──────────────────────────────────────────────────────────────
function IntroWhyNow(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">Why now</div>
        <p className="pitch-hero-headline">
          Solana perps just hit a record. Then the leader got drained and went
          dark.
        </p>
        <p className="pitch-hero-body">
          The demand is proven and it moves fast. The long tail still has
          nowhere to go.
        </p>
        <ScaleBars />
      </div>
    </div>
  );
}

// ── 4 · Solution (with live product screenshot as proof) ─────────────────────
function IntroSolution(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">What we built</div>
        <p className="pitch-hero-headline">
          Launch a perp market for any token in about 60 seconds.
        </p>
        <div
          className="pflow-shot-wrap"
          style={{ maxWidth: "960px", width: "100%", marginTop: "1rem" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/product/launch-market.webp"
            alt="The live Launch a Market flow: deploy a perp market for any token in about 60 seconds"
            className="pflow-shot"
          />
          <div className="pflow-shot-cap mono">
            Live on devnet &middot; each market isolated, so one blow-up
            can&apos;t touch another
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 5 · Traction (hero number, live waitlist) ────────────────────────────────
function IntroTraction(_: SlideProps) {
  const [waitlist, setWaitlist] = useState(8000);
  useEffect(() => {
    fetch("/api/waitlist/count")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.count === "number" && d.count >= 1000) {
          setWaitlist(Math.floor(d.count / 100) * 100);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">Traction</div>
        <div
          className="mono"
          style={{
            fontSize: "clamp(3.5rem, 9vw, 6rem)",
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            background: "linear-gradient(135deg, #9945FF, #22D3EE)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          {waitlist.toLocaleString()}+
        </div>
        <p className="pitch-hero-body" style={{ marginTop: "0.6rem" }}>
          waitlist signups in seven weeks. Organic, zero paid.
        </p>
        <div
          style={{
            display: "flex",
            gap: "0.85rem",
            marginTop: "1.75rem",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {[
            { n: "220", l: "markets on devnet" },
            { n: "71", l: "unique builders" },
            { n: "$0", l: "paid acquisition" },
          ].map((s) => (
            <div
              key={s.l}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "12px",
                padding: "0.9rem 1.4rem",
                minWidth: "150px",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: "1.7rem",
                  fontWeight: 700,
                  color: "#fff",
                  lineHeight: 1,
                }}
              >
                {s.n}
              </div>
              <div
                style={{
                  fontSize: "0.72rem",
                  color: "rgba(255,255,255,0.5)",
                  marginTop: "0.35rem",
                }}
              >
                {s.l}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 6 · Why us (Toly's own words + his actual tweets as proof) ────────────────
function IntroWhyUs(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">Why us</div>
        <p className="pitch-title" style={{ marginBottom: "0.6rem" }}>
          &ldquo;Pls steal the idea.&rdquo; We did.
        </p>
        <p
          className="pitch-hero-body"
          style={{ marginBottom: "1.5rem" }}
        >
          Anatoly Yakovenko, Solana&apos;s co-founder, open-sourced the perp
          engine and dared builders to run with it. We built the venue on it,
          and he&apos;s followed the work since:
        </p>
        <div className="pitch-toly-photo-grid">
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — Percolator is a job creator, Feb 13"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo4.jpg"
              alt="Toly tweet: 'Percolator is a job creator'"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly &middot; Feb 13</span>
              <span>&ldquo;Percolator is a job creator&rdquo;</span>
            </div>
          </a>
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — Don't trust, verify, Feb 19"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo3.jpg"
              alt="Toly tweet reposting our stake program: 'Don't trust, verify!'"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly &middot; Feb 19</span>
              <span>&ldquo;Don&apos;t trust, verify&rdquo;</span>
            </div>
          </a>
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — David's KeeperCrank fix, Apr 29"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo1.jpg"
              alt="Toly tweet quote-RTing David's engine bug fix"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly &middot; Apr 29</span>
              <span>David&apos;s engine bug fix</span>
            </div>
          </a>
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — Two devs and a dream, May 29"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo8.png"
              alt="Toly tweet 'Two devs and a dream' on our work"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly &middot; May 29</span>
              <span>&ldquo;Two devs and a dream&rdquo;</span>
            </div>
          </a>
        </div>
      </div>
    </div>
  );
}

// ── 7 · The ask ──────────────────────────────────────────────────────────────
function IntroAsk(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">The ask</div>
        <p className="pitch-hero-headline">
          We&apos;re raising to get audited and ship mainnet.
        </p>
        <p className="pitch-hero-body">
          A small round to fund a top-tier security audit and our launch. The
          only thing between proven demand and a live, secured product.
        </p>
      </div>
    </div>
  );
}

// ── 8 · Contact ──────────────────────────────────────────────────────────────
function IntroContact(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">Let&apos;s talk</div>
        <p className="pitch-hero-headline">percolator.trade</p>
        <div className="pitch-divider" />
        <div className="pitch-contact-grid">
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">X</div>
            <div className="pitch-contact-value">@percolatortrade</div>
          </div>
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Email</div>
            <div className="pitch-contact-value">contact@percolator.trade</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const SLIDES: SlideDef[] = [
  { id: 1, title: "One-Liner", component: IntroTitle },
  { id: 2, title: "Problem", component: IntroProblem },
  { id: 3, title: "Why Now", component: IntroWhyNow },
  { id: 4, title: "Solution", component: IntroSolution },
  { id: 5, title: "Traction", component: IntroTraction },
  { id: 6, title: "Why Us", component: IntroWhyUs },
  { id: 7, title: "The Ask", component: IntroAsk },
  { id: 8, title: "Contact", component: IntroContact },
];

export default function PitchIntroPage() {
  return <PitchDeck slides={SLIDES} />;
}
