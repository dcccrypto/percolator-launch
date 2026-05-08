"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ─── Liquid Drip identity components ─────────────────────────────────────────

function AuroraBackground() {
  return <div className="pitch-aurora" aria-hidden />;
}

function DripLine() {
  return (
    <div className="pitch-drip-line" aria-hidden>
      <div className="pitch-drip-dot" />
    </div>
  );
}

// ─── NumberCounter · ticks 0 → target on slide-active ────────────────────────

interface NumberCounterProps {
  target: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  format?: (n: number) => string;
  className?: string;
  isActive?: boolean;
}

function NumberCounter({
  target,
  duration = 800,
  prefix = "",
  suffix = "",
  format,
  className,
  isActive = true,
}: NumberCounterProps) {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      setValue(0);
      return;
    }

    // Respect reduced-motion: jump to target instantly
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setValue(target);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, isActive]);

  const display = format
    ? format(value)
    : value.toLocaleString();

  return (
    <span className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

// ─── Slide Data ──────────────────────────────────────────────────────────────
//
// 13 slides, ordered per Cap (Superteam UK) feedback 2026-04-30:
//   "i recommend doing one-liner / team / traction as your first 3 slides"
//   "don't have taglines - have a proper sentence which is the tldr of your
//    traction with a time frame"
//
// Structure follows Cap's 13-slide framework exactly:
//   1  One-Liner
//   2  Team
//   3  Traction (TL;DR sentence + growth chart)
//   4  Hackathon Engineering Sprint
//   5  Demo Product
//   6  Business Model + Unit Economics
//   7  Opportunity
//   8  Competitors
//   9  GTM & Why Now
//  10  Roadmap
//  11  Risks
//  12  Next Steps (Ask + Exit Path)
//  13  Contact
//
// Source of truth: percolator-ops/content/pitch-deck-copy.md (v6)
// ──────────────────────────────────────────────────────────────────────────

interface SlideProps {
  isCurrent: boolean;
}

// ─── Slide 1 · One-Liner ─────────────────────────────────────────────────────

function Slide01OneLiner(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/logo.png" alt="Percolator" className="pitch-logo" />
        <p className="pitch-hero-headline">
          Permissionless perpetual futures on Solana.
        </p>
        <ul className="pitch-hero-bullets">
          <li>
            <span className="pitch-hero-bullet-num mono">$500</span>
            <span className="pitch-hero-bullet-text">to launch a market on any SPL token</span>
          </li>
          <li>
            <span className="pitch-hero-bullet-num mono">60 sec</span>
            <span className="pitch-hero-bullet-text">no team approval, no auction</span>
          </li>
          <li>
            <span className="pitch-hero-bullet-num mono">15M+</span>
            <span className="pitch-hero-bullet-text">tokens incumbents refuse to list</span>
          </li>
          <li>
            <span className="pitch-hero-bullet-num mono">Apache 2.0</span>
            <span className="pitch-hero-bullet-text">fully open source · 8 public repos · fork it tomorrow</span>
          </li>
        </ul>
        <div className="pitch-divider" />
        <p className="pitch-url">percolator.trade</p>
      </div>
      <div className="pitch-bg-grid" aria-hidden />
    </div>
  );
}

// ─── Slide 2 · Team ──────────────────────────────────────────────────────────

function Slide02Team(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Team</div>
        <h2 className="pitch-title">
          Two co-founders and an AI pair-programmer shipped Percolator
          from zero to mainnet-ready with 457 formal proofs and zero
          outside capital.
        </h2>

        <div className="pitch-team-grid pitch-team-grid-three">
          <div className="pitch-team-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://pbs.twimg.com/profile_images/2020207940389548032/j7hY6v_m_400x400.jpg"
              alt="Khubair"
              className="pitch-team-pfp"
            />
            <div className="pitch-team-name">Khubair</div>
            <div className="pitch-team-role">Co-founder · Product</div>
            <p className="pitch-team-bio">
              Owns product direction, security review, and external
              positioning. Web2 startup background, now Solana product
              co-founder. Member of Superteam UK; won one of Toly&apos;s
              public bounties on pre-audit critical bug review.
            </p>
            <p className="pitch-team-links mono">
              <a
                href="https://x.com/dcc_crypto"
                target="_blank"
                rel="noopener noreferrer"
              >
                x.com/dcc_crypto
              </a>
              {" · "}
              <a
                href="https://github.com/dcccrypto"
                target="_blank"
                rel="noopener noreferrer"
              >
                github.com/dcccrypto
              </a>
            </p>
          </div>
          <div className="pitch-team-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://pbs.twimg.com/profile_images/2050225373145686016/2eOEQdFC_400x400.jpg"
              alt="Squid"
              className="pitch-team-pfp"
            />
            <div className="pitch-team-name">Squid</div>
            <div className="pitch-team-role">Co-founder · Community</div>
            <p className="pitch-team-bio">
              Owns community strategy, project management, and the
              daily &ldquo;vibe code&rdquo; that benefits Percolator.
              Built{" "}
              <a
                className="pitch-team-bio-link"
                href="https://github.com/0x-SquidSol/percolator-buyback"
                target="_blank"
                rel="noopener noreferrer"
              >
                percolator-buyback
              </a>
              {" "}and{" "}
              <a
                className="pitch-team-bio-link"
                href="https://github.com/0x-SquidSol/percolator-locker"
                target="_blank"
                rel="noopener noreferrer"
              >
                percolator-locker
              </a>
              . 3 years in Solana; winner of Toly&apos;s Percolator
              bounty.
            </p>
            <p className="pitch-team-links mono">
              <a
                href="https://x.com/0xSquid_Sol"
                target="_blank"
                rel="noopener noreferrer"
              >
                x.com/0xSquid_Sol
              </a>
              {" · "}
              <a
                href="https://github.com/0x-SquidSol"
                target="_blank"
                rel="noopener noreferrer"
              >
                github.com/0x-SquidSol
              </a>
            </p>
          </div>
          <div className="pitch-team-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://github.com/anthropics.png?size=200"
              alt="Claude (Anthropic)"
              className="pitch-team-pfp"
            />
            <div className="pitch-team-name">Claude</div>
            <div className="pitch-team-role">Lead engineering · AI pair-programmer</div>
            <p className="pitch-team-bio">
              Owns most of the production code the co-founders direct:
              Rust programs, TypeScript SDK and frontend, tests, Kani
              proof drafts. Anthropic&apos;s Claude (Opus 4.7) running
              in Claude Code; funded by pump.fun creator rewards.
              Reviews PRs. Doesn&apos;t sleep.
            </p>
          </div>
        </div>

        <p className="pitch-team-footer">
          Toly authored the protocol math and program. We built the
          frontend, indexer, SDK, and infrastructure that turn it into
          a live product on Solana mainnet.
        </p>
      </div>
    </div>
  );
}

// ─── Slide 3 · Traction ──────────────────────────────────────────────────────
//
// Programs verified on-chain at the time of writing:
//   - Devnet (testing, March 2026):  g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in
//   - Mainnet (closed beta, May):     ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv
// Stats below are pulled from getSignaturesForAddress + market slab tracking.
// Followers are organic, no paid spend.

