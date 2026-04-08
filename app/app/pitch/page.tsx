"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Slide Data ──────────────────────────────────────────────────────────────

const TOTAL_SLIDES = 7;

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlideProps {
  isCurrent: boolean;
}

// ─── Individual Slides ───────────────────────────────────────────────────────

function Slide01Cover({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/logo.png" alt="Percolator" className="pitch-logo" />
        <p className="pitch-hero-sub">
          Perpetual futures for every token on Solana.
        </p>
        <div className="pitch-divider" />
        <p className="pitch-url">percolatorlaunch.com</p>
      </div>
      <div className="pitch-bg-grid" aria-hidden />
    </div>
  );
}

function Slide02Insight({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Insight</div>
        <h2 className="pitch-title">
          There are 15 million tokens on Solana.<br />
          Fewer than 50 have perp markets.
        </h2>
        <div className="pitch-insight-body">
          <p className="pitch-body-text">
            Every major exchange — Hyperliquid, Jupiter, Drift — gatekeeps which tokens
            get perpetual futures. You need approval, a Pyth oracle listing, or $25M
            for an auction slot.
          </p>
          <p className="pitch-body-text" style={{ marginTop: '1.25rem' }}>
            That means 99.9997% of tokens can never have leveraged markets.
            Not because of a technical limitation — because of a design choice.
          </p>
          <div className="pitch-callout">
            We chose differently.
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide03Problem({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Problem</div>
        <h2 className="pitch-title">Perp markets are gated by three bottlenecks</h2>
        <div className="pitch-problem-grid">
          <div className="pitch-problem-card">
            <div className="pitch-problem-stat">$25M</div>
            <p>To list on Hyperliquid via auction. Jupiter and Drift require team approval.</p>
          </div>
          <div className="pitch-problem-card">
            <div className="pitch-problem-stat">Oracle</div>
            <p>No Pyth feed means no market. New tokens are locked out from day one.</p>
          </div>
          <div className="pitch-problem-card">
            <div className="pitch-problem-stat">ADL</div>
            <p>When markets crash, auto-deleveraging picks winners and losers arbitrarily. No one has fixed this.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide04Solution({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">How We Solve It</div>
        <h2 className="pitch-title">Three breakthroughs. Fully on-chain.</h2>
        <div className="pitch-solution-stack">
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">1</div>
            <div>
              <div className="pitch-solution-name">On-chain oracle from DEX pools</div>
              <p className="pitch-solution-desc">
                We read price directly from Raydium and Meteora pool state. If a token trades on a DEX, it gets an oracle. No Pyth. No external dependency. &lt;0.05% deviation on BTC, SOL, ETH.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">2</div>
            <div>
              <div className="pitch-solution-name">Mathematically fair liquidation</div>
              <p className="pitch-solution-desc">
                Built on Anatoly Yakovenko&apos;s H + A/K risk engine. Proportional haircuts replace ADL — everyone gets the same deal. O(1) per account, no queue, no first-mover advantage.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">3</div>
            <div>
              <div className="pitch-solution-name">Permissionless market creation</div>
              <p className="pitch-solution-desc">
                Deposit $500 USDC, set a fee rate, your market is live. No application. No approval. You earn fees on every trade.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide05Proof({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Proof</div>
        <h2 className="pitch-title">Live on devnet. Verified. Growing organically.</h2>
        <div className="pitch-proof-row">
          <div className="pitch-proof-block">
            <div className="pitch-traction-grid">
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">168</div>
                <div className="pitch-traction-label">Markets created on devnet</div>
              </div>
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">2,700+</div>
                <div className="pitch-traction-label">Organic X followers</div>
              </div>
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">516</div>
                <div className="pitch-traction-label">Formal proofs verified (Kani)</div>
              </div>
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">0</div>
                <div className="pitch-traction-label">Critical or high findings</div>
              </div>
            </div>
          </div>
          <div className="pitch-proof-extras">
            <div className="pitch-milestone">
              <div className="pitch-milestone-dot cyan" />
              <span>Position NFTs — transferable perp positions, first on Solana</span>
            </div>
            <div className="pitch-milestone">
              <div className="pitch-milestone-dot cyan" />
              <span>Apache 2.0 — fully open source, 8 public repos</span>
            </div>
            <div className="pitch-milestone">
              <div className="pitch-milestone-dot purple" />
              <span>Built on Toly&apos;s risk engine — production-grade implementation of his research</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide06Market({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Market</div>
        <h2 className="pitch-title">We don't compete for blue-chip volume. We create new markets.</h2>
        <div className="pitch-market-layout">
          <div className="pitch-market-stat-block">
            <div className="pitch-market-big-num mono">$2–4B</div>
            <div className="pitch-market-big-label">Monthly Solana perp volume today</div>
            <div className="pitch-market-sub">~50 tokens. All blue chips.</div>
          </div>
          <div className="pitch-market-divider" />
          <div className="pitch-market-opportunity">
            <div className="pitch-market-opp-num mono">15M+</div>
            <div className="pitch-market-opp-label">Tokens with zero perp access</div>
            <p className="pitch-market-opp-desc">
              Every token launched on pump.fun, every memecoin, every new project — they&apos;re all potential markets on Percolator. We&apos;re not taking a slice of the existing pie. We&apos;re building a new one.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide07WhyUs({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Why Us. Why Now.</div>
        <h2 className="pitch-title">We&apos;re building this regardless.</h2>
        <div className="pitch-why-layout">
          <div className="pitch-why-block">
            <p className="pitch-body-text">
              Toly designed the risk engine. We&apos;re building the product. Percolator
              is the production-grade implementation of Anatoly Yakovenko&apos;s permissionless
              perp protocol — extended with an on-chain oracle, formal verification,
              and a full trading interface.
            </p>
            <p className="pitch-body-text" style={{ marginTop: '1.25rem' }}>
              We&apos;ve been shipping every single day — 516 proofs verified, 168 markets
              created on devnet, all organic. No paid marketing. No incentive programs.
              This is what we want to build for the next decade.
            </p>
          </div>
          <div className="pitch-why-signals">
            <div className="pitch-signal">
              <div className="pitch-signal-label">Foundation</div>
              <div className="pitch-signal-value">Built on Toly&apos;s protocol — the Solana co-founder designed the core risk engine</div>
            </div>
            <div className="pitch-signal">
              <div className="pitch-signal-label">Community</div>
              <div className="pitch-signal-value">2,700+ organic followers, active Telegram with early testers</div>
            </div>
            <div className="pitch-signal">
              <div className="pitch-signal-label">Open Source</div>
              <div className="pitch-signal-value">8 public repos, Apache 2.0 — anyone can verify our work</div>
            </div>
            <div className="pitch-signal">
              <div className="pitch-signal-label">Next</div>
              <div className="pitch-signal-value">Mainnet beta launch — April 2026</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide Registry ───────────────────────────────────────────────────────────

const SLIDES = [
  { id: 1, title: "Cover", component: Slide01Cover },
  { id: 2, title: "Insight", component: Slide02Insight },
  { id: 3, title: "Problem", component: Slide03Problem },
  { id: 4, title: "Solution", component: Slide04Solution },
  { id: 5, title: "Proof", component: Slide05Proof },
  { id: 6, title: "Market", component: Slide06Market },
  { id: 7, title: "Why Us", component: Slide07WhyUs },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PitchPage() {
  const [current, setCurrent] = useState(0);

  const prev = useCallback(() => {
    setCurrent((c) => Math.max(0, c - 1));
  }, []);

  const next = useCallback(() => {
    setCurrent((c) => Math.min(TOTAL_SLIDES - 1, c + 1));
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  const SlideComponent = SLIDES[current].component;

  return (
    <>
      {/* Full-screen overlay covering Header/Footer */}
      <div
        className="pitch-deck-overlay"
        onClick={next}
        role="presentation"
      >
        {/* Slide content */}
        <SlideComponent isCurrent />

        {/* Controls bar */}
        <div
          className="pitch-controls"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="pitch-nav-btn"
            onClick={prev}
            disabled={current === 0}
            aria-label="Previous slide"
          >
            ←
          </button>
          <span className="pitch-counter mono">
            {current + 1} / {TOTAL_SLIDES}
          </span>
          <button
            className="pitch-nav-btn"
            onClick={next}
            disabled={current === TOTAL_SLIDES - 1}
            aria-label="Next slide"
          >
            →
          </button>
        </div>

        {/* Slide dots */}
        <div
          className="pitch-dots"
          onClick={(e) => e.stopPropagation()}
        >
          {SLIDES.map((_, i) => (
            <button
              key={i}
              className={`pitch-dot ${i === current ? "pitch-dot-active" : ""}`}
              onClick={() => setCurrent(i)}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>
      </div>

      {/* Styles */}
      <style>{`
        /* ── Full-screen overlay ── */
        .pitch-deck-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: #0D0D0F;
          display: flex;
          flex-direction: column;
          cursor: pointer;
          overflow: hidden;
        }

        /* ── Slide base ── */
        .pitch-slide {
          position: relative;
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          padding: 0 0 80px 0;
        }

        .pitch-slide-inner {
          width: 100%;
          max-width: 1000px;
          margin: 0 auto;
          padding: 2rem 2.5rem;
        }

        .pitch-center {
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        /* ── Background grid ── */
        .pitch-bg-grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(153,69,255,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(153,69,255,0.04) 1px, transparent 1px);
          background-size: 64px 64px;
          pointer-events: none;
        }

        /* ── Logo ── */
        .pitch-logo {
          max-width: 500px;
          width: 80%;
          height: auto;
          margin-bottom: 2rem;
        }

        /* ── Typography ── */
        .pitch-hero-title {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: clamp(4rem, 10vw, 8rem);
          font-weight: 900;
          letter-spacing: -0.04em;
          line-height: 1;
          background: linear-gradient(135deg, #fff 0%, #9945FF 50%, #22D3EE 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-bottom: 1.5rem;
        }

        .pitch-hero-sub {
          font-family: 'Inter', sans-serif;
          font-size: clamp(1.2rem, 2.5vw, 1.6rem);
          color: rgba(255,255,255,0.6);
          line-height: 1.5;
          max-width: 550px;
        }

        .pitch-divider {
          width: 80px;
          height: 1px;
          background: linear-gradient(90deg, #9945FF, #22D3EE);
          margin: 2rem auto;
        }

        .pitch-url {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.85rem;
          color: rgba(34,211,238,0.5);
          letter-spacing: 0.05em;
        }

        .pitch-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153,69,255,0.7);
          margin-bottom: 1.2rem;
        }

        .pitch-title {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: clamp(1.6rem, 3.5vw, 2.6rem);
          font-weight: 800;
          letter-spacing: -0.02em;
          line-height: 1.2;
          color: #fff;
          margin-bottom: 2rem;
        }

        .mono {
          font-family: 'JetBrains Mono', monospace;
        }

        .pitch-body-text {
          font-family: 'Inter', sans-serif;
          font-size: 1rem;
          line-height: 1.75;
          color: rgba(255,255,255,0.6);
        }

        /* ── Insight slide ── */
        .pitch-insight-body {
          max-width: 700px;
        }

        .pitch-callout {
          margin-top: 2rem;
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.4rem;
          font-weight: 800;
          color: #9945FF;
          letter-spacing: -0.01em;
        }

        /* ── Problem slide ── */
        .pitch-problem-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.5rem;
        }

        .pitch-problem-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.75rem;
        }

        .pitch-problem-stat {
          font-family: 'JetBrains Mono', monospace;
          font-size: clamp(1.8rem, 3vw, 2.5rem);
          font-weight: 700;
          color: #FF3B5C;
          margin-bottom: 0.75rem;
        }

        .pitch-problem-card p {
          font-family: 'Inter', sans-serif;
          font-size: 0.9rem;
          line-height: 1.6;
          color: rgba(255,255,255,0.55);
        }

        /* ── Solution slide ── */
        .pitch-solution-stack {
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }

        .pitch-solution-item {
          display: flex;
          gap: 1.5rem;
          align-items: flex-start;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 10px;
          padding: 1.25rem 1.5rem;
        }

        .pitch-solution-num {
          font-family: 'JetBrains Mono', monospace;
          font-size: 1.8rem;
          font-weight: 700;
          flex-shrink: 0;
          line-height: 1;
          padding-top: 0.1rem;
        }

        .pitch-solution-num.purple { color: #9945FF; }
        .pitch-solution-num.cyan { color: #22D3EE; }

        .pitch-solution-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.05rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.4rem;
        }

        .pitch-solution-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.875rem;
          line-height: 1.6;
          color: rgba(255,255,255,0.55);
        }

        /* ── Proof / Traction ── */
        .pitch-proof-row {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .pitch-traction-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1rem;
        }

        .pitch-traction-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 1.25rem;
          text-align: center;
        }

        .pitch-traction-num {
          font-size: clamp(1.6rem, 2.5vw, 2.2rem);
          font-weight: 700;
          color: #9945FF;
          margin-bottom: 0.4rem;
        }

        .pitch-traction-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.78rem;
          color: rgba(255,255,255,0.45);
          line-height: 1.4;
        }

        .pitch-proof-extras {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
        }

        .pitch-milestone {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          font-family: 'Inter', sans-serif;
          font-size: 0.875rem;
          color: rgba(255,255,255,0.55);
        }

        .pitch-milestone-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .pitch-milestone-dot.cyan { background: #22D3EE; }
        .pitch-milestone-dot.purple { background: #9945FF; }

        /* ── Market Opportunity ── */
        .pitch-market-layout {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 2rem;
          align-items: center;
        }

        .pitch-market-stat-block { text-align: center; }

        .pitch-market-big-num {
          font-size: clamp(3rem, 5vw, 5rem);
          font-weight: 700;
          color: #9945FF;
          line-height: 1;
          margin-bottom: 0.5rem;
        }

        .pitch-market-big-label {
          font-family: 'Inter', sans-serif;
          font-size: 1rem;
          font-weight: 600;
          color: rgba(255,255,255,0.7);
          margin-bottom: 0.4rem;
        }

        .pitch-market-sub {
          font-family: 'Inter', sans-serif;
          font-size: 0.8rem;
          color: rgba(255,255,255,0.35);
        }

        .pitch-market-divider {
          width: 1px;
          height: 180px;
          background: linear-gradient(to bottom, transparent, rgba(153,69,255,0.4), transparent);
        }

        .pitch-market-opportunity { text-align: center; }

        .pitch-market-opp-num {
          font-size: clamp(3rem, 5vw, 5rem);
          font-weight: 700;
          color: #22D3EE;
          line-height: 1;
          margin-bottom: 0.5rem;
        }

        .pitch-market-opp-label {
          font-family: 'Inter', sans-serif;
          font-size: 1rem;
          font-weight: 600;
          color: rgba(255,255,255,0.7);
          margin-bottom: 0.75rem;
        }

        .pitch-market-opp-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          line-height: 1.6;
          color: rgba(255,255,255,0.45);
          max-width: 400px;
          margin: 0 auto;
        }

        /* ── Why Us ── */
        .pitch-why-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 2.5rem;
          align-items: start;
        }

        .pitch-why-signals {
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }

        .pitch-signal {
          border-left: 2px solid rgba(153,69,255,0.4);
          padding-left: 1rem;
        }

        .pitch-signal-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: rgba(153,69,255,0.7);
          margin-bottom: 0.25rem;
        }

        .pitch-signal-value {
          font-family: 'Inter', sans-serif;
          font-size: 0.875rem;
          color: rgba(255,255,255,0.65);
          line-height: 1.5;
        }

        /* ── Controls ── */
        .pitch-controls {
          position: absolute;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 1rem;
          z-index: 10;
        }

        .pitch-nav-btn {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.15);
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.7);
          font-size: 1rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
        }

        .pitch-nav-btn:hover:not(:disabled) {
          border-color: rgba(153,69,255,0.5);
          background: rgba(153,69,255,0.12);
          color: #fff;
        }

        .pitch-nav-btn:disabled {
          opacity: 0.25;
          cursor: default;
        }

        .pitch-counter {
          font-size: 0.8rem;
          color: rgba(255,255,255,0.4);
          min-width: 50px;
          text-align: center;
        }

        /* ── Slide dots ── */
        .pitch-dots {
          position: absolute;
          bottom: 66px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: 6px;
          z-index: 10;
        }

        .pitch-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: rgba(255,255,255,0.18);
          border: none;
          cursor: pointer;
          padding: 0;
          transition: all 0.2s ease;
        }

        .pitch-dot-active {
          background: #9945FF;
          width: 20px;
          border-radius: 3px;
        }

        /* ─── PRINT STYLES ─── */
        @media print {
          .pitch-deck-overlay {
            position: static;
            display: block;
          }

          .pitch-controls,
          .pitch-dots {
            display: none !important;
          }

          .pitch-slide {
            page-break-after: always;
            break-after: page;
            height: 100vh;
            min-height: 100vh;
            padding: 0;
          }
        }

        /* ─── Mobile ─── */
        @media (max-width: 768px) {
          .pitch-slide-inner {
            padding: 1.25rem 1rem;
          }

          .pitch-problem-grid,
          .pitch-traction-grid {
            grid-template-columns: repeat(2, 1fr);
          }

          .pitch-why-layout {
            grid-template-columns: 1fr;
          }

          .pitch-market-layout {
            grid-template-columns: 1fr;
          }

          .pitch-market-divider {
            width: 80px;
            height: 1px;
            margin: 0 auto;
          }
        }

        @media (max-width: 480px) {
          .pitch-problem-grid,
          .pitch-traction-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </>
  );
}
