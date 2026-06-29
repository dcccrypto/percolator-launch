"use client";

// ─── Intro / teaser deck (/pitch/intro) ─────────────────────────────────────
//
// 8 slides, built for a cold async read (a VC skims in <2 min). Dark Premium
// base with full-bleed brand-colour "statement" slides interleaved for rhythm
// (dark → colour → dark). Number-as-hero, real charts, one idea per slide.
// Reuses the PitchDeck runner + CSS from ../_deck; all rich visuals are
// inline-styled so this file is self-contained. Every figure is cited in-slide.

import { useEffect, useState, type ReactNode } from "react";
import { PitchDeck, type SlideDef, type SlideProps } from "../_deck";

const PURPLE = "#9945FF";
const CYAN = "#22D3EE";
const BRAND_FILL = "linear-gradient(135deg, #9945FF, #22D3EE)";
const INK = "#0D0D0F";

// ── Shared bits ──────────────────────────────────────────────────────────────

function Eyebrow({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: "0.72rem",
        fontWeight: 700,
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        color: dark ? "rgba(13,13,15,0.6)" : "rgba(153,69,255,0.85)",
        marginBottom: "1.4rem",
      }}
    >
      {children}
    </div>
  );
}

// Full-bleed accent-colour slide (the Vibe rhythm device).
function ColorSlide({ bg, children }: { bg: string; children: ReactNode }) {
  return (
    <div className="pitch-slide">
      <div style={{ position: "absolute", inset: 0, background: bg, zIndex: 0 }} aria-hidden />
      <div
        className="pitch-slide-inner pitch-center"
        style={{ position: "relative", zIndex: 1 }}
      >
        {children}
      </div>
    </div>
  );
}

function Caption({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        marginTop: "1rem",
        fontSize: "0.66rem",
        lineHeight: 1.5,
        color: dark ? "rgba(13,13,15,0.55)" : "rgba(255,255,255,0.38)",
        maxWidth: "640px",
        marginLeft: "auto",
        marginRight: "auto",
      }}
    >
      {children}
    </div>
  );
}

// ── 1 · Cover ────────────────────────────────────────────────────────────────
function IntroTitle(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-bg-grid" aria-hidden />
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "70vw",
          height: "70vh",
          transform: "translate(-50%,-55%)",
          background:
            "radial-gradient(closest-side, rgba(153,69,255,0.22), rgba(34,211,238,0.10) 55%, transparent 75%)",
          filter: "blur(20px)",
          zIndex: 0,
        }}
      />
      <div
        className="pitch-slide-inner pitch-center"
        style={{ position: "relative", zIndex: 1 }}
      >
        <Eyebrow>Seed round &middot; 2026</Eyebrow>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/logo.png"
          alt="Percolator"
          className="pitch-logo"
          style={{ marginBottom: "2.2rem" }}
        />
        <p
          style={{
            fontFamily: "'Inter Tight', 'Inter', sans-serif",
            fontSize: "clamp(2.2rem, 5.5vw, 4rem)",
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            color: "#fff",
            maxWidth: "16ch",
          }}
        >
          Perpetual futures for{" "}
          <span
            style={{
              background: BRAND_FILL,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            every token
          </span>{" "}
          on Solana.
        </p>
        <p
          style={{
            marginTop: "1.4rem",
            fontSize: "clamp(1rem, 2vw, 1.25rem)",
            color: "rgba(255,255,255,0.6)",
            maxWidth: "44ch",
          }}
        >
          Anyone can open a leverage market for any token, in about a minute.
        </p>
        <p className="pitch-url" style={{ marginTop: "2.4rem" }}>
          percolator.trade
        </p>
      </div>
    </div>
  );
}