function Slide03Traction(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Traction · On-Chain</div>
        <h2 className="pitch-title">
          Devnet program is live and busy: 8 markets created, 1,000+
          transactions, 100% success rate. Mainnet is deployed but
          private — no public trading until the external audit clears.
        </h2>

        <div className="pitch-traction-network-grid pitch-traction-network-grid-single">
          <div className="pitch-traction-network-card pitch-traction-network-card-wide">
            <div className="pitch-traction-network-header">
              <div className="pitch-traction-network-tag mono pitch-traction-network-tag-cyan">Devnet · live program</div>
              <a
                className="pitch-traction-network-link mono"
                href="https://explorer.solana.com/address/g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in?cluster=devnet"
                target="_blank"
                rel="noopener noreferrer"
              >
                g9msRSV3…dm9in ↗
              </a>
            </div>
            <div className="pitch-traction-network-stats pitch-traction-network-stats-three">
              <div className="pitch-traction-network-stat">
                <div className="pitch-traction-network-num mono pitch-traction-network-num-cyan">
                  <NumberCounter target={8} />
                </div>
                <div className="pitch-traction-network-label">markets created</div>
              </div>
              <div className="pitch-traction-network-stat">
                <div className="pitch-traction-network-num mono">
                  <NumberCounter target={1000} suffix="+" />
                </div>
                <div className="pitch-traction-network-label">transactions</div>
              </div>
              <div className="pitch-traction-network-stat">
                <div className="pitch-traction-network-num mono pitch-traction-network-num-cyan">100%</div>
                <div className="pitch-traction-network-label">success rate</div>
              </div>
            </div>
            <div className="pitch-traction-network-meta mono">
              Live testing on Solana devnet. Mainnet program is deployed
              and audit-pending — closed to public trading until Q3 audit
              completion.
            </div>
          </div>
        </div>

        <div className="pitch-traction-mini-row">
          <div className="pitch-traction-mini">
            <div className="pitch-traction-mini-num mono">
              <NumberCounter target={457} />
            </div>
            <div className="pitch-traction-mini-label">Kani formal proofs (all green)</div>
          </div>
          <div className="pitch-traction-mini">
            <div className="pitch-traction-mini-num mono">
              <NumberCounter target={8} />
            </div>
            <div className="pitch-traction-mini-label">Public repos · Apache 2.0</div>
          </div>
          <div className="pitch-traction-mini">
            <div className="pitch-traction-mini-num mono">
              <NumberCounter target={3400} suffix="+" />
            </div>
            <div className="pitch-traction-mini-label">Organic X followers</div>
          </div>
          <div className="pitch-traction-mini">
            <div className="pitch-traction-mini-num mono">$0</div>
            <div className="pitch-traction-mini-label">Paid acquisition · outside capital</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide 4 · Hackathon Engineering Sprint ──────────────────────────────────

function Slide04Sprint(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Hackathon Engineering Sprint</div>
        <h2 className="pitch-title">
          Across the 5-week Frontier window we shipped three changes that
          unblock long-tail perp markets, each tied to direct customer
          signal.
        </h2>

        <div className="pitch-solution-stack">
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">1</div>
            <div>
              <div className="pitch-solution-name">
                v12.17 mainnet upgrade + first SOL/USDC market on mainnet
              </div>
              <p className="pitch-solution-desc">
                Four programs upgraded and deployed. SOL/USDC Hyperp market
                created against a pinned Raydium CLMM pool, running today
                in lab mode, gated until external audit completes in Q3.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">2</div>
            <div>
              <div className="pitch-solution-name">
                Token-2022 transferable position NFTs
              </div>
              <p className="pitch-solution-desc">
                Customers asked for transferable positions. We shipped them
                as Token-2022 NFTs. First transferable perp positions
                ever shipped on Solana.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">3</div>
            <div>
              <div className="pitch-solution-name">
                Pre-audit hardening: 0 CRITICAL, 0 HIGH internal findings
              </div>
              <p className="pitch-solution-desc">
                Five-phase sprint that rewrote the proof suite (457 Kani
                proofs replacing the prior 349) and closed every internal
                CRITICAL and HIGH finding. Customers said audit posture was
                the #1 blocker for putting real capital on a long-tail
                market.
              </p>
            </div>
          </div>
        </div>

        <p
          className="pitch-solution-sub"
          style={{ marginTop: "1.5rem" }}
        >
          What we did NOT build: a token launchpad, governance,
          cross-margining. Out-of-scope, on the roadmap.
        </p>
      </div>
    </div>
  );
}

// ─── Slide 5 · Demo Product ──────────────────────────────────────────────────

function Slide05Product(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Demo Product</div>
        <h2 className="pitch-title">
          Closed beta on Solana mainnet today: connect wallet, deposit
          USDC, open a leveraged long, close at PnL, fees split four
          ways on-chain. Public access opens after the external audit.
        </h2>

        <div className="pflow-wrap">
          <div className="pflow-step">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">01</div>
            </div>
            <div className="pflow-step-title">Connect & deposit</div>
            <div className="pflow-step-desc">
              Any Solana wallet. USDC into the vault.
            </div>
            <div className="pflow-example-card">
              <div className="pflow-example-label mono">deposit</div>
              <div className="pflow-example-value mono">25.00 USDC</div>
              <div className="pflow-example-value mono">tx confirmed</div>
            </div>
          </div>

          <div className="pflow-connector" aria-hidden>
            <svg
              width="64"
              height="24"
              viewBox="0 0 64 24"
              fill="none"
              className="pflow-arrow-svg"
            >
              <defs>
                <linearGradient id="arrowGradLP1" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#9945FF" />
                  <stop offset="100%" stopColor="#22D3EE" />
                </linearGradient>
              </defs>
              <line x1="0" y1="12" x2="52" y2="12" stroke="url(#arrowGradLP1)" strokeWidth="2" />
              <polyline points="46,6 58,12 46,18" stroke="url(#arrowGradLP1)" strokeWidth="2" fill="none" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="pflow-step">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">02</div>
            </div>
            <div className="pflow-step-title">Open leveraged position</div>
            <div className="pflow-step-desc">
              Long or short. Up to 10×. Mark price from HYPERP.
            </div>
            <div className="pflow-example-card">
              <div className="pflow-example-label mono">long</div>
              <div className="pflow-example-value mono">SOL · 5×</div>
              <div className="pflow-example-value mono">NFT minted</div>
            </div>
          </div>

          <div className="pflow-connector" aria-hidden>
            <svg
              width="64"
              height="24"
              viewBox="0 0 64 24"
              fill="none"
              className="pflow-arrow-svg"
            >
              <defs>
                <linearGradient id="arrowGradLP2" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#9945FF" />
                  <stop offset="100%" stopColor="#22D3EE" />
                </linearGradient>
              </defs>
              <line x1="0" y1="12" x2="52" y2="12" stroke="url(#arrowGradLP2)" strokeWidth="2" />
              <polyline points="46,6 58,12 46,18" stroke="url(#arrowGradLP2)" strokeWidth="2" fill="none" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="pflow-step pflow-step-live">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">03</div>
            </div>
            <div className="pflow-step-title">Close & settle</div>
            <div className="pflow-step-desc">
              Fees split four ways automatically, on-chain.
            </div>
            <div className="pflow-example-card pflow-example-card-live">
              <div className="pflow-example-label mono">fee split</div>
              <div className="pflow-example-value mono pflow-live-id">
                vault · creator · protocol
              </div>
              <div className="pflow-live-dot-row">
                <span className="pflow-live-dot" />
                <span className="pflow-live-text mono">SETTLED</span>
              </div>
            </div>
          </div>
        </div>

        <div className="pitch-create-footer">
          Position is a Token-2022 NFT. First transferable perp
          position on Solana. Closed beta on mainnet at percolator.trade.
        </div>
      </div>
    </div>
  );
}

// ─── Slide 6 · Business Model + Unit Economics ───────────────────────────────

