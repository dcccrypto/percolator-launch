"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Slide Data ──────────────────────────────────────────────────────────────

const TOTAL_SLIDES = 11;

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
          Pump.fun for perps.<br />
          Permissionless perpetuals on Solana.
        </p>
        <div className="pitch-divider" />
        <p className="pitch-url">percolatorlaunch.com</p>
      </div>
      <div className="pitch-bg-grid" aria-hidden />
    </div>
  );
}

function Slide02Gap({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Gap</div>
        <h2 className="pitch-title">
          15 million tokens live on Solana.<br />
          Fewer than 50 have perpetual markets.
        </h2>
        <div className="pitch-insight-body">
          <p className="pitch-body-text">
            Every major perps DEX — Hyperliquid, Jupiter, Drift — decides which tokens
            you can trade with leverage. Listing requires approval, an oracle feed, or
            millions in auction fees.
          </p>
          <p className="pitch-body-text" style={{ marginTop: '1.25rem' }}>
            The result: 99.9997% of tokens can never have leveraged markets.
          </p>
          <div className="pitch-callout">
            Not because of technical limits. Because of design choices.
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide03Solution({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Solution</div>
        <h2 className="pitch-title">One place to trade any token with leverage.</h2>
        <div className="pitch-solution-three">
          <div className="pitch-solution-line">
            <span className="pitch-solution-line-bold">Blue chips</span>
            <span className="pitch-solution-line-sep">—</span>
            <span className="pitch-solution-line-text">SOL, BTC, ETH with deep liquidity and Pyth feeds</span>
          </div>
          <div className="pitch-solution-line">
            <span className="pitch-solution-line-bold">Memecoins</span>
            <span className="pitch-solution-line-sep">—</span>
            <span className="pitch-solution-line-text">WIF, BONK, POPCAT, and anything trading on a DEX</span>
          </div>
          <div className="pitch-solution-line">
            <span className="pitch-solution-line-bold">Long-tail tokens</span>
            <span className="pitch-solution-line-sep">—</span>
            <span className="pitch-solution-line-text">the next 15 million</span>
          </div>
        </div>
        <p className="pitch-solution-sub">
          One account. One collateral balance. Every perp market.
        </p>
      </div>
    </div>
  );
}

function Slide04Create({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Permissionless</div>
        <h2 className="pitch-title">Create a Market in 60 Seconds</h2>

        {/* Bold three-step diagram */}
        <div className="pflow-wrap">
          {/* Step 01 */}
          <div className="pflow-step">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">01</div>
            </div>
            <div className="pflow-step-title">Pick a token</div>
            <div className="pflow-step-desc">Paste any Solana mint address</div>
            <div className="pflow-example-card">
              <div className="pflow-example-label mono">mint</div>
              <div className="pflow-example-value mono">EKpQGAJ...WIF</div>
            </div>
          </div>

          {/* Connector */}
          <div className="pflow-connector" aria-hidden>
            <svg width="64" height="24" viewBox="0 0 64 24" fill="none" className="pflow-arrow-svg">
              <defs>
                <linearGradient id="arrowGrad1" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#9945FF" />
                  <stop offset="100%" stopColor="#22D3EE" />
                </linearGradient>
              </defs>
              <line x1="0" y1="12" x2="52" y2="12" stroke="url(#arrowGrad1)" strokeWidth="2" />
              <polyline points="46,6 58,12 46,18" stroke="url(#arrowGrad1)" strokeWidth="2" fill="none" strokeLinejoin="round" />
            </svg>
          </div>

          {/* Step 02 */}
          <div className="pflow-step">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">02</div>
            </div>
            <div className="pflow-step-title">Set parameters</div>
            <div className="pflow-step-desc">Fee rate, leverage cap, oracle mode</div>
            <div className="pflow-example-card">
              <div className="pflow-example-label mono">config</div>
              <div className="pflow-example-value mono">Fee: 3%</div>
              <div className="pflow-example-value mono">Leverage: 10x</div>
              <div className="pflow-example-value mono">Oracle: HYPERP</div>
            </div>
          </div>

          {/* Connector */}
          <div className="pflow-connector" aria-hidden>
            <svg width="64" height="24" viewBox="0 0 64 24" fill="none" className="pflow-arrow-svg">
              <defs>
                <linearGradient id="arrowGrad2" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#9945FF" />
                  <stop offset="100%" stopColor="#22D3EE" />
                </linearGradient>
              </defs>
              <line x1="0" y1="12" x2="52" y2="12" stroke="url(#arrowGrad2)" strokeWidth="2" />
              <polyline points="46,6 58,12 46,18" stroke="url(#arrowGrad2)" strokeWidth="2" fill="none" strokeLinejoin="round" />
            </svg>
          </div>

          {/* Step 03 */}
          <div className="pflow-step pflow-step-live">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">03</div>
            </div>
            <div className="pflow-step-title">Launch</div>
            <div className="pflow-step-desc">Market live. Trades execute immediately.</div>
            <div className="pflow-example-card pflow-example-card-live">
              <div className="pflow-example-label mono">tx confirmed</div>
              <div className="pflow-example-value mono pflow-live-id">Market 7x3K...live</div>
              <div className="pflow-live-dot-row">
                <span className="pflow-live-dot" />
                <span className="pflow-live-text mono">OPEN</span>
              </div>
            </div>
          </div>
        </div>

        <div className="pitch-create-footer">
          $500 USDC. 60 seconds. Earn fees forever.
        </div>
      </div>
    </div>
  );
}

function Slide05HowItWorks({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Three Mechanisms</div>
        <h2 className="pitch-title">What makes every-token perps possible.</h2>
        <div className="pitch-solution-stack">
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">1</div>
            <div>
              <div className="pitch-solution-name">On-chain oracle</div>
              <p className="pitch-solution-desc">
                If a token trades on Raydium, Meteora, or pump.fun, we can read its price
                directly from the pool. No Pyth listing required. &lt;0.05% deviation from
                centralized feeds on BTC, SOL, ETH.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">2</div>
            <div>
              <div className="pitch-solution-name">Mathematically fair risk engine</div>
              <p className="pitch-solution-desc">
                Built on open-source research from Anatoly Yakovenko. When a market hits
                limits, everyone takes a proportional haircut instead of some traders
                getting force-liquidated. Same deal for everyone.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">3</div>
            <div>
              <div className="pitch-solution-name">Permissionless market creation</div>
              <p className="pitch-solution-desc">
                $500 USDC and 60 seconds. No application, no approval. Set your fee rate,
                earn from every trade in your market.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide06Proof({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Live on Devnet</div>
        <h2 className="pitch-title">Built. Verified. Growing.</h2>
        <div className="pitch-proof-row">
          <div className="pitch-proof-block">
            <div className="pitch-traction-grid">
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">168</div>
                <div className="pitch-traction-label">Markets created on devnet</div>
              </div>
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">3,000+</div>
                <div className="pitch-traction-label">Organic X followers</div>
              </div>
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">471</div>
                <div className="pitch-traction-label">Formal proofs verified (Kani)</div>
              </div>
              <div className="pitch-traction-card">
                <div className="pitch-traction-num mono">0</div>
                <div className="pitch-traction-label">Unresolved critical or high findings</div>
              </div>
            </div>
          </div>
          <div className="pitch-proof-extras">
            <div className="pitch-milestone">
              <div className="pitch-milestone-dot cyan" />
              <span>Position NFTs — transferable perp positions on Solana</span>
            </div>
            <div className="pitch-milestone">
              <div className="pitch-milestone-dot cyan" />
              <span>Apache 2.0 — fully open source, 8 public repos</span>
            </div>
            <div className="pitch-milestone">
              <div className="pitch-milestone-dot purple" />
              <span>Zero paid marketing, zero incentive programs</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide07Competition({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Landscape</div>
        <h2 className="pitch-title">Only one protocol lists every token.</h2>
        <div className="pitch-matrix-wrap">
          <table className="pitch-matrix">
            <thead>
              <tr>
                <th className="pitch-matrix-feature"></th>
                <th>Hyperliquid</th>
                <th>Jupiter Perps</th>
                <th>Drift</th>
                <th className="pitch-matrix-us">Percolator</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="pitch-matrix-feature">Permissionless markets</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature">Long-tail tokens</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature">Cross-margin</td>
                <td className="pitch-matrix-yes">✓</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes">✓</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature">On-chain oracle</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature">Market creator fees</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="pitch-matrix-sub">
          Everyone else competes for the same 30–50 tokens. We opened a new category.
        </p>
      </div>
    </div>
  );
}

function Slide08WhyNow({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Timing</div>
        <h2 className="pitch-title">The window is open.</h2>
        <div className="pitch-whynow-stats">
          <div className="pitch-whynow-stat">
            <div className="pitch-whynow-num mono">$2–4B</div>
            <div className="pitch-whynow-label">Monthly Solana perp volume today</div>
          </div>
          <div className="pitch-whynow-stat">
            <div className="pitch-whynow-num mono">10×</div>
            <div className="pitch-whynow-label">Growth in Solana DEX volume in 18 months</div>
          </div>
          <div className="pitch-whynow-stat">
            <div className="pitch-whynow-num mono">Every week</div>
            <div className="pitch-whynow-label">Thousands of new tradable tokens launch with no perp path</div>
          </div>
        </div>
        <div className="pitch-whynow-closing">
          Perps are the next trillion-dollar DeFi category. The winner is whoever can
          list the most assets fastest.
        </div>
      </div>
    </div>
  );
}

function Slide09Users({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Users</div>
        <h2 className="pitch-title">Three audiences. One protocol.</h2>
        <div className="pitch-user-cards">
          <div className="pitch-user-card">
            <div className="pitch-user-role">The Trader</div>
            <p className="pitch-user-story">
              Wants leverage on WIF the moment it trends. Can't get it on Hyperliquid.
              Opens Percolator, trades instantly.
            </p>
          </div>
          <div className="pitch-user-card">
            <div className="pitch-user-role">The Creator</div>
            <p className="pitch-user-story">
              Launches a token and wants a perp market for it. Deposits $500. Earns
              fees from every trade for the life of the market.
            </p>
          </div>
          <div className="pitch-user-card">
            <div className="pitch-user-role">The LP</div>
            <p className="pitch-user-story">
              Backs long-tail inventory that didn't exist before. Earns yield
              uncorrelated to blue-chip perp flow.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide10Opportunity({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">The Market</div>
        <h2 className="pitch-title">We're not taking a slice. We're building a new pie.</h2>
        <div className="pitch-market-layout">
          <div className="pitch-market-stat-block">
            <div className="pitch-market-big-num mono">$2–4B</div>
            <div className="pitch-market-big-label">Monthly Solana perp volume</div>
            <div className="pitch-market-sub">~50 tokens. All blue chips.</div>
            <div className="pitch-market-sub" style={{ marginTop: '0.25rem' }}>Mature, contested, low growth ceiling.</div>
          </div>
          <div className="pitch-market-divider" />
          <div className="pitch-market-opportunity">
            <div className="pitch-market-opp-num mono">15M+</div>
            <div className="pitch-market-opp-label">Tokens with zero perp access today</div>
            <p className="pitch-market-opp-desc">
              Every token on pump.fun, every memecoin, every new launch.
              The long tail of crypto, finally tradable with leverage.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slide11Vision({ isCurrent }: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Where This Goes</div>
        <h2 className="pitch-title">Every tradable asset becomes a perp market.</h2>
        <p className="pitch-body-text" style={{ maxWidth: '680px', marginBottom: '2rem' }}>
          Today perps are a luxury reserved for the 50 tokens exchanges choose to support.
          In five years, every token worth trading spot will also be tradable perpetually.
        </p>
        <div className="pitch-roadmap">
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase purple">Phase 1</div>
            <div className="pitch-roadmap-name">Mainnet beta</div>
            <div className="pitch-roadmap-desc">launching soon</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase cyan">Phase 2</div>
            <div className="pitch-roadmap-name">Liquidity deepening</div>
            <div className="pitch-roadmap-desc">market maker programs, LP incentives</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase purple">Phase 3</div>
            <div className="pitch-roadmap-name">Advanced primitives</div>
            <div className="pitch-roadmap-desc">position NFTs, structured products, options</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase cyan">Phase 4</div>
            <div className="pitch-roadmap-name">Cross-chain expansion</div>
            <div className="pitch-roadmap-desc">every-token perps beyond Solana</div>
          </div>
        </div>
        <div className="pitch-vision-footer">
          We're building this regardless. If that resonates, let's talk.
        </div>
      </div>
    </div>
  );
}

// ─── Slide Registry ───────────────────────────────────────────────────────────

const SLIDES = [
  { id: 1, title: "Cover", component: Slide01Cover },
  { id: 2, title: "The Gap", component: Slide02Gap },
  { id: 3, title: "Solution", component: Slide03Solution },
  { id: 4, title: "Create a Market", component: Slide04Create },
  { id: 5, title: "How It Works", component: Slide05HowItWorks },
  { id: 6, title: "Proof", component: Slide06Proof },
  { id: 7, title: "Competition", component: Slide07Competition },
  { id: 8, title: "Why Now", component: Slide08WhyNow },
  { id: 9, title: "Who Uses It", component: Slide09Users },
  { id: 10, title: "The Opportunity", component: Slide10Opportunity },
  { id: 11, title: "Vision + Roadmap", component: Slide11Vision },
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

        /* ── Gap slide (was Insight) ── */
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

        /* ── Solution slide (Slide 3) ── */
        .pitch-solution-three {
          display: flex;
          flex-direction: column;
          gap: 1.1rem;
          margin-bottom: 2rem;
        }

        .pitch-solution-line {
          display: flex;
          align-items: baseline;
          gap: 0.6rem;
          font-family: 'Inter', sans-serif;
          font-size: clamp(1rem, 1.8vw, 1.2rem);
          line-height: 1.5;
        }

        .pitch-solution-line-bold {
          font-weight: 700;
          color: #fff;
          flex-shrink: 0;
        }

        .pitch-solution-line-sep {
          color: rgba(153,69,255,0.5);
          flex-shrink: 0;
        }

        .pitch-solution-line-text {
          color: rgba(255,255,255,0.55);
        }

        .pitch-solution-sub {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.15rem;
          font-weight: 700;
          color: #22D3EE;
          letter-spacing: -0.01em;
        }

        /* ── Create-market slide (Slide 5) ── */
        .pitch-create-footer {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.1rem;
          font-weight: 700;
          color: #22D3EE;
          letter-spacing: -0.01em;
          margin-top: 1.5rem;
        }

        /* ── Permissionless flow diagram (Slide 5) ── */
        .pflow-wrap {
          display: flex;
          align-items: stretch;
          gap: 0;
          margin-bottom: 0.5rem;
        }

        .pflow-step {
          flex: 1;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(153,69,255,0.2);
          border-radius: 12px;
          padding: 1.25rem 1.25rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          box-shadow: 0 0 24px rgba(153,69,255,0.06);
          transition: border-color 0.2s;
          min-width: 0;
        }

        .pflow-step-live {
          border-color: rgba(34,211,238,0.3);
          box-shadow: 0 0 24px rgba(34,211,238,0.08);
        }

        .pflow-num-wrap {
          margin-bottom: 0.5rem;
        }

        .pflow-num {
          display: inline-block;
          font-size: 1.7rem;
          font-weight: 700;
          line-height: 1;
          background: linear-gradient(135deg, #9945FF, #22D3EE);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          letter-spacing: -0.02em;
        }

        .pflow-step-title {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
        }

        .pflow-step-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.75rem;
          color: rgba(255,255,255,0.45);
          line-height: 1.4;
          margin-bottom: 0.5rem;
        }

        .pflow-example-card {
          background: rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 7px;
          padding: 0.6rem 0.75rem;
          margin-top: auto;
          display: flex;
          flex-direction: column;
          gap: 0.18rem;
        }

        .pflow-example-card-live {
          border-color: rgba(34,211,238,0.2);
          background: rgba(34,211,238,0.04);
        }

        .pflow-example-label {
          font-size: 0.58rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: rgba(255,255,255,0.25);
          margin-bottom: 0.1rem;
        }

        .pflow-example-value {
          font-size: 0.72rem;
          color: rgba(255,255,255,0.7);
          letter-spacing: 0.01em;
        }

        .pflow-live-id {
          color: #22D3EE;
        }

        .pflow-live-dot-row {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          margin-top: 0.2rem;
        }

        .pflow-live-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #22D3EE;
          box-shadow: 0 0 6px #22D3EE;
          flex-shrink: 0;
        }

        .pflow-live-text {
          font-size: 0.62rem;
          font-weight: 700;
          color: #22D3EE;
          letter-spacing: 0.1em;
        }

        .pflow-connector {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 64px;
          align-self: center;
        }

        .pflow-arrow-svg {
          display: block;
        }

        /* ── How It Works slide (Slide 6) ── */
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

        /* ── Proof / Traction (Slide 7) ── */
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

        /* ── Competition Matrix (Slide 8) ── */
        .pitch-matrix-wrap {
          overflow-x: auto;
          margin-bottom: 1.5rem;
        }

        .pitch-matrix {
          width: 100%;
          border-collapse: collapse;
          font-family: 'Inter', sans-serif;
          font-size: 0.875rem;
        }

        .pitch-matrix thead tr {
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }

        .pitch-matrix th {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-weight: 700;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.55);
          padding: 0.75rem 1rem;
          text-align: center;
        }

        .pitch-matrix th:first-child {
          text-align: left;
        }

        .pitch-matrix tbody tr {
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        .pitch-matrix tbody tr:last-child {
          border-bottom: none;
        }

        .pitch-matrix td {
          padding: 0.85rem 1rem;
          text-align: center;
          color: rgba(255,255,255,0.5);
        }

        .pitch-matrix-feature {
          text-align: left !important;
          color: rgba(255,255,255,0.7) !important;
          font-weight: 500;
        }

        .pitch-matrix-us {
          color: #9945FF !important;
          font-weight: 700 !important;
          background: rgba(153,69,255,0.07);
        }

        .pitch-matrix-yes {
          color: #22D3EE;
          font-weight: 700;
          font-size: 1rem;
        }

        .pitch-matrix-no {
          color: rgba(255,255,255,0.2);
          font-size: 1rem;
        }

        .pitch-matrix-sub {
          font-family: 'Inter', sans-serif;
          font-size: 0.875rem;
          color: rgba(255,255,255,0.4);
          font-style: italic;
        }

        /* ── Why Now (Slide 9) ── */
        .pitch-whynow-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.5rem;
          margin-bottom: 2rem;
        }

        .pitch-whynow-stat {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 1.5rem;
          text-align: center;
        }

        .pitch-whynow-num {
          font-size: clamp(1.6rem, 2.8vw, 2.4rem);
          font-weight: 700;
          color: #9945FF;
          margin-bottom: 0.5rem;
          line-height: 1.1;
        }

        .pitch-whynow-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.82rem;
          color: rgba(255,255,255,0.45);
          line-height: 1.4;
        }

        .pitch-whynow-closing {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: clamp(1rem, 1.8vw, 1.2rem);
          font-weight: 600;
          color: rgba(255,255,255,0.65);
          line-height: 1.5;
          max-width: 680px;
          border-left: 3px solid #22D3EE;
          padding-left: 1.25rem;
        }

        /* ── User Stories (Slide 10) ── */
        .pitch-user-cards {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.5rem;
        }

        .pitch-user-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.75rem;
        }

        .pitch-user-role {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #9945FF;
          margin-bottom: 0.85rem;
        }

        .pitch-user-story {
          font-family: 'Inter', sans-serif;
          font-size: 0.9rem;
          line-height: 1.65;
          color: rgba(255,255,255,0.6);
        }

        /* ── Market Opportunity (Slide 11) ── */
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

        /* ── Vision + Roadmap (Slide 12) ── */
        .pitch-roadmap {
          display: flex;
          align-items: flex-start;
          gap: 0;
          margin-bottom: 2rem;
          flex-wrap: wrap;
        }

        .pitch-roadmap-item {
          flex: 1;
          min-width: 160px;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 1.25rem;
          text-align: center;
        }

        .pitch-roadmap-connector {
          width: 32px;
          flex-shrink: 0;
          height: 2px;
          background: linear-gradient(90deg, rgba(153,69,255,0.35), rgba(34,211,238,0.35));
          align-self: center;
          margin: 0 4px;
        }

        .pitch-roadmap-phase {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin-bottom: 0.5rem;
        }

        .pitch-roadmap-phase.purple { color: #9945FF; }
        .pitch-roadmap-phase.cyan { color: #22D3EE; }

        .pitch-roadmap-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.35rem;
        }

        .pitch-roadmap-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.75rem;
          color: rgba(255,255,255,0.4);
          line-height: 1.4;
        }

        .pitch-vision-footer {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.1rem;
          font-weight: 700;
          color: rgba(255,255,255,0.65);
          border-left: 3px solid #9945FF;
          padding-left: 1.25rem;
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

          .pitch-traction-grid {
            grid-template-columns: repeat(2, 1fr);
          }

          .pitch-market-layout {
            grid-template-columns: 1fr;
          }

          .pitch-market-divider {
            width: 80px;
            height: 1px;
            margin: 0 auto;
          }

          .pitch-whynow-stats {
            grid-template-columns: 1fr;
          }

          .pitch-user-cards {
            grid-template-columns: 1fr;
          }

          .pitch-roadmap {
            flex-direction: column;
            gap: 0.75rem;
          }

          .pitch-roadmap-connector {
            width: 2px;
            height: 20px;
            align-self: center;
          }

          /* Pflow at mobile */
          .pflow-wrap {
            flex-direction: column;
            gap: 0.75rem;
          }

          .pflow-connector {
            width: auto;
            height: 32px;
            transform: rotate(90deg);
          }
        }

        @media (max-width: 480px) {
          .pitch-traction-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </>
  );
}