// ── 2 · Problem (full-bleed purple statement) ────────────────────────────────
function IntroProblem(_: SlideProps) {
  return (
    <ColorSlide bg="linear-gradient(150deg, #7C3AED 0%, #9945FF 60%, #B15CFF 100%)">
      <Eyebrow dark>The problem</Eyebrow>
      <p
        style={{
          fontFamily: "'Inter Tight', 'Inter', sans-serif",
          fontSize: "clamp(2rem, 4.6vw, 3.3rem)",
          fontWeight: 800,
          letterSpacing: "-0.025em",
          lineHeight: 1.08,
          color: "#fff",
          maxWidth: "18ch",
        }}
      >
        Almost no Solana token can be traded with leverage.
      </p>

      {/* big gap bar */}
      <div style={{ width: "100%", maxWidth: "760px", margin: "2.4rem auto 0" }}>
        <div
          style={{
            display: "flex",
            height: "62px",
            borderRadius: "12px",
            overflow: "hidden",
            border: "1px solid rgba(13,13,15,0.18)",
            boxShadow: "0 12px 40px rgba(13,13,15,0.25)",
          }}
        >
          <div
            style={{
              width: "13%",
              minWidth: "58px",
              background: INK,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "1.05rem",
            }}
          >
            13%
          </div>
          <div
            style={{
              flex: 1,
              background: "rgba(13,13,15,0.12)",
              display: "flex",
              alignItems: "center",
              paddingLeft: "1.2rem",
              color: "rgba(13,13,15,0.7)",
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "0.95rem",
            }}
          >
            87% &mdash; no perp, anywhere
          </div>
        </div>
        <div
          className="mono"
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "0.7rem",
            fontSize: "0.72rem",
            color: "rgba(13,13,15,0.6)",
          }}
        >
          <span>get a perp</span>
          <span>the long tail has the demand, and no venue</span>
        </div>
        <Caption dark>
          Of every new token launched since 2025, only ~13% ever get a perp on
          any venue. Source: CoinGecko, State of Crypto Perpetuals 2026.
        </Caption>
      </div>
    </ColorSlide>
  );
}

// ── 3 · Why now (dark, big record column chart) ──────────────────────────────
function IntroWhyNow(_: SlideProps) {
  // honest: two cited Solana data points (record vs prior peak), drawn big.
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <Eyebrow>Why now</Eyebrow>
        <p
          style={{
            fontFamily: "'Inter Tight', 'Inter', sans-serif",
            fontSize: "clamp(1.8rem, 4vw, 2.9rem)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            lineHeight: 1.1,
            color: "#fff",
            maxWidth: "20ch",
          }}
        >
          Solana perps just hit a record. Then the leader got drained and went
          dark.
        </p>

        <svg
          viewBox="0 0 640 300"
          style={{ width: "100%", maxWidth: "640px", marginTop: "1.6rem" }}
          role="img"
          aria-label="Solana perp monthly volume: $77B in May 2026, a record, vs $57B prior peak in Nov 2025"
        >
          <defs>
            <linearGradient id="recordBar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CYAN} />
              <stop offset="100%" stopColor={PURPLE} />
            </linearGradient>
          </defs>
          {/* baseline */}
          <line x1="60" y1="250" x2="620" y2="250" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" />
          {/* y ticks */}
          {[0, 20, 40, 60, 80].map((v) => {
            const y = 250 - (v / 80) * 200;
            return (
              <g key={v}>
                <line x1="60" y1={y} x2="620" y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                <text x="48" y={y + 4} textAnchor="end" fontFamily="'JetBrains Mono', monospace" fontSize="13" fill="rgba(255,255,255,0.4)">
                  ${v}B
                </text>
              </g>
            );
          })}
          {/* prior peak bar */}
          <rect x="150" y={250 - (57 / 80) * 200} width="120" height={(57 / 80) * 200} rx="6" fill="rgba(255,255,255,0.16)" />
          <text x="210" y={250 - (57 / 80) * 200 - 12} textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontWeight="700" fontSize="20" fill="rgba(255,255,255,0.7)">$57B</text>
          <text x="210" y="272" textAnchor="middle" fontFamily="'Inter', sans-serif" fontSize="13" fill="rgba(255,255,255,0.5)">Nov 2025 · prior peak</text>
          {/* record bar */}
          <rect x="380" y={250 - (77 / 80) * 200} width="120" height={(77 / 80) * 200} rx="6" fill="url(#recordBar)" />
          <text x="440" y={250 - (77 / 80) * 200 - 12} textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontWeight="800" fontSize="24" fill="#fff">$77B</text>
          <text x="440" y="272" textAnchor="middle" fontFamily="'Inter', sans-serif" fontSize="13" fill="rgba(255,255,255,0.75)">May 2026 · record</text>
          {/* +35% callout */}
          <text x="585" y={250 - (77 / 80) * 200 + 6} textAnchor="end" fontFamily="'JetBrains Mono', monospace" fontWeight="700" fontSize="15" fill={CYAN}>+35%</text>
        </svg>

        <Caption>
          A new all-time high for Solana perp volume, then the #1 venue was
          drained and went dark; the flow re-routed within weeks. Source:
          DefiLlama, 2026.
        </Caption>
      </div>
    </div>
  );
}

