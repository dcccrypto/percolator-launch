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
          Every perp venue shares one pool of capital, so they all curate down
          to the same ~40 large caps. The long tail has the demand and no venue.
        </p>
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
          Solana perps are at a record. The market leader just went dark.
        </p>
        <p className="pitch-hero-body">
          $77B traded in May, an all-time high. The #1 venue was drained and
          shut down. Only ~13% of new tokens ever get a perp anywhere.
        </p>
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
          style={{ maxWidth: "820px", marginTop: "1.25rem" }}
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
        <p
          className="pitch-hero-body"
          style={{ marginTop: "0.75rem" }}
        >
          waitlist signups in 7 weeks. Organic, zero paid. Plus 220 markets
          created on devnet by 71 builders, all verifiable on-chain.
        </p>
      </div>
    </div>
  );
}

// ── 6 · Why us ───────────────────────────────────────────────────────────────
function IntroWhyUs(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">Why us</div>
        <p className="pitch-hero-headline">
          We took the Solana co-founder&apos;s open challenge and shipped it.
        </p>
        <p className="pitch-hero-body">
          Anatoly Yakovenko open-sourced the risk engine and said &ldquo;steal
          the idea.&rdquo; We built the venue on it, and he&apos;s engaged with
          our work publicly.
        </p>
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