function Slide06Money(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Business Model</div>
        <h2 className="pitch-title">
          We charge 0.1–1% per trade across every market, splitting fees
          four ways on-chain. Gross margin &gt;95% after Solana compute.
        </h2>

        <div className="pitch-money-flow">
          <div className="pitch-money-flow-title">
            Fee flow on every fill: automatic, on-chain, no claim transactions
          </div>

          <div className="pitch-fee-stage">
            <div className="pitch-fee-source">
              <div className="pitch-money-pill pitch-money-pill-purple">
                Trader pays<br /><span className="mono">1–10%</span>
              </div>
            </div>

            <div className="pitch-fee-channel" aria-hidden>
              <svg
                viewBox="0 0 480 140"
                preserveAspectRatio="xMidYMid meet"
                className="pitch-fee-svg"
              >
                <defs>
                  <linearGradient id="feeFlowGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#9945FF" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#22D3EE" stopOpacity="0.45" />
                  </linearGradient>
                </defs>
                <path
                  id="feePathLeft"
                  d="M 240 10 C 240 70, 60 70, 60 130"
                  stroke="url(#feeFlowGrad)"
                  fill="none"
                  strokeWidth="1.5"
                />
                <path
                  id="feePathCenter"
                  d="M 240 10 L 240 130"
                  stroke="url(#feeFlowGrad)"
                  fill="none"
                  strokeWidth="1.5"
                />
                <path
                  id="feePathRight"
                  d="M 240 10 C 240 70, 420 70, 420 130"
                  stroke="url(#feeFlowGrad)"
                  fill="none"
                  strokeWidth="1.5"
                />

                <circle r="4" fill="#22D3EE" className="pitch-fee-svg-dot">
                  <animateMotion dur="3.2s" repeatCount="indefinite">
                    <mpath href="#feePathLeft" />
                  </animateMotion>
                  <animate
                    attributeName="opacity"
                    values="0;1;1;0"
                    keyTimes="0;0.1;0.9;1"
                    dur="3.2s"
                    repeatCount="indefinite"
                  />
                </circle>

                <circle r="4" fill="#22D3EE" className="pitch-fee-svg-dot">
                  <animateMotion dur="3.2s" begin="1.05s" repeatCount="indefinite">
                    <mpath href="#feePathCenter" />
                  </animateMotion>
                  <animate
                    attributeName="opacity"
                    values="0;1;1;0"
                    keyTimes="0;0.1;0.9;1"
                    dur="3.2s"
                    begin="1.05s"
                    repeatCount="indefinite"
                  />
                </circle>

                <circle r="4" fill="#22D3EE" className="pitch-fee-svg-dot">
                  <animateMotion dur="3.2s" begin="2.1s" repeatCount="indefinite">
                    <mpath href="#feePathRight" />
                  </animateMotion>
                  <animate
                    attributeName="opacity"
                    values="0;1;1;0"
                    keyTimes="0;0.1;0.9;1"
                    dur="3.2s"
                    begin="2.1s"
                    repeatCount="indefinite"
                  />
                </circle>
              </svg>
            </div>

            <div className="pitch-fee-buckets">
              <div className="pitch-money-pill">LP vault</div>
              <div className="pitch-money-pill">Creator</div>
              <div className="pitch-money-pill pitch-money-pill-cyan">
                Protocol → PERC stakers
              </div>
            </div>
          </div>
        </div>

        <div className="pitch-money-econ">
          <div className="pitch-money-econ-stat">
            <div className="pitch-money-econ-num mono">&gt;95%</div>
            <div className="pitch-money-econ-label">Gross margin per trade after Solana RPC + compute</div>
          </div>
          <div className="pitch-money-econ-stat">
            <div className="pitch-money-econ-num mono">&lt;$0.001</div>
            <div className="pitch-money-econ-label">Compute cost per trade</div>
          </div>
          <div className="pitch-money-econ-stat">
            <div className="pitch-money-econ-num mono">$0</div>
            <div className="pitch-money-econ-label">Outside capital required to keep shipping today</div>
          </div>
        </div>

        <div className="pitch-money-scale-wrap">
          <div className="pitch-money-scale-title">Scale path · protocol fees only · projected scenarios</div>
          <table className="pitch-money-scale">
            <thead>
              <tr>
                <th>Markets</th>
                <th>Avg daily vol / market</th>
                <th>Protocol fee (0.1%)</th>
                <th>Daily protocol fees</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">100</td>
                <td className="mono">$500K</td>
                <td className="mono">0.1%</td>
                <td className="mono pitch-money-scale-result">$50K</td>
              </tr>
              <tr>
                <td className="mono">1,000</td>
                <td className="mono">$500K</td>
                <td className="mono">0.1%</td>
                <td className="mono pitch-money-scale-result">$500K</td>
              </tr>
              <tr>
                <td className="mono">1,000</td>
                <td className="mono">$1M</td>
                <td className="mono">0.1%</td>
                <td className="mono pitch-money-scale-result">$1M</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Slide 7 · Opportunity ───────────────────────────────────────────────────

function Slide07Opportunity(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Opportunity</div>
        <h2 className="pitch-title">
          Solana perp volume runs $2–4B per month across ~50 blue-chip
          tokens; 15 million tokens have zero perp access today.
        </h2>

        <div className="pitch-opp-compare">
          <div className="pitch-opp-row">
            <div className="pitch-opp-row-header">
              <span className="pitch-opp-tag">Today</span>
              <span className="pitch-opp-row-stat mono">$2–4B / month</span>
              <span className="pitch-opp-row-detail">
                ~50 tokens · all blue chips · contested
              </span>
            </div>
            <div className="pitch-opp-bar-wrap">
              <div className="pitch-opp-bar pitch-opp-bar-today" />
            </div>
          </div>

          <div className="pitch-opp-row">
            <div className="pitch-opp-row-header">
              <span className="pitch-opp-tag pitch-opp-tag-cyan">Opportunity</span>
              <span className="pitch-opp-row-stat mono">15,000,000+ tokens</span>
              <span className="pitch-opp-row-detail">
                Every token with a live DEX pool · untouched · empty market
              </span>
            </div>
            <div className="pitch-opp-bar-wrap">
              <div className="pitch-opp-bar pitch-opp-bar-opportunity" />
            </div>
          </div>

          <div className="pitch-opp-callout">
            Same axis. The &ldquo;today&rdquo; bar is barely visible. The
            full-width bar is the gap we open.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide 8 · Competitors ───────────────────────────────────────────────────

function Slide08Competitors(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Competitors</div>
        <h2 className="pitch-title">
          No major Solana perp DEX lists tokens permissionlessly. We are the only protocol that does.
        </h2>
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
                <td className="pitch-matrix-feature">On-chain oracle (no Pyth dep.)</td>
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
                <td className="pitch-matrix-feature">Market-creator fees</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature">Open source (Apache 2.0)</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-no">partial</td>
                <td className="pitch-matrix-no">✗</td>
                <td className="pitch-matrix-yes pitch-matrix-us">✓</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="pitch-matrix-sub">
          Everyone else competes for the same 30-50 tokens. We open a category.
        </p>
      </div>
    </div>
  );
}

// ─── Slide 9 · GTM & Why Now ─────────────────────────────────────────────────

function Slide09WhyNow(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">GTM & Why Now</div>
        <h2 className="pitch-title">
          SIMD-0266 and Token-2022 both landed in 2026, making per-trade
          economics work for long-tail tokens for the first time.
        </h2>
        <div className="pitch-whynow-stats">
          <div className="pitch-whynow-stat">
            <svg viewBox="0 0 24 24" className="pitch-catalyst-icon" aria-hidden>
              <path
                d="M 6 8 L 12 14 L 18 8"
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M 6 14 L 12 20 L 18 14"
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.45"
              />
            </svg>
            <div className="pitch-whynow-num mono">SIMD-0266</div>
            <div className="pitch-whynow-label">
              Activated April 2026. Pinocchio-token instructions are 18×
              cheaper. Long-tail per-trade economics only work after this
              change.
            </div>
          </div>
          <div className="pitch-whynow-stat">
            <svg viewBox="0 0 24 24" className="pitch-catalyst-icon" aria-hidden>
              <rect
                x="4"
                y="4"
                width="16"
                height="16"
                rx="2"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.8"
              />
              <circle cx="12" cy="12" r="3.5" fill="currentColor" />
            </svg>
            <div className="pitch-whynow-num mono">Token-2022</div>
            <div className="pitch-whynow-label">
              Mature now. Transferable perp positions as NFTs are
              possible. We&apos;re the first to ship.
            </div>
          </div>
          <div className="pitch-whynow-stat">
            <svg viewBox="0 0 24 24" className="pitch-catalyst-icon" aria-hidden>
              <path
                d="M 4 18 L 9 12 L 13 15 L 20 6"
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M 16 6 L 20 6 L 20 10"
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="pitch-whynow-num mono">$793M</div>
            <div className="pitch-whynow-label">
              Hyperliquid OI in 3 months proved demand for permissionless
              perps. They priced creators out at $19-25M. Long-tail supply
              is empty.
            </div>
          </div>
        </div>
        <div className="pitch-whynow-closing">
          GTM: closed beta on mainnet now → external audit through Q3
          → permissionless public launch with the first 10 creator-led
          markets seeded by revenue-share rebates → Jupiter / Birdeye /
          pump.fun routing once on-chain volume validates the model.
        </div>
      </div>
    </div>
  );
}

// ─── Slide 10 · Roadmap ──────────────────────────────────────────────────────