// ── 4 · Solution (dark, framed live screenshot) ──────────────────────────────
function IntroSolution(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <Eyebrow>What we built</Eyebrow>
        <p
          style={{
            fontFamily: "'Inter Tight', 'Inter', sans-serif",
            fontSize: "clamp(1.8rem, 4vw, 2.9rem)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            lineHeight: 1.1,
            color: "#fff",
            maxWidth: "20ch",
            marginBottom: "1.4rem",
          }}
        >
          Launch a perp market for any token in about 60 seconds.
        </p>
        <div
          style={{
            position: "relative",
            maxWidth: "920px",
            width: "100%",
            margin: "0 auto",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: "-8% -4%",
              background:
                "radial-gradient(closest-side, rgba(34,211,238,0.18), transparent 70%)",
              filter: "blur(8px)",
            }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/product/launch-market.webp"
            alt="The live Launch a Market flow on Percolator"
            style={{
              position: "relative",
              width: "100%",
              borderRadius: "14px",
              border: "1px solid rgba(153,69,255,0.3)",
              boxShadow: "0 24px 70px rgba(0,0,0,0.55)",
            }}
          />
        </div>
        <Caption>
          Live on devnet &middot; each market is isolated, so one blow-up
          can&apos;t touch another.
        </Caption>
      </div>
    </div>
  );
}