function Slide10Roadmap(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Roadmap</div>
        <h2 className="pitch-title">
          Public mainnet launches in Q3 after the audit; targeting $50M+
          daily volume by Q4 2026.
        </h2>
        <div className="pitch-roadmap">
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase purple">Q2 2026</div>
            <div className="pitch-roadmap-name">Closed beta · audit kickoff</div>
            <div className="pitch-roadmap-desc">Mainnet program v12.17 live to closed beta, external audit started, mobile beta</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase cyan">Q3 2026</div>
            <div className="pitch-roadmap-name">Public mainnet</div>
            <div className="pitch-roadmap-desc">Audit complete, Jupiter / Birdeye, pump.fun creator markets</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase purple">Q4 2026</div>
            <div className="pitch-roadmap-name">$50M+ daily volume</div>
            <div className="pitch-roadmap-desc">Cross-margining, composable CPI oracle</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase cyan">2027</div>
            <div className="pitch-roadmap-name">Default rail</div>
            <div className="pitch-roadmap-desc">Every-token perps as default for any new SPL</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide 11 · Risks ────────────────────────────────────────────────────────

function Slide11Risks(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Risks</div>
        <h2 className="pitch-title">
          Three real risks we&apos;re solving, each with a concrete
          mitigation already in flight.
        </h2>

        <div className="pitch-risks-grid">
          <div className="pitch-risks-card">
            <div className="pitch-risks-name">Liquidity bootstrap</div>
            <p className="pitch-risks-desc">
              Long-tail markets are illiquid by definition until creators
              bring traffic.
            </p>
            <div className="pitch-risks-mitigation-label mono">Mitigation</div>
            <p className="pitch-risks-mitigation">
              Creator fee share = direct financial incentive for creators
              to bring their own community. Rev-share rebates fund the
              first 10 markets at launch.
            </p>
          </div>

          <div className="pitch-risks-card">
            <div className="pitch-risks-name">Audit timing</div>
            <p className="pitch-risks-desc">
              Public mainnet trading is gated on the Q3 external audit;
              any slip pushes launch.
            </p>
            <div className="pitch-risks-mitigation-label mono">Mitigation</div>
            <p className="pitch-risks-mitigation">
              Pre-audit hardening sprint already closed every internal
              CRITICAL/HIGH; 457 Kani proofs verify the risk-engine
              invariants before the audit firm even starts.
            </p>
          </div>

          <div className="pitch-risks-card">
            <div className="pitch-risks-name">Regulatory drift</div>
            <p className="pitch-risks-desc">
              Perps regulation is unsettled globally. A hostile reading
              would kneecap a centralised competitor.
            </p>
            <div className="pitch-risks-mitigation-label mono">Mitigation</div>
            <p className="pitch-risks-mitigation">
              Protocol is permissionless by design. No gatekeeping
              action, no team in the loop on listing decisions, no party
              to regulate.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide 12 · Next Steps (Ask + Exit) ──────────────────────────────────────

function Slide12NextSteps(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Next Steps</div>
        <h2 className="pitch-title">
          We&apos;re shipping with or without capital. The right
          partner shortcuts the audit, market-maker bootstrap, and
          creator acquisition.
        </h2>

        <div className="pitch-ask-grid">
          <div className="pitch-ask-card">
            <div className="pitch-ask-card-label mono">Open to</div>
            <div className="pitch-ask-card-headline">
              Strategic capital, sized to the partnership.
            </div>
            <div className="pitch-ask-card-sub">
              SAFE, token warrant on PERC, LP co-investment, or bespoke.
              We care more about the partner than the paper.
            </div>
          </div>
          <div className="pitch-ask-card">
            <div className="pitch-ask-card-label mono">Where it goes</div>
            <ul className="pitch-ask-list">
              <li>External audit + bug bounty program</li>
              <li>Market-maker bootstrap on first 10 markets</li>
              <li>Creator acquisition (rev-share rebates, not paid spend)</li>
              <li>Two technical hires: matching + risk research</li>
            </ul>
          </div>
        </div>

        <div className="pitch-ask-exit-wrap">
          <div className="pitch-ask-exit-title mono">Liquidity path for capital</div>
          <div className="pitch-ask-exit-grid">
            <div className="pitch-ask-exit-item">
              <div className="pitch-ask-exit-name">Primary</div>
              <p className="pitch-ask-exit-desc">
                Protocol-fee-backed token. PERC stakers earn from real fee revenue once mainnet trading opens.
              </p>
            </div>
            <div className="pitch-ask-exit-item">
              <div className="pitch-ask-exit-name">Secondary</div>
              <p className="pitch-ask-exit-desc">
                PERC trades on the existing creator-rewards market today; deeper venues post-mainnet.
              </p>
            </div>
            <div className="pitch-ask-exit-item">
              <div className="pitch-ask-exit-name">Optional backstop</div>
              <p className="pitch-ask-exit-desc">
                Drift, Jupiter, and Hyperliquid all have a structural interest in long-tail listing capability they can&apos;t ship internally. M&amp;A is an option, not the plan.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide 13 · Contact ──────────────────────────────────────────────────────

function Slide13Contact(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner pitch-center">
        <div className="pitch-label">Contact</div>
        <h2 className="pitch-title">
          The code is fully open source under Apache 2.0, the market is
          in closed beta on mainnet, and the door is open at
          percolator.trade.
        </h2>
        <p
          className="pitch-body-text"
          style={{ maxWidth: "640px", marginBottom: "2rem" }}
        >
          The closed beta is small and pre-audit. Fork the code under
          Apache 2.0 across all 8 public repos, or DM us on X. We answer.
        </p>
        <div className="pitch-contact-grid">
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Try it</div>
            <div className="pitch-contact-value">percolator.trade</div>
          </div>
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Code</div>
            <div className="pitch-contact-value">github.com/percolator</div>
          </div>
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Talk</div>
            <div className="pitch-contact-value">@PercolatorLaunch</div>
          </div>
        </div>
        <div className="pitch-divider" />
        <p className="pitch-url">percolator.trade</p>
      </div>
    </div>
  );
}

// ─── Slide 3 · Toly Story ────────────────────────────────────────────────────

function SlideTolyStory(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Origin · Toly Signal</div>
        <h2 className="pitch-title">
          Solana co-founder Anatoly Yakovenko founded Percolator and
          publicly engages with our team&apos;s work. He authored the
          protocol math; we built the product around it.
        </h2>

        <div className="pitch-toly-photo-grid">
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — Squid bug fix, April 29"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo1.jpg"
              alt="Toly tweet quote-RTing Squid's GitHub issue: 'big brain bug'"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly · Apr 29</span>
              <span>Squid&apos;s KeeperCrank fix</span>
            </div>
          </a>
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — Khubair bounty 3 critical, May 7"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo2.jpg"
              alt="Toly tweet with brain emojis on Khubair's bounty 3 critical issue"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly · May 7</span>
              <span>Khubair&apos;s bounty 3 critical</span>
            </div>
          </a>
          <a
            className="pitch-toly-photo"
            href="https://x.com/toly"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Toly tweet — percolator-stake repo signal, Feb 19"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/toly/photo3.jpg"
              alt="Toly tweet RTing dcccrypto/percolator-stake: 'Look, a contribution! Don't trust, verify!'"
            />
            <div className="pitch-toly-photo-cap mono">
              <span>@toly · Feb 19</span>
              <span>&ldquo;Don&apos;t trust, verify&rdquo;</span>
            </div>
          </a>
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
              <span>@toly · Feb 13</span>
              <span>&ldquo;Percolator is a job creator&rdquo;</span>
            </div>
          </a>
        </div>

        <p className="pitch-toly-footer">
          Toly authored the protocol math and the reference program
          (github.com/aeyakovenko/percolator-prog). We built the
          frontend, SDK, indexer, keeper fleet, and infra around it.
          Both co-founders have each won one of his public bounties.
        </p>
      </div>
    </div>
  );
}

// ─── Slide 6 · Kani Formal Verification ──────────────────────────────────────

function SlideKaniProofs(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Formal Verification</div>
        <h2 className="pitch-title">
          Kani proves protocol invariants hold across every possible
          input. 457 proofs, all green, before any auditor starts.
        </h2>

        <div className="pitch-kani-callout">
          <div className="pitch-kani-callout-num mono">
            <NumberCounter target={457} />
          </div>
          <div className="pitch-kani-callout-label">
            formal proofs · all green · same model-checking technology
            used in NASA &amp; aerospace systems, applied to the
            Percolator risk engine
          </div>
        </div>

        <div className="pitch-kani-what">
          <div className="pitch-kani-what-card">
            <div className="pitch-kani-what-name">Haircut conservation</div>
            <p className="pitch-kani-what-desc">
              The H mechanism never lets profitable accounts extract
              more than the vault holds. Proven across every state and
              price.
            </p>
          </div>
          <div className="pitch-kani-what-card">
            <div className="pitch-kani-what-name">ADL fairness</div>
            <p className="pitch-kani-what-desc">
              A/K coefficients socialise position reduction equally
              across each side. No queue, no first-mover advantage,
              ever.
            </p>
          </div>
          <div className="pitch-kani-what-card">
            <div className="pitch-kani-what-name">Funding zero-sum</div>
            <p className="pitch-kani-what-desc">
              Funding settles to net zero across all accounts at every
              step. Money in equals money out, provably.
            </p>
          </div>
        </div>

        <div className="pitch-kani-vs">
          <div className="pitch-kani-vs-title mono">
            Formal proofs in production · perp DEXs on Solana
          </div>
          <div className="pitch-kani-vs-row">
            <div className="pitch-kani-vs-cell">
              <div className="pitch-kani-vs-cell-num mono">0</div>
              <div className="pitch-kani-vs-cell-label">Hyperliquid</div>
            </div>
            <div className="pitch-kani-vs-cell">
              <div className="pitch-kani-vs-cell-num mono">0</div>
              <div className="pitch-kani-vs-cell-label">Drift</div>
            </div>
            <div className="pitch-kani-vs-cell">
              <div className="pitch-kani-vs-cell-num mono">0</div>
              <div className="pitch-kani-vs-cell-label">Jupiter Perps</div>
            </div>
            <div className="pitch-kani-vs-cell pitch-kani-vs-cell-us">
              <div className="pitch-kani-vs-cell-num mono">457</div>
              <div className="pitch-kani-vs-cell-label">Percolator</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide Registry ───────────────────────────────────────────────────────────

const SLIDES = [
  { id: 1, title: "One-Liner", component: Slide01OneLiner },
  { id: 2, title: "Team", component: Slide02Team },
  { id: 3, title: "Toly Signal", component: SlideTolyStory },
  { id: 4, title: "Traction", component: Slide03Traction },
  { id: 5, title: "Hackathon Engineering Sprint", component: Slide04Sprint },
  { id: 6, title: "Formal Verification", component: SlideKaniProofs },
  { id: 7, title: "Demo Product", component: Slide05Product },
  { id: 8, title: "Business Model", component: Slide06Money },
  { id: 9, title: "Opportunity", component: Slide07Opportunity },
  { id: 10, title: "Competitors", component: Slide08Competitors },
  { id: 11, title: "GTM & Why Now", component: Slide09WhyNow },
  { id: 12, title: "Roadmap", component: Slide10Roadmap },
  { id: 13, title: "Risks", component: Slide11Risks },
  { id: 14, title: "Next Steps", component: Slide12NextSteps },
  { id: 15, title: "Contact", component: Slide13Contact },
];

const TOTAL_SLIDES = SLIDES.length;

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
      <div
        className="pitch-deck-overlay"
        onClick={next}
        role="presentation"
      >
        <AuroraBackground />
        <DripLine />
        <div key={current} className="pitch-slide-stage">
          <SlideComponent isCurrent />
        </div>

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

      <style>{`
        /* ─────────────────────────────────────────────────────────────
           LIQUID DRIP · visual identity layer
           Subtle by default. Pauses on prefers-reduced-motion.
           ───────────────────────────────────────────────────────────── */

        .pitch-aurora {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 0;
          overflow: hidden;
        }

        .pitch-aurora::before,
        .pitch-aurora::after {
          content: "";
          position: absolute;
          width: 60vw;
          height: 60vh;
          border-radius: 50%;
          filter: blur(80px);
          opacity: 0.10;
          will-change: transform;
        }

        .pitch-aurora::before {
          top: -20vh;
          right: -15vw;
          background: #9945FF;
          animation: aurora-drift-a 32s ease-in-out infinite;
        }

        .pitch-aurora::after {
          bottom: -20vh;
          left: -15vw;
          background: #22D3EE;
          animation: aurora-drift-b 38s ease-in-out infinite reverse;
        }

        @keyframes aurora-drift-a {
          0%, 100% { transform: translate(0, 0); }
          50%      { transform: translate(-12vw, 8vh); }
        }
        @keyframes aurora-drift-b {
          0%, 100% { transform: translate(0, 0); }
          50%      { transform: translate(12vw, -8vh); }
        }

        .pitch-drip-line {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 22px;
          width: 1px;
          z-index: 1;
          pointer-events: none;
          background: linear-gradient(
            to bottom,
            transparent 0%,
            rgba(153, 69, 255, 0.22) 18%,
            rgba(34, 211, 238, 0.22) 82%,
            transparent 100%
          );
        }

        .pitch-drip-dot {
          position: absolute;
          left: -3px;
          top: 0;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #22D3EE;
          box-shadow: 0 0 8px rgba(34, 211, 238, 0.55);
          animation: drip-fall 6.5s cubic-bezier(0.36, 0, 0.66, 0.4) infinite;
          will-change: transform, opacity;
        }

        @keyframes drip-fall {
          0%   { transform: translateY(0);    opacity: 0; }
          8%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { transform: translateY(100vh); opacity: 0; }
        }

        /* ── Slide stage: re-mounts on slide change via key, retriggers entrance ── */
        .pitch-slide-stage {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          position: relative;
          z-index: 2;
          animation: slide-enter 420ms cubic-bezier(0.22, 1, 0.36, 1);
        }

        @keyframes slide-enter {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ── Reduced motion: stop ambient + entrance animations ── */
        @media (prefers-reduced-motion: reduce) {
          .pitch-drip-dot,
          .pitch-aurora::before,
          .pitch-aurora::after,
          .pitch-slide-stage {
            animation: none !important;
          }
        }

        /* ─────────────────────────────────────────────────────────────
           Original deck styles below.
           ───────────────────────────────────────────────────────────── */

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
        .pitch-hero-sub {
          font-family: 'Inter', sans-serif;
          font-size: clamp(1.2rem, 2.5vw, 1.6rem);
          color: rgba(255,255,255,0.6);
          line-height: 1.5;
          max-width: 620px;
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
          font-size: clamp(1.4rem, 3vw, 2.2rem);
          font-weight: 700;
          letter-spacing: -0.02em;
          line-height: 1.3;
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

        /* ── Solution / How It Works stack ── */
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

        .pitch-solution-sub {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1rem;
          font-weight: 600;
          color: rgba(34,211,238,0.85);
          letter-spacing: -0.01em;
          line-height: 1.55;
        }

        /* ── Live Product flow ── */
        .pitch-create-footer {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1rem;
          font-weight: 700;
          color: #22D3EE;
          letter-spacing: -0.01em;
          margin-top: 1.5rem;
        }

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

        .pflow-num-wrap { margin-bottom: 0.5rem; }

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

        .pflow-live-id { color: #22D3EE; }

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

        .pflow-arrow-svg { display: block; }

        /* ── Why Now ── */
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
          font-size: clamp(1.4rem, 2.4vw, 2rem);
          font-weight: 700;
          color: #9945FF;
          margin-bottom: 0.5rem;
          line-height: 1.1;
        }

        .pitch-whynow-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.6);
          line-height: 1.5;
          text-align: left;
        }

        .pitch-whynow-closing {
          font-family: 'Inter', sans-serif;
          font-size: clamp(0.9rem, 1.5vw, 1rem);
          color: rgba(255,255,255,0.65);
          line-height: 1.65;
          max-width: 760px;
          border-left: 3px solid #22D3EE;
          padding-left: 1.25rem;
        }

        /* ── Opportunity ── */
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

        /* ── Competitors Matrix ── */
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

        .pitch-matrix th:first-child { text-align: left; }

        .pitch-matrix tbody tr {
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        .pitch-matrix tbody tr:last-child { border-bottom: none; }

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

        /* ── Business Model ── */
        .pitch-money-flow {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.25rem 1.25rem 1.5rem;
          margin-bottom: 1.5rem;
        }

        .pitch-money-flow-title {
          font-family: 'Inter', sans-serif;
          font-size: 0.78rem;
          color: rgba(255,255,255,0.45);
          margin-bottom: 1rem;
          text-align: center;
          letter-spacing: 0.02em;
        }

        .pitch-money-flow-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: 0.6rem;
          row-gap: 0.75rem;
        }

        .pitch-money-pill {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 0.65rem 1rem;
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.85);
          font-weight: 600;
          text-align: center;
          line-height: 1.3;
        }

        .pitch-money-pill-purple {
          border-color: rgba(153,69,255,0.4);
          background: rgba(153,69,255,0.08);
          color: #fff;
        }

        .pitch-money-pill-cyan {
          border-color: rgba(34,211,238,0.4);
          background: rgba(34,211,238,0.08);
          color: #fff;
        }

        .pitch-money-arrow {
          font-family: 'JetBrains Mono', monospace;
          color: rgba(255,255,255,0.35);
          font-size: 1rem;
        }

        .pitch-money-econ {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
          margin-bottom: 1.5rem;
        }

        .pitch-money-econ-stat {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 1rem 1.25rem;
          text-align: center;
        }

        .pitch-money-econ-num {
          font-size: clamp(1.4rem, 2.4vw, 1.9rem);
          font-weight: 700;
          color: #22D3EE;
          line-height: 1.1;
          margin-bottom: 0.4rem;
        }

        .pitch-money-econ-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.78rem;
          color: rgba(255,255,255,0.45);
          line-height: 1.4;
        }

        .pitch-money-scale-wrap {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 12px;
          padding: 1rem 1.25rem 1.25rem;
        }

        .pitch-money-scale-title {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.85rem;
          font-weight: 700;
          color: rgba(255,255,255,0.7);
          margin-bottom: 0.75rem;
          letter-spacing: 0.01em;
        }

        .pitch-money-scale {
          width: 100%;
          border-collapse: collapse;
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
        }

        .pitch-money-scale thead th {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.72rem;
          font-weight: 600;
          color: rgba(255,255,255,0.4);
          text-align: left;
          padding: 0.4rem 0.6rem;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .pitch-money-scale tbody td {
          padding: 0.5rem 0.6rem;
          color: rgba(255,255,255,0.7);
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }

        .pitch-money-scale tbody tr:last-child td { border-bottom: none; }

        .pitch-money-scale-result {
          color: #22D3EE !important;
          font-weight: 700;
        }

        /* ── Traction (Slide 3) ── */
        .pitch-traction-chart-wrap {
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 14px;
          padding: 1.5rem 1.5rem 1.25rem;
          margin-bottom: 1.5rem;
        }

        .pitch-traction-chart-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          margin-bottom: 1rem;
          gap: 1rem;
        }

        .pitch-traction-chart-title {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1rem;
          font-weight: 600;
          color: #fff;
        }

        .pitch-traction-chart-sub {
          font-size: 0.7rem;
          color: rgba(255,255,255,0.4);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-top: 0.2rem;
        }

        .pitch-traction-illus {
          color: rgba(255,165,0,0.7);
        }

        .pitch-traction-chart-stat {
          text-align: right;
        }

        .pitch-traction-chart-stat-num {
          font-size: 1.4rem;
          font-weight: 700;
          background: linear-gradient(90deg, #9945FF, #22D3EE);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .pitch-traction-chart-stat-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.7rem;
          color: rgba(255,255,255,0.4);
          margin-top: 0.15rem;
        }

        .pitch-traction-chart-svg {
          width: 100%;
          height: 200px;
          display: block;
        }

        .pitch-traction-chart-axis {
          display: flex;
          justify-content: space-between;
          font-size: 0.65rem;
          color: rgba(255,255,255,0.3);
          margin-top: 0.6rem;
          letter-spacing: 0.05em;
        }

        .pitch-traction-mini-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.75rem;
        }

        /* ─── Slide 3 · network proof cards ───────────────────────── */

        .pitch-traction-network-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1rem;
          margin-bottom: 1.25rem;
        }

        .pitch-traction-network-card {
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 1.1rem 1.25rem;
        }

        .pitch-traction-network-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
          flex-wrap: wrap;
          gap: 0.5rem;
        }

        .pitch-traction-network-tag {
          font-size: 0.65rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153, 69, 255, 0.85);
          padding: 0.3rem 0.6rem;
          background: rgba(153, 69, 255, 0.1);
          border: 1px solid rgba(153, 69, 255, 0.25);
          border-radius: 4px;
        }

        .pitch-traction-network-tag-cyan {
          color: rgba(34, 211, 238, 0.95);
          background: rgba(34, 211, 238, 0.1);
          border-color: rgba(34, 211, 238, 0.3);
        }

        .pitch-traction-network-link {
          font-size: 0.72rem;
          color: rgba(34, 211, 238, 0.7);
          text-decoration: none;
          letter-spacing: 0.05em;
          transition: color 200ms ease;
        }

        .pitch-traction-network-link:hover {
          color: #22D3EE;
          text-decoration: underline;
        }

        .pitch-traction-network-stats {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.85rem;
          margin-bottom: 0.85rem;
        }

        .pitch-traction-network-stats-three {
          grid-template-columns: repeat(3, 1fr);
        }

        .pitch-traction-network-grid-single {
          grid-template-columns: 1fr;
          max-width: 760px;
          margin-left: auto;
          margin-right: auto;
        }

        .pitch-traction-network-card-wide {
          padding: 1.5rem 1.75rem;
        }

        .pitch-traction-network-stat {
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px;
          padding: 0.85rem 1rem;
          text-align: center;
        }

        .pitch-traction-network-num {
          font-size: clamp(1.6rem, 2.6vw, 2.1rem);
          font-weight: 700;
          color: #fff;
          line-height: 1;
          margin-bottom: 0.3rem;
          letter-spacing: -0.02em;
        }

        .pitch-traction-network-num-cyan {
          color: #22D3EE;
        }

        .pitch-traction-network-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.55);
        }

        .pitch-traction-network-meta {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.4);
          line-height: 1.45;
          letter-spacing: 0.02em;
        }

        @media (max-width: 768px) {
          .pitch-traction-network-grid {
            grid-template-columns: 1fr;
          }
        }

        .pitch-traction-mini {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 0.9rem 1rem;
          text-align: center;
        }

        .pitch-traction-mini-num {
          font-size: 1.3rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.2rem;
        }

        .pitch-traction-mini-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.7rem;
          color: rgba(255,255,255,0.45);
          line-height: 1.3;
        }

        /* ── Risks (Slide 11) ── */
        .pitch-risks-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
        }

        .pitch-risks-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.25rem 1.25rem;
          display: flex;
          flex-direction: column;
        }

        .pitch-risks-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.05rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.5rem;
        }

        .pitch-risks-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.55);
          line-height: 1.55;
          margin: 0 0 1rem;
        }

        .pitch-risks-mitigation-label {
          font-size: 0.62rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(34,211,238,0.7);
          margin-bottom: 0.4rem;
        }

        .pitch-risks-mitigation {
          font-family: 'Inter', sans-serif;
          font-size: 0.82rem;
          color: rgba(255,255,255,0.65);
          line-height: 1.55;
          margin: 0;
        }

        /* ── Team ── */
        .pitch-team-tier-label {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(34,211,238,0.7);
          margin-bottom: 0.75rem;
        }

        .pitch-team-grid {
          display: grid;
          gap: 1.25rem;
        }

        .pitch-team-grid-two {
          grid-template-columns: repeat(2, 1fr);
        }

        .pitch-team-grid-three {
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
        }

        .pitch-team-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.25rem 1.25rem;
        }

        .pitch-team-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.15rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.25rem;
        }

        .pitch-team-role {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #22D3EE;
          margin-bottom: 0.9rem;
        }

        .pitch-team-bio {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          line-height: 1.55;
          color: rgba(255,255,255,0.6);
          margin: 0;
        }

        .pitch-team-links {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          line-height: 1.5;
          margin: 0.85rem 0 0;
          color: rgba(34,211,238,0.5);
          word-break: break-all;
        }

        .pitch-team-links a {
          color: rgba(34,211,238,0.85);
          text-decoration: none;
          transition: color 0.15s ease;
        }

        .pitch-team-links a:hover {
          color: #22D3EE;
          text-decoration: underline;
        }

        .pitch-team-bio-link {
          color: rgba(34, 211, 238, 0.9);
          text-decoration: none;
          border-bottom: 1px dotted rgba(34, 211, 238, 0.45);
          transition: color 200ms ease, border-color 200ms ease;
        }

        .pitch-team-bio-link:hover {
          color: #22D3EE;
          border-bottom-color: rgba(34, 211, 238, 0.85);
        }

        /* ─── Slide 1 hero bullets ──────────────────────────────────── */

        .pitch-hero-headline {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: clamp(1.6rem, 3.2vw, 2.4rem);
          font-weight: 800;
          letter-spacing: -0.02em;
          line-height: 1.2;
          color: #fff;
          margin-bottom: 2rem;
          text-align: center;
        }

        .pitch-hero-bullets {
          list-style: none;
          margin: 0 0 1.5rem;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
          width: 100%;
          max-width: 520px;
        }

        .pitch-hero-bullets li {
          display: flex;
          align-items: baseline;
          gap: 1.25rem;
          padding: 0.85rem 1.4rem;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          text-align: left;
          transition: border-color 220ms ease, background 220ms ease;
        }

        @media (hover: hover) {
          .pitch-hero-bullets li:hover {
            border-color: rgba(34, 211, 238, 0.3);
            background: rgba(255, 255, 255, 0.04);
          }
        }

        .pitch-hero-bullet-num {
          font-size: 1.35rem;
          font-weight: 700;
          background: linear-gradient(135deg, #9945FF, #22D3EE);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          min-width: 86px;
          flex-shrink: 0;
          letter-spacing: -0.01em;
        }

        .pitch-hero-bullet-text {
          font-family: 'Inter', sans-serif;
          font-size: 1rem;
          color: rgba(255, 255, 255, 0.72);
          line-height: 1.4;
        }

        /* ─── Team PFPs ────────────────────────────────────────────── */

        .pitch-team-pfp {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          border: 2px solid rgba(34, 211, 238, 0.22);
          margin-bottom: 0.75rem;
          display: block;
          object-fit: cover;
          background: rgba(255, 255, 255, 0.04);
        }

        /* ─── Slide 3 · Toly Story cards ──────────────────────────── */

        .pitch-toly-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
          margin-bottom: 1.5rem;
        }

        .pitch-toly-card {
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 12px;
          padding: 1.25rem 1.25rem 1rem;
          transition:
            transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
            border-color 220ms ease,
            background 220ms ease;
        }

        @media (hover: hover) {
          .pitch-toly-card:hover {
            transform: translateY(-2px);
            border-color: rgba(34, 211, 238, 0.28);
            background: rgba(255, 255, 255, 0.035);
          }
        }

        .pitch-toly-card-bounty {
          border-left: 2px solid rgba(34, 211, 238, 0.5);
        }

        .pitch-toly-card-built {
          border-left: 2px solid rgba(153, 69, 255, 0.6);
          background: rgba(153, 69, 255, 0.04);
        }

        .pitch-toly-card-label {
          font-size: 0.65rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(34, 211, 238, 0.78);
          margin-bottom: 0.55rem;
        }

        .pitch-toly-card-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.05rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.6rem;
        }

        .pitch-toly-card-link {
          color: inherit;
          text-decoration: none;
          border-bottom: 1px dotted rgba(34, 211, 238, 0.5);
          transition: color 200ms ease, border-color 200ms ease;
        }

        .pitch-toly-card-link:hover {
          color: #22D3EE;
          border-bottom-color: rgba(34, 211, 238, 0.9);
        }

        /* ─── Toly tweet-screenshot 2x2 grid ────────────────────── */

        .pitch-toly-photo-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.85rem;
          margin-bottom: 1.25rem;
        }

        .pitch-toly-photo {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          padding: 0.6rem;
          text-decoration: none;
          color: inherit;
          transition:
            transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
            border-color 220ms ease,
            box-shadow 220ms ease;
        }

        @media (hover: hover) {
          .pitch-toly-photo:hover {
            transform: translateY(-2px);
            border-color: rgba(34, 211, 238, 0.32);
            box-shadow: 0 8px 24px rgba(34, 211, 238, 0.06);
          }
        }

        .pitch-toly-photo img {
          width: 100%;
          height: 110px;
          object-fit: cover;
          object-position: top;
          border-radius: 6px;
          display: block;
        }

        .pitch-toly-photo-cap {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.65rem;
          color: rgba(255, 255, 255, 0.55);
          letter-spacing: 0.04em;
          padding: 0 0.2rem;
        }

        .pitch-toly-photo-cap span:first-child {
          color: rgba(34, 211, 238, 0.75);
          flex-shrink: 0;
        }

        .pitch-toly-photo-cap span:last-child {
          color: rgba(255, 255, 255, 0.7);
          text-align: right;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        @media (max-width: 768px) {
          .pitch-toly-photo-grid {
            grid-template-columns: 1fr;
          }
          .pitch-toly-photo img {
            height: 160px;
          }
        }

        .pitch-toly-card-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          line-height: 1.55;
          color: rgba(255, 255, 255, 0.62);
          margin: 0;
        }

        .pitch-toly-footer {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255, 255, 255, 0.55);
          font-style: italic;
          border-left: 2px solid rgba(34, 211, 238, 0.4);
          padding-left: 1rem;
          max-width: 760px;
          line-height: 1.55;
          margin: 0;
        }

        /* ─── Slide 6 · Kani Formal Verification ─────────────────── */

        .pitch-kani-callout {
          background: rgba(34, 211, 238, 0.05);
          border: 1px solid rgba(34, 211, 238, 0.22);
          border-radius: 12px;
          padding: 1.25rem 1.5rem;
          margin-bottom: 1.25rem;
          display: flex;
          align-items: center;
          gap: 1.5rem;
        }

        .pitch-kani-callout-num {
          font-size: clamp(2.4rem, 4vw, 3.2rem);
          font-weight: 700;
          color: #22D3EE;
          line-height: 1;
          flex-shrink: 0;
          letter-spacing: -0.02em;
        }

        .pitch-kani-callout-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.95rem;
          color: rgba(255, 255, 255, 0.7);
          line-height: 1.55;
        }

        .pitch-kani-what {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.85rem;
          margin-bottom: 1.25rem;
        }

        .pitch-kani-what-card {
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 10px;
          padding: 1rem 1.1rem;
          transition: border-color 220ms ease, background 220ms ease;
        }

        @media (hover: hover) {
          .pitch-kani-what-card:hover {
            border-color: rgba(34, 211, 238, 0.25);
            background: rgba(255, 255, 255, 0.035);
          }
        }

        .pitch-kani-what-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.4rem;
        }

        .pitch-kani-what-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.8rem;
          line-height: 1.5;
          color: rgba(255, 255, 255, 0.55);
          margin: 0;
        }

        .pitch-kani-vs {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 1rem 1.25rem;
        }

        .pitch-kani-vs-title {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153, 69, 255, 0.7);
          margin-bottom: 0.85rem;
        }

        .pitch-kani-vs-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.85rem;
        }

        .pitch-kani-vs-cell {
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px;
          padding: 0.85rem;
          text-align: center;
        }

        .pitch-kani-vs-cell-num {
          font-size: 1.7rem;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.4);
          line-height: 1;
          margin-bottom: 0.3rem;
        }

        .pitch-kani-vs-cell-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.5);
        }

        .pitch-kani-vs-cell-us {
          background: rgba(34, 211, 238, 0.08);
          border-color: rgba(34, 211, 238, 0.32);
        }

        .pitch-kani-vs-cell-us .pitch-kani-vs-cell-num {
          color: #22D3EE;
        }

        .pitch-kani-vs-cell-us .pitch-kani-vs-cell-label {
          color: #fff;
          font-weight: 700;
        }

        @media (max-width: 768px) {
          .pitch-toly-grid,
          .pitch-kani-what {
            grid-template-columns: 1fr;
          }
          .pitch-kani-vs-row {
            grid-template-columns: repeat(2, 1fr);
          }
          .pitch-kani-callout {
            flex-direction: column;
            text-align: center;
          }
          .pitch-hero-bullets li {
            gap: 0.85rem;
          }
          .pitch-hero-bullet-num {
            min-width: 72px;
            font-size: 1.2rem;
          }
        }

        .pitch-team-footer {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.5);
          padding-top: 1.25rem;
          margin: 1.5rem 0 0;
          border-top: 1px solid rgba(255,255,255,0.06);
          line-height: 1.55;
        }

        /* ── Roadmap ── */
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

        /* ── Next Steps / Ask ── */
        .pitch-ask-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1.25rem;
          margin-bottom: 1.5rem;
        }

        .pitch-ask-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.25rem 1.5rem;
        }

        .pitch-ask-card-label {
          font-size: 0.65rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153,69,255,0.7);
          margin-bottom: 0.6rem;
        }

        .pitch-ask-card-headline {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 1.4rem;
          font-weight: 800;
          color: #fff;
          margin-bottom: 0.5rem;
          letter-spacing: -0.01em;
        }

        .pitch-ask-card-sub {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.5);
          line-height: 1.5;
        }

        .pitch-ask-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255,255,255,0.65);
          line-height: 1.5;
        }

        .pitch-ask-list li {
          padding-left: 1rem;
          position: relative;
        }

        .pitch-ask-list li::before {
          content: "·";
          position: absolute;
          left: 0;
          color: rgba(34,211,238,0.6);
        }

        .pitch-ask-exit-wrap {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
          padding: 1.25rem 1.5rem;
        }

        .pitch-ask-exit-title {
          font-size: 0.65rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(34,211,238,0.7);
          margin-bottom: 0.85rem;
        }

        .pitch-ask-exit-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.25rem;
        }

        .pitch-ask-exit-item {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }

        .pitch-ask-exit-name {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
        }

        .pitch-ask-exit-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.82rem;
          line-height: 1.55;
          color: rgba(255,255,255,0.55);
          margin: 0;
        }

        /* ── Contact ── */
        .pitch-contact-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
          width: 100%;
          max-width: 720px;
          margin: 0 auto;
        }

        .pitch-contact-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 1rem 1.25rem;
          text-align: center;
        }

        .pitch-contact-label {
          font-size: 0.65rem;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153,69,255,0.7);
          margin-bottom: 0.4rem;
        }

        .pitch-contact-value {
          font-family: 'Inter Tight', 'Inter', sans-serif;
          font-size: 0.95rem;
          font-weight: 700;
          color: #fff;
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

        /* ─────────────────────────────────────────────────────────────
           Card hover states · subtle lift + cyan border glow
           Shared across every card family in the deck.
           ───────────────────────────────────────────────────────────── */

        .pitch-team-card,
        .pitch-traction-card,
        .pitch-traction-mini,
        .pitch-money-econ-stat,
        .pitch-whynow-stat,
        .pitch-roadmap-item,
        .pitch-ask-card,
        .pitch-contact-card,
        .pitch-risks-card,
        .pitch-solution-item {
          transition:
            transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
            border-color 220ms ease,
            box-shadow 220ms ease,
            background 220ms ease;
        }

        @media (hover: hover) {
          .pitch-team-card:hover,
          .pitch-traction-card:hover,
          .pitch-traction-mini:hover,
          .pitch-money-econ-stat:hover,
          .pitch-whynow-stat:hover,
          .pitch-roadmap-item:hover,
          .pitch-ask-card:hover,
          .pitch-contact-card:hover,
          .pitch-risks-card:hover,
          .pitch-solution-item:hover {
            transform: translateY(-2px);
            border-color: rgba(34, 211, 238, 0.28);
            box-shadow: 0 8px 24px rgba(34, 211, 238, 0.06);
            background: rgba(255, 255, 255, 0.035);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .pitch-team-card,
          .pitch-traction-card,
          .pitch-traction-mini,
          .pitch-money-econ-stat,
          .pitch-whynow-stat,
          .pitch-roadmap-item,
          .pitch-ask-card,
          .pitch-contact-card,
          .pitch-risks-card,
          .pitch-solution-item {
            transition: none !important;
          }
        }

        /* ─────────────────────────────────────────────────────────────
           Slide 3 · Traction chart line-draw + dot fade-in
           ───────────────────────────────────────────────────────────── */

        .pitch-traction-line {
          animation: traction-line-draw 1400ms cubic-bezier(0.4, 0, 0.2, 1) 200ms forwards;
        }

        @keyframes traction-line-draw {
          to { stroke-dashoffset: 0; }
        }

        .pitch-traction-dot {
          opacity: 0;
          animation: traction-dot-in 280ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        @keyframes traction-dot-in {
          to { opacity: 1; }
        }

        /* ─────────────────────────────────────────────────────────────
           Slide 6 · Animated fee flow (the brand moment)
           Drips from "Trader" through three channels into LP / Creator / Protocol.
           ───────────────────────────────────────────────────────────── */

        .pitch-fee-stage {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0;
        }

        .pitch-fee-source {
          display: flex;
          justify-content: center;
        }

        .pitch-fee-source .pitch-money-pill {
          min-width: 160px;
          text-align: center;
        }

        .pitch-fee-channel {
          position: relative;
          width: 480px;
          max-width: 100%;
          height: 140px;
          margin: 0 auto;
        }

        .pitch-fee-svg {
          width: 100%;
          height: 100%;
          display: block;
          overflow: visible;
        }

        .pitch-fee-svg-dot {
          filter: drop-shadow(0 0 6px rgba(34, 211, 238, 0.7));
        }

        .pitch-fee-buckets {
          display: flex;
          justify-content: space-between;
          gap: 1rem;
        }

        .pitch-fee-buckets .pitch-money-pill {
          flex: 1;
          text-align: center;
        }

        @media (prefers-reduced-motion: reduce) {
          .pitch-traction-line,
          .pitch-traction-dot {
            animation: none !important;
          }
          .pitch-traction-line { stroke-dashoffset: 0 !important; }
          .pitch-traction-dot { opacity: 1 !important; }
          .pitch-fee-svg-dot { display: none !important; }
        }

        /* ─────────────────────────────────────────────────────────────
           Slide 7 · Opportunity disparity bars
           ───────────────────────────────────────────────────────────── */

        .pitch-opp-compare {
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        .pitch-opp-row {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
        }

        .pitch-opp-row-header {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 1rem;
        }

        .pitch-opp-tag {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153, 69, 255, 0.85);
          padding: 0.35rem 0.65rem;
          background: rgba(153, 69, 255, 0.1);
          border: 1px solid rgba(153, 69, 255, 0.25);
          border-radius: 4px;
        }

        .pitch-opp-tag-cyan {
          color: rgba(34, 211, 238, 0.95);
          background: rgba(34, 211, 238, 0.1);
          border-color: rgba(34, 211, 238, 0.3);
        }

        .pitch-opp-row-stat {
          font-family: 'JetBrains Mono', monospace;
          font-size: clamp(1.4rem, 2.6vw, 2rem);
          font-weight: 700;
          color: #fff;
          letter-spacing: -0.01em;
        }

        .pitch-opp-row-detail {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255, 255, 255, 0.5);
        }

        .pitch-opp-bar-wrap {
          height: 8px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 4px;
          overflow: hidden;
        }

        .pitch-opp-bar {
          height: 100%;
          border-radius: 4px;
          transform: scaleX(0);
          transform-origin: left;
          animation: opp-bar-grow 1200ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        .pitch-opp-bar-today {
          width: 0.5%;
          min-width: 6px;
          background: rgba(153, 69, 255, 0.85);
          box-shadow: 0 0 8px rgba(153, 69, 255, 0.5);
          animation-delay: 200ms;
        }

        .pitch-opp-bar-opportunity {
          width: 100%;
          background: linear-gradient(90deg, #9945FF, #22D3EE);
          box-shadow: 0 0 12px rgba(34, 211, 238, 0.3);
          animation-delay: 500ms;
        }

        @keyframes opp-bar-grow {
          to { transform: scaleX(1); }
        }

        .pitch-opp-callout {
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          color: rgba(255, 255, 255, 0.5);
          font-style: italic;
          border-left: 2px solid rgba(34, 211, 238, 0.4);
          padding-left: 1rem;
          max-width: 580px;
          line-height: 1.5;
        }

        @media (prefers-reduced-motion: reduce) {
          .pitch-opp-bar {
            animation: none !important;
            transform: scaleX(1) !important;
          }
        }

        /* ─────────────────────────────────────────────────────────────
           Slide 8 · Matrix cell entrance, column-by-column stagger
           ───────────────────────────────────────────────────────────── */

        .pitch-matrix tbody td {
          animation: matrix-cell-in 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }

        .pitch-matrix tbody td:nth-child(2) { animation-delay: 100ms; }
        .pitch-matrix tbody td:nth-child(3) { animation-delay: 200ms; }
        .pitch-matrix tbody td:nth-child(4) { animation-delay: 300ms; }
        .pitch-matrix tbody td:nth-child(5) { animation-delay: 480ms; }

        @keyframes matrix-cell-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .pitch-matrix tbody td {
            animation: none !important;
            opacity: 1 !important;
            transform: none !important;
          }
        }

        /* ─────────────────────────────────────────────────────────────
           Slide 9 · Catalyst card icons
           ───────────────────────────────────────────────────────────── */

        .pitch-catalyst-icon {
          width: 28px;
          height: 28px;
          color: rgba(153, 69, 255, 0.7);
          margin-bottom: 0.85rem;
          display: block;
          margin-left: auto;
          margin-right: auto;
        }

        .pitch-whynow-stat:nth-child(2) .pitch-catalyst-icon {
          color: rgba(34, 211, 238, 0.7);
        }

        .pitch-whynow-stat:nth-child(3) .pitch-catalyst-icon {
          color: rgba(153, 69, 255, 0.7);
        }

        /* ─── PRINT STYLES ─── */
        @media print {
          .pitch-deck-overlay {
            position: static;
            display: block;
            background: #0D0D0F !important;
          }

          .pitch-controls,
          .pitch-dots,
          .pitch-aurora,
          .pitch-drip-line,
          .pitch-fee-svg-dot {
            display: none !important;
          }

          .pitch-slide-stage,
          .pitch-traction-line,
          .pitch-traction-dot,
          .pitch-opp-bar,
          .pitch-matrix tbody td {
            animation: none !important;
            opacity: 1 !important;
            transform: none !important;
            stroke-dashoffset: 0 !important;
          }

          .pitch-opp-bar-today,
          .pitch-opp-bar-opportunity {
            transform: scaleX(1) !important;
          }

          .pitch-slide {
            page-break-after: always;
            break-after: page;
            height: 100vh;
            min-height: 100vh;
            padding: 0;
          }

          /* Force colors to print correctly */
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }

        /* ─── Mobile ─── */
        @media (max-width: 768px) {
          .pitch-slide-inner { padding: 1.25rem 1rem; }

          .pitch-traction-mini-row {
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

          .pitch-roadmap {
            flex-direction: column;
            gap: 0.75rem;
          }

          .pitch-roadmap-connector {
            width: 2px;
            height: 20px;
            align-self: center;
          }

          .pflow-wrap {
            flex-direction: column;
            gap: 0.75rem;
          }

          .pflow-connector {
            width: auto;
            height: 32px;
            transform: rotate(90deg);
          }

          .pitch-team-grid-two,
          .pitch-team-grid-three {
            grid-template-columns: 1fr;
          }

          .pitch-money-econ {
            grid-template-columns: 1fr;
          }

          .pitch-ask-grid {
            grid-template-columns: 1fr;
          }

          .pitch-ask-exit-grid {
            grid-template-columns: 1fr;
          }

          .pitch-contact-grid {
            grid-template-columns: 1fr;
          }

          .pitch-risks-grid {
            grid-template-columns: 1fr;
          }

          /* Slide 6 fee flow: collapse to vertical stack on mobile */
          .pitch-fee-channel {
            height: 100px;
          }
          .pitch-fee-buckets {
            flex-direction: column;
            gap: 0.5rem;
          }
          .pitch-fee-buckets .pitch-money-pill {
            width: 100%;
          }

          /* Slide 7 opportunity: tighten gap */
          .pitch-opp-compare {
            gap: 1.5rem;
          }
          .pitch-opp-row-header {
            gap: 0.6rem;
          }

          /* Drip line moves closer on mobile */
          .pitch-drip-line { left: 12px; }
        }

        @media (max-width: 480px) {
          .pitch-traction-mini-row {
            grid-template-columns: 1fr;
          }

          .pitch-fee-channel { height: 80px; }
          .pitch-opp-row-stat { font-size: 1.4rem; }
        }
      `}</style>
    </>
  );
}