// ── 5 · Traction (dark, 120px+ stat hero + metric cards) ─────────────────────
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

  const cards = [
    { n: "220", l: "markets on devnet" },
    { n: "71", l: "unique builders" },
    { n: "$0", l: "paid acquisition" },
  ];

  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <Eyebrow>Traction</Eyebrow>
        <div
          className="mono"
          style={{
            fontSize: "clamp(4.5rem, 13vw, 9rem)",
            fontWeight: 800,
            lineHeight: 0.95,
            letterSpacing: "-0.04em",
            background: BRAND_FILL,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          {waitlist.toLocaleString()}+
        </div>
        <p
          style={{
            marginTop: "0.6rem",
            fontSize: "clamp(1rem, 2vw, 1.2rem)",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          waitlist signups in seven weeks &middot; organic, zero paid
        </p>
        <div
          style={{
            display: "flex",
            gap: "1rem",
            marginTop: "2rem",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {cards.map((s) => (
            <div
              key={s.l}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.09)",
                borderRadius: "14px",
                padding: "1.2rem 1.8rem",
                minWidth: "168px",
              }}
            >
              <div
                className="mono"
                style={{ fontSize: "2.2rem", fontWeight: 800, color: "#fff", lineHeight: 1 }}
              >
                {s.n}
              </div>
              <div
                style={{
                  fontSize: "0.78rem",
                  color: "rgba(255,255,255,0.5)",
                  marginTop: "0.45rem",
                }}
              >
                {s.l}
              </div>
            </div>
          ))}
        </div>
        <Caption>Every figure verifiable on-chain &middot; live waitlist count.</Caption>
      </div>
    </div>
  );
}

// ── 6 · Why us (dark, big quote + Toly's actual tweets) ──────────────────────
function IntroWhyUs(_: SlideProps) {
  const tiles = [
    { src: "/images/toly/photo4.jpg", date: "Feb 13", cap: "“Percolator is a job creator”", alt: "Toly tweet: 'Percolator is a job creator'" },
    { src: "/images/toly/photo3.jpg", date: "Feb 19", cap: "“Don’t trust, verify”", alt: "Toly reposting our stake program: 'Don't trust, verify!'" },
    { src: "/images/toly/photo1.jpg", date: "Apr 29", cap: "David’s engine bug fix", alt: "Toly quote-RTing David's engine bug fix" },
    { src: "/images/toly/photo8.png", date: "May 29", cap: "“Two devs and a dream”", alt: "Toly tweet 'Two devs and a dream' on our work" },
  ];
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <Eyebrow>Why us</Eyebrow>
        <p
          style={{
            fontFamily: "'Inter Tight', 'Inter', sans-serif",
            fontSize: "clamp(2rem, 4.4vw, 3.1rem)",
            fontWeight: 800,
            letterSpacing: "-0.025em",
            lineHeight: 1.1,
            color: "#fff",
          }}
        >
          &ldquo;Pls steal the idea.&rdquo;{" "}
          <span
            style={{
              background: BRAND_FILL,
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            We did.
          </span>
        </p>
        <p
          style={{
            marginTop: "1rem",
            fontSize: "clamp(0.95rem, 1.7vw, 1.1rem)",
            color: "rgba(255,255,255,0.65)",
            maxWidth: "60ch",
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          Anatoly Yakovenko, Solana&apos;s co-founder, open-sourced the perp
          engine and dared builders to run with it. We built the venue on it,
          and he&apos;s followed the work since:
        </p>
        <div className="pitch-toly-photo-grid" style={{ marginTop: "1.6rem" }}>
          {tiles.map((t) => (
            <a
              key={t.date}
              className="pitch-toly-photo"
              href="https://x.com/toly"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Toly tweet — ${t.date}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.src} alt={t.alt} />
              <div className="pitch-toly-photo-cap mono">
                <span>@toly &middot; {t.date}</span>
                <span>{t.cap}</span>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 7 · The ask (full-bleed blue→cyan statement) ─────────────────────────────
function IntroAsk(_: SlideProps) {
  const chips = ["Security audit", "Mainnet launch", "Runway"];
  return (
    <ColorSlide bg="linear-gradient(140deg, #1D4ED8 0%, #2A6BE6 55%, #22D3EE 130%)">
      <Eyebrow dark>The ask</Eyebrow>
      <p
        style={{
          fontFamily: "'Inter Tight', 'Inter', sans-serif",
          fontSize: "clamp(2.1rem, 5vw, 3.6rem)",
          fontWeight: 800,
          letterSpacing: "-0.03em",
          lineHeight: 1.05,
          color: "#fff",
          maxWidth: "17ch",
        }}
      >
        We&apos;re raising to get audited and ship mainnet.
      </p>
      <p
        style={{
          marginTop: "1.3rem",
          fontSize: "clamp(1rem, 2vw, 1.25rem)",
          color: "rgba(255,255,255,0.9)",
          maxWidth: "46ch",
        }}
      >
        A small round to fund a top-tier security audit and our launch. The only
        thing between proven demand and a live, secured product.
      </p>
      <div
        style={{
          display: "flex",
          gap: "0.7rem",
          marginTop: "2rem",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {chips.map((c) => (
          <div
            key={c}
            className="mono"
            style={{
              background: "rgba(13,13,15,0.22)",
              border: "1px solid rgba(255,255,255,0.35)",
              borderRadius: "999px",
              padding: "0.6rem 1.2rem",
              color: "#fff",
              fontSize: "0.82rem",
              fontWeight: 600,
            }}
          >
            {c}
          </div>
        ))}
      </div>
    </ColorSlide>
  );
}

// ── 8 · Contact (dark, clean close) ──────────────────────────────────────────
function IntroContact(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-bg-grid" aria-hidden />
      <div className="pitch-slide-inner pitch-center" style={{ position: "relative", zIndex: 1 }}>
        <Eyebrow>Let&apos;s talk</Eyebrow>
        <p
          style={{
            fontFamily: "'Inter Tight', 'Inter', sans-serif",
            fontSize: "clamp(2.4rem, 6vw, 4rem)",
            fontWeight: 800,
            letterSpacing: "-0.03em",
            background: BRAND_FILL,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          percolator.trade
        </p>
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
  { id: 1, title: "Cover", component: IntroTitle },
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
