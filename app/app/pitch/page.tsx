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
// 13 slides, restructured 2026-05-12 after senior-strategist audit + Reza review.
// Story arc: Hook → Problem → Team → Traction → Origin → Math → Product →
// Business → Moat → Why Now → GTM → Roadmap+Ask → Contact.
//
//   1  One-Liner
//   2  Problem (hack history: Drift v1, Mango, JELLY, Drift v2)
//   3  Team (roles re-titled; Toly attribution at bottom; stat strip)
//   4  Traction (devnet stats + mainnet line + 100+ waitlist hero)
//   5  Origin (Toly's bounties + how this came about; photo grid)
//   6  How the Math Works (A/K index, per-market isolation, warmup-H — leads
//      with Toly's contribution, not Kani proofs)
//   7  Demo Product (architectural primitives; screenshot placeholders)
//   8  Business Model (10 bps; scenario table; fee routing today vs Q3)
//   9  Moat (answers "where does value accrue when code is open?")
//  10  Why Now (Drift Apr 1 hack reframe; long-tail empty; shared-LP failing)
//  11  Go-to-Market (book depth, MM strategy, who you trade against)
//  12  Roadmap, Risks & Ask ($2M SAFE @ $20M post-money cap, 3 risks)
//  13  Contact
//
// Source of truth: this file. Previous v6 copy doc superseded.
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
          Permissionless perpetual futures on Solana &mdash; with risk
          math that prevents shared-LP wipeouts.
        </p>
        <p className="pitch-hero-body">
          Fewer than 50 Solana-native SPL tokens have a perp anywhere.
          Hundreds more have real spot liquidity but no leverage venue,
          because every existing perp DEX uses a shared LP pool and has
          to curate. Percolator isolates LP capital per market, so the
          long tail can finally list.
        </p>
        <p className="pitch-url">percolator.trade</p>
      </div>
      <div className="pitch-bg-grid" aria-hidden />
    </div>
  );
}

// ─── Slide · Problem ─────────────────────────────────────────────────────────

function SlideProblem(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Problem</div>
        <h2 className="pitch-title">
          Every Solana perp DEX uses a shared LP pool. That&apos;s why
          they&apos;re all curated, and why three of them have been
          drained.
        </h2>

        <div className="pitch-matrix-wrap">
          <table className="pitch-matrix">
            <thead>
              <tr>
                <th className="pitch-matrix-feature">When</th>
                <th>Venue</th>
                <th>Loss</th>
                <th>What broke</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="pitch-matrix-feature mono">May 2022</td>
                <td>Drift v1</td>
                <td className="pitch-matrix-no mono">$14.5M</td>
                <td>vAMM cascade during Terra collapse; shared insurance failed.</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature mono">Oct 2022</td>
                <td>Mango Markets</td>
                <td className="pitch-matrix-no mono">$114M</td>
                <td>Oracle attack on thin MNGO token; shared collateral drained.</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature mono">Mar 2025</td>
                <td>Hyperliquid</td>
                <td className="pitch-matrix-no mono">~$12M HLP</td>
                <td>JELLY squeeze; validators manually delisted &amp; hard-coded oracle.</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature mono">Apr 1, 2026</td>
                <td>Drift v2</td>
                <td className="pitch-matrix-no mono">$295M</td>
                <td>Admin multisig socially engineered via Solana durable nonces.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="pitch-matrix-sub">
          Solana made spot creation permissionless. Perp creation never
          followed, because a shared LP pool externalises every listing
          decision onto every existing LP. Drift, Jupiter, and Pacifica
          all converge on the same 30&ndash;50 tickers by architectural
          necessity, not by taste.
        </p>
      </div>
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
          Two-person team. Each won one of Toly&apos;s public bounties
          on Percolator. Shipped to mainnet with no outside capital.
        </h2>

        <div className="pitch-team-grid pitch-team-grid-two">
          <div className="pitch-team-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://pbs.twimg.com/profile_images/2020207940389548032/j7hY6v_m_400x400.jpg"
              alt="Khubair"
              className="pitch-team-pfp"
            />
            <div className="pitch-team-name">Khubair</div>
            <div className="pitch-team-role">Co-founder · Protocol &amp; Risk</div>
            <ul className="pitch-team-bullets">
              <li>Shipped the wrapper engine port, SDK, indexer, and 36 pre-audit hardening PRs in four days</li>
              <li>Won Toly&apos;s public bounty on pre-audit critical bug review</li>
              <li>Solana product co-founder, Superteam UK member, Web2 startup background</li>
            </ul>
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
            <div className="pitch-team-role">Co-founder · Systems &amp; Liquidity</div>
            <ul className="pitch-team-bullets">
              <li>
                Shipped{" "}
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
              </li>
              <li>Found and patched the KeeperCrank big-brain bug (Toly QRT&apos;d the fix)</li>
              <li>3 years building on Solana; winner of Toly&apos;s Percolator bounty</li>
            </ul>
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
        </div>

        <div className="pitch-revenue-econ" style={{ marginTop: "1.5rem" }}>
          <div className="pitch-revenue-econ-stat">
            <div className="pitch-revenue-econ-num mono">21</div>
            <div className="pitch-revenue-econ-label">Apache-2.0 repos</div>
          </div>
          <div className="pitch-revenue-econ-stat">
            <div className="pitch-revenue-econ-num mono">50</div>
            <div className="pitch-revenue-econ-label">fork-only instructions shipped</div>
          </div>
          <div className="pitch-revenue-econ-stat">
            <div className="pitch-revenue-econ-num mono">4</div>
            <div className="pitch-revenue-econ-label">programs live on mainnet</div>
          </div>
        </div>

        <p className="pitch-team-footer" style={{ marginTop: "1.5rem" }}>
          Anatoly Yakovenko wrote the protocol math and open-sourced a
          reference program at{" "}
          <a
            href="https://github.com/aeyakovenko/percolator-prog"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/aeyakovenko/percolator-prog
          </a>
          . We forked his engine and built everything on top: LP vault,
          transferable NFT positions, dispute resolution, keepers, SDK,
          frontend.
        </p>
      </div>
    </div>
  );
}

// ─── Slide 3 · Traction ──────────────────────────────────────────────────────
//
// Programs verified on-chain at the time of writing:
//   - Devnet (canonical, current):   FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD
//   - Devnet (legacy, kept indexed):  g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in
//                                     FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn
//   - Mainnet (closed beta, May):     ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv
// Stats below are pulled from getSignaturesForAddress + market slab tracking.
// Followers are organic, no paid spend.

function Slide03Traction(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Traction</div>
        <h2 className="pitch-title">
          220 markets shipped on devnet in 5 weeks by 71 unique
          creators. First SOL/USDC market live on mainnet today.
        </h2>

        <div className="pitch-traction-network-grid pitch-traction-network-grid-single">
          <div className="pitch-traction-network-card pitch-traction-network-card-wide">
            <div className="pitch-traction-network-header">
              <div className="pitch-traction-network-tag mono pitch-traction-network-tag-cyan">
                Devnet · Feb 28 – Mar 31, 2026
              </div>
              <a
                className="pitch-traction-network-link mono"
                href="https://explorer.solana.com/address/FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD?cluster=devnet"
                target="_blank"
                rel="noopener noreferrer"
              >
                FxfD37s1…sfKrD ↗
              </a>
            </div>
            <div className="pitch-traction-network-stats pitch-traction-network-stats-three">
              <div className="pitch-traction-network-stat">
                <div className="pitch-traction-network-num mono pitch-traction-network-num-cyan">
                  <NumberCounter target={220} />
                </div>
                <div className="pitch-traction-network-label">markets created</div>
                <div className="pitch-traction-network-sublabel mono">over 5 weeks</div>
              </div>
              <div className="pitch-traction-network-stat">
                <div className="pitch-traction-network-num mono">
                  <NumberCounter target={71} />
                </div>
                <div className="pitch-traction-network-label">unique creators</div>
                <div className="pitch-traction-network-sublabel mono">seeding their own LP vaults</div>
              </div>
              <div className="pitch-traction-network-stat">
                <div className="pitch-traction-network-num mono pitch-traction-network-num-cyan">3 tiers</div>
                <div className="pitch-traction-network-label">all running</div>
                <div className="pitch-traction-network-sublabel mono">136 small · 12 med · 72 large</div>
              </div>
            </div>
            <div className="pitch-traction-network-meta mono">
              Markets span small, medium, and large slab tiers between
              February 28 and March 31, 2026, all verifiable on chain.
              Each market seeds its own per-market LP vault &mdash; the
              same passive model as Jupiter&apos;s JLP, but isolated
              per listing.
            </div>
          </div>
        </div>

        <div
          className="pitch-traction-mainnet-line mono"
          style={{
            marginTop: "1.25rem",
            padding: "0.85rem 1.1rem",
            background: "rgba(34,211,238,0.05)",
            border: "1px solid rgba(34,211,238,0.2)",
            borderRadius: "10px",
            fontSize: "0.85rem",
            color: "rgba(255,255,255,0.75)",
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: "#22D3EE", fontWeight: 700 }}>
            Mainnet · closed beta:
          </strong>{" "}
          SOL/USDC perp live, pinned to a Raydium CLMM pool. We&apos;re
          not chasing volume here yet &mdash; it&apos;s just us and a
          handful of OSS contributors stress-testing UX, keepers, and
          settlement before the external audit. Public access opens
          once the audit clears.
        </div>

        <div
          className="pitch-waitlist-hero"
          style={{
            marginTop: "1.5rem",
            padding: "1.5rem 1.75rem",
            background:
              "linear-gradient(135deg, rgba(153,69,255,0.08), rgba(34,211,238,0.06))",
            border: "1px solid rgba(153,69,255,0.25)",
            borderRadius: "14px",
            textAlign: "center",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: "clamp(3rem, 7vw, 4.5rem)",
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              background: "linear-gradient(135deg, #9945FF, #22D3EE)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            <NumberCounter target={100} suffix="+" />
          </div>
          <div
            style={{
              fontSize: "1rem",
              color: "rgba(255,255,255,0.78)",
              marginTop: "0.5rem",
              fontWeight: 500,
            }}
          >
            Waitlist signups in the first 48 hours
          </div>
          <div
            className="mono"
            style={{
              fontSize: "0.72rem",
              color: "rgba(255,255,255,0.45)",
              marginTop: "0.85rem",
              letterSpacing: "0.06em",
            }}
          >
            3,200 organic X followers &middot; 0 paid acquisition
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide · Demo Product ────────────────────────────────────────────────────

function Slide05Product(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Demo Product</div>
        <h2 className="pitch-title">
          First SOL/USDC perp market live on mainnet today. Public on
          audit clearance.
        </h2>

        <div className="pflow-wrap">
          <div className="pflow-step">
            <div className="pflow-num-wrap">
              <div className="pflow-num mono">01</div>
            </div>
            <div className="pflow-step-title">Per-market USDC vault</div>
            <div className="pflow-step-desc">
              PDA <span className="mono">[b&quot;vault&quot;, slab_key]</span>.
              Risk isolated from every other market on the protocol.
            </div>
            <div className="pflow-example-card">
              <div className="pflow-example-label mono">PDA seed</div>
              <div className="pflow-example-value mono">[b&quot;vault&quot;, slab_key]</div>
              <div className="pflow-example-value mono">+ [b&quot;lp_vault&quot;, slab_key]</div>
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
            <div className="pflow-step-title">Position mints as Token-2022 NFT</div>
            <div className="pflow-step-desc">
              Up to 10&times; leverage. First transferable perp
              position primitive on Solana.
            </div>
            <div className="pflow-example-card">
              <div className="pflow-example-label mono">mint instruction</div>
              <div className="pflow-example-value mono">spl_token_2022::InitializeMint2</div>
              <div className="pflow-example-value mono">+ TransferHook extension</div>
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
            <div className="pflow-step-title">Settlement on close</div>
            <div className="pflow-step-desc">
              Fee routes to per-market insurance &rarr; LPs accrue via
              vault crank. Q3: four-way split.
            </div>
            <div className="pflow-example-card pflow-example-card-live">
              <div className="pflow-example-label mono">fee routing</div>
              <div className="pflow-example-value mono">charge_fee_to_insurance(slab)</div>
              <div className="pflow-live-dot-row">
                <span className="pflow-live-dot" />
                <span className="pflow-live-text mono">ATOMIC</span>
              </div>
            </div>
          </div>
        </div>

        <div className="pitch-create-footer">
          Mark price from a pinned Raydium CLMM pool with Pyth as
          primary, per-market oracle config with deviation circuit
          breaker. The LP vault sits on the other side of every trade
          &mdash; JLP-style, no active market makers required. Closed
          beta at mainnet.percolatorlaunch.com.
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
          10 bps per trade on notional. &gt;95% gross margin because we
          don&apos;t pay market makers. Here&apos;s the path from one
          market to $1M/day in protocol fees.
        </h2>

        <div className="pitch-matrix-wrap">
          <table className="pitch-matrix">
            <thead>
              <tr>
                <th className="pitch-matrix-feature">Scenario</th>
                <th>Active markets</th>
                <th>Avg daily volume / market</th>
                <th>Daily protocol revenue</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="pitch-matrix-feature mono">Conservative · Q4 2026</td>
                <td className="mono">10</td>
                <td className="mono">$1M</td>
                <td className="mono">$1,000</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature mono">Base · mid-2027</td>
                <td className="mono">100</td>
                <td className="mono">$1M</td>
                <td className="mono">$10,000</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature mono">Stretch · 2028</td>
                <td className="mono">1,000</td>
                <td className="mono">$1M</td>
                <td className="mono">$100,000</td>
              </tr>
              <tr>
                <td className="pitch-matrix-feature mono pitch-matrix-us">Hyperliquid-class · 2029+</td>
                <td className="mono pitch-matrix-us">1,000</td>
                <td className="mono pitch-matrix-us">$20M</td>
                <td className="mono pitch-matrix-us">$2,000,000</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="pitch-matrix-sub" style={{ marginTop: "0.75rem" }}>
          Math: avg market does $X spot/day &times; 3&ndash;5&times;
          perp-to-spot ratio &times; 10 bps fee. Break-even on
          operating cost (~$50K/month: audit + 2 engineers + infra) at
          roughly <strong>17 markets at $1M/day each</strong> &mdash;
          between Conservative and Base.
        </p>

        <div
          className="pitch-fee-routing"
          style={{
            marginTop: "1.5rem",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1rem",
          }}
        >
          <div
            style={{
              padding: "1rem 1.1rem",
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "10px",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: "0.7rem",
                color: "rgba(153,69,255,0.85)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: "0.5rem",
              }}
            >
              Fee routing today (v12.19)
            </div>
            <div
              style={{
                fontSize: "0.85rem",
                lineHeight: 1.55,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              Trade fee &rarr; per-market insurance fund &rarr; LPs
              accrue via vault crank. Single-stream, fully on-chain,
              isolated per market.
            </div>
          </div>
          <div
            style={{
              padding: "1rem 1.1rem",
              background: "rgba(34,211,238,0.04)",
              border: "1px solid rgba(34,211,238,0.2)",
              borderRadius: "10px",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: "0.7rem",
                color: "rgba(34,211,238,0.85)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: "0.5rem",
              }}
            >
              Q3 with audit
            </div>
            <div
              style={{
                fontSize: "0.85rem",
                lineHeight: 1.55,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              Four-way split &mdash; LP vault, market creator, protocol
              treasury, insurance &mdash; atomically on-chain in the
              settlement transaction. Exact percentages set per market
              at <span className="mono">CreateLpVault</span>.
            </div>
          </div>
        </div>

        <div className="pitch-revenue-econ" style={{ marginTop: "1.5rem" }}>
          <div className="pitch-revenue-econ-stat">
            <div className="pitch-revenue-econ-num mono">&gt;95%</div>
            <div className="pitch-revenue-econ-label">gross margin per trade</div>
          </div>
          <div className="pitch-revenue-econ-stat">
            <div className="pitch-revenue-econ-num mono">~$0.002</div>
            <div className="pitch-revenue-econ-label">Solana compute / trade</div>
          </div>
          <div className="pitch-revenue-econ-stat">
            <div className="pitch-revenue-econ-num mono">$0</div>
            <div className="pitch-revenue-econ-label">market-maker rebate spend</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide · Why Now ─────────────────────────────────────────────────────────

function Slide09WhyNow(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Why Now</div>
        <h2 className="pitch-title">
          Solana perps lost their #2 venue six weeks ago. The long-tail
          supply that&apos;s left has nowhere to go.
        </h2>
        <div className="pitch-whynow-stats">
          <div className="pitch-whynow-stat">
            <svg viewBox="0 0 24 24" className="pitch-catalyst-icon" aria-hidden>
              <path
                d="M 12 3 L 21 18 L 3 18 Z"
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="12" cy="16" r="0.9" fill="currentColor" />
            </svg>
            <div className="pitch-whynow-num mono">Apr 1, 2026</div>
            <div className="pitch-whynow-label">
              Drift drained for{" "}
              <strong style={{ color: "rgba(255,255,255,0.9)" }}>
                $295M
              </strong>{" "}
              by a DPRK durable-nonce attack on its admin multisig.
              Solana&apos;s #2 perp venue is offline pending Q2
              relaunch. Solana perp volume dropped from $25B+/month to
              ~$15&ndash;20B. That gap is liquidity looking for a venue.
            </div>
          </div>
          <div className="pitch-whynow-stat">
            <svg viewBox="0 0 24 24" className="pitch-catalyst-icon" aria-hidden>
              <circle cx="12" cy="12" r="9" stroke="currentColor" fill="none" strokeWidth="1.8" />
              <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <div className="pitch-whynow-num mono">Shared LP keeps failing</div>
            <div className="pitch-whynow-label">
              Hyperliquid had to manually delist JELLY and hard-code
              its oracle in March 2025 to bail out HLP. Mango lost
              $114M to oracle manipulation on a thin token in 2022.
              Adrena pivoted to RWAs Nov 2025. Zeta and Mango v4 are
              dormant. The shared-pool model is failing in public.
            </div>
          </div>
          <div className="pitch-whynow-stat">
            <svg viewBox="0 0 24 24" className="pitch-catalyst-icon" aria-hidden>
              <path
                d="M 3 18 L 9 14 L 13 16 L 21 6"
                stroke="currentColor"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="3" cy="18" r="1.2" fill="currentColor" />
              <circle cx="9" cy="14" r="1.2" fill="currentColor" />
              <circle cx="13" cy="16" r="1.2" fill="currentColor" />
              <circle cx="21" cy="6" r="1.2" fill="currentColor" />
            </svg>
            <div className="pitch-whynow-num mono">200&ndash;1,500 tokens</div>
            <div className="pitch-whynow-label">
              Solana SPL tokens with $50K+ daily spot volume that have{" "}
              <strong style={{ color: "rgba(255,255,255,0.9)" }}>
                no perp anywhere
              </strong>
              . Only ~20&ndash;25 Solana-native tokens have a live perp
              on any Solana venue today. Pacifica leads at 51% market
              share with ~48 crypto markets (65 total, the rest are
              equities and FX). The supply is empty.
            </div>
          </div>
        </div>
        <div className="pitch-whynow-closing">
          Six-week-old window. The next venue that takes long-tail
          seriously gets the volume that used to live on Drift.
        </div>
      </div>
    </div>
  );
}

// ─── Slide · GTM ─────────────────────────────────────────────────────────────

function SlideGTM(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Go-to-Market</div>
        <h2 className="pitch-title">
          Creators acquire markets. LP vaults provide depth.
          Traders never trade against each other.
        </h2>

        <div className="pitch-solution-stack">
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">1</div>
            <div>
              <div className="pitch-solution-name">
                Who you trade against
              </div>
              <p className="pitch-solution-desc">
                The per-market LP vault sits on the other side of
                every trade. There is no order book; there are no
                makers and takers. There&apos;s a passive vault, a
                mark price, and the risk engine. Traders deposit USDC,
                open a position, and the vault is their counterparty
                &mdash; same passive model as Jupiter&apos;s JLP, sized
                per market, isolated per market.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">2</div>
            <div>
              <div className="pitch-solution-name">
                How book depth gets built (no rebates)
              </div>
              <p className="pitch-solution-desc">
                Day-zero depth from three sources, in order: (a)
                creator-seeded LP &mdash; the market launcher deposits
                first, incentivised by the creator fee share their
                market will earn; (b) Percolator-bootstrap LP from
                raise proceeds, $50K co-deposit per cohort market in
                Q3, recyclable as creator LP scales; (c) open LP, JLP-style,
                anyone can deposit into any market&apos;s per-market
                vault and mint LP tokens.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">3</div>
            <div>
              <div className="pitch-solution-name">
                Market-maker partnerships (Q4, not day-zero)
              </div>
              <p className="pitch-solution-desc">
                Once a market clears $1M/day volume, we open dedicated
                MM slots &mdash; programmatic LP topping with tighter
                mark-deviation tolerances, paid via priority fee share
                on that MM&apos;s deposit.{" "}
                <strong style={{ color: "rgba(255,255,255,0.9)" }}>
                  No rebates. No paid spread.
                </strong>{" "}
                MM as priority-LP, not quote-and-take &mdash; the
                rebate model is what ate every Drift-class venue&apos;s
                margin. Two firms in conversation; named after audit.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">4</div>
            <div>
              <div className="pitch-solution-name">
                Retail acquisition through the long tail
              </div>
              <p className="pitch-solution-desc">
                Creator-first GTM, not trader-first. Every long-tail
                listing is the creator&apos;s job to attract their
                community &mdash; the model Pump.fun proved on spot,
                applied to perps. Creator rev-share lever: 30% creator
                share through Q4 for the first 10 cohort markets, 20%
                standard from Q4 open listings onward. Creator pays no
                gas they don&apos;t recover in the first 10 trades.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide · Contact ─────────────────────────────────────────────────────────

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
          Closed beta is restricted to a small group of open-source
          contributors, pre-audit. Fork the code under Apache 2.0 across
          all 22 public repos, or DM us on X. We answer.
        </p>
        <div className="pitch-contact-grid">
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Try it</div>
            <div className="pitch-contact-value">percolator.trade</div>
          </div>
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Code</div>
            <div className="pitch-contact-value">github.com/dcccrypto</div>
          </div>
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">X</div>
            <div className="pitch-contact-value">@percolatortrade</div>
          </div>
          <div className="pitch-contact-card">
            <div className="pitch-contact-label mono">Email</div>
            <div className="pitch-contact-value">contact@percolator.trade</div>
          </div>
        </div>
        <div className="pitch-divider" />
        <p className="pitch-url">percolator.trade</p>
        <p className="pitch-onchain-footer mono">
          Verifiable on-chain · mainnet program in OSS-contributor closed beta · devnet program{" "}
          <a
            href="https://explorer.solana.com/address/FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD?cluster=devnet"
            target="_blank"
            rel="noopener noreferrer"
          >
            FxfD37s1…sfKrD
          </a>
        </p>
      </div>
    </div>
  );
}

// ─── Slide · Origin · how this came about ────────────────────────────────────

function SlideOrigin(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Origin</div>
        <h2 className="pitch-title">
          Solana&apos;s co-founder wrote the math. We won his bounties.
          He&apos;s still engaged.
        </h2>

        <p
          style={{
            fontSize: "0.95rem",
            lineHeight: 1.7,
            color: "rgba(255,255,255,0.75)",
            marginBottom: "1.5rem",
          }}
        >
          Anatoly Yakovenko wrote the protocol math and open-sourced a
          reference program at{" "}
          <a
            href="https://github.com/aeyakovenko/percolator-prog"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "#22D3EE",
              textDecoration: "none",
              borderBottom: "1px dotted rgba(34,211,238,0.5)",
            }}
          >
            aeyakovenko/percolator-prog
          </a>
          , then posted public bounties for community ports. We each
          won one &mdash;{" "}
          <strong style={{ color: "rgba(255,255,255,0.95)" }}>Squid</strong>{" "}
          for the KeeperCrank fix,{" "}
          <strong style={{ color: "rgba(255,255,255,0.95)" }}>Khubair</strong>{" "}
          for a pre-audit critical bug review &mdash; then shipped the
          wrapper, LP vault, transferable NFT positions, dispute
          resolution, keepers, and SDK on top. We&apos;ve also
          contributed back:{" "}
          <strong style={{ color: "rgba(255,255,255,0.95)" }}>
            29 upstream PRs
          </strong>{" "}
          and a series of critical security disclosures against
          Toly&apos;s reference program. Toly has publicly engaged
          with our work four times since February:
        </p>

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
      </div>
    </div>
  );
}

// ─── Slide · How the Math Works ──────────────────────────────────────────────

function SlideMath(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">How the Math Works</div>
        <h2 className="pitch-title">
          Toly&apos;s risk math socialises bankruptcies in O(1) &mdash;
          no shared insurance pool, no human override, no cross-market
          contagion.
        </h2>

        <div className="pitch-solution-stack">
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">1</div>
            <div>
              <div className="pitch-solution-name">
                Per-market isolation, mathematically enforced
              </div>
              <p className="pitch-solution-desc">
                Every market is its own Solana account with its own
                PDA-derived collateral vault, LP vault, and insurance
                fund. The solvency invariant{" "}
                <span className="mono">vault &ge; open_collateral + insurance</span>{" "}
                is enforced in the engine&apos;s integrity-check path.
                A wipeout on one market is mathematically incapable of
                touching another market&apos;s vault &mdash; it&apos;s
                a Solana account-model constraint, not a business
                policy.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">2</div>
            <div>
              <div className="pitch-solution-name">
                The A/K index trick (Toly&apos;s contribution)
              </div>
              <p className="pitch-solution-desc">
                When a bankruptcy happens, the engine shrinks a single
                side-level multiplier <span className="mono">A</span>{" "}
                and credits the loss to a side-level coefficient{" "}
                <span className="mono">K</span>. Every surviving
                opposing-side position is scaled by the new A &mdash;
                no per-account loop, no shared insurance drained, no
                human override. One integer subtraction socialises the
                loss across the entire opposing side in O(1).
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">3</div>
            <div>
              <div className="pitch-solution-name">
                Warmup-H prevents extract-and-run
              </div>
              <p className="pitch-solution-desc">
                Positive PnL sits in a{" "}
                <span className="mono">reserved_pnl</span> bucket for a
                configurable warmup window. An oracle-manipulator
                trying to withdraw the same block hits a wall. If the
                vault ever runs short, winners are proportionally
                haircut rather than a single winner draining the fund.
                It&apos;s the failure mode that took Mango and JELLY,
                arithmetically closed off.
              </p>
            </div>
          </div>
        </div>

        <p className="pitch-team-footer" style={{ marginTop: "1.5rem" }}>
          The engine is <span className="mono">no_std</span> Rust with
          256-bit checked arithmetic end-to-end &mdash; portable to any
          SVM chain. 305 bounded-invariant proofs run in CI.{" "}
          <span style={{ color: "rgba(34,211,238,0.85)" }}>
            External audit Q3.
          </span>
        </p>
      </div>
    </div>
  );
}

// ─── Slide · Moat ────────────────────────────────────────────────────────────

function SlideMoat(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Moat</div>
        <h2 className="pitch-title">
          Code is forkable. Liquidity, architecture lock-in, and
          first-mover position per market are not.
        </h2>

        <div className="pitch-solution-stack">
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">1</div>
            <div>
              <div className="pitch-solution-name">
                Liquidity is local-per-market &mdash; forks inherit
                empty vaults
              </div>
              <p className="pitch-solution-desc">
                A Percolator clone with no LPs has empty per-market
                vaults. SushiSwap pulled 55% of Uniswap&apos;s TVL in a
                week in 2020 by paying for it; six months later Uniswap
                had recovered to ~2&times; the TVL because liquidity
                and integrations decayed back to the canonical version.
                Forking our code without LP capital is the same
                problem at higher resolution.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">2</div>
            <div>
              <div className="pitch-solution-name">
                Architecture lock-in for the incumbents
              </div>
              <p className="pitch-solution-desc">
                Drift, Jupiter, and Pacifica all use a single shared LP
                pool. Pivoting to per-market isolation means migrating
                live capital across thousands of positions, with active
                traders inside &mdash; a product change none of them can
                make without breaking their own users. We don&apos;t
                have that constraint; we shipped greenfield. They can
                copy the math, but not the migration.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num purple">3</div>
            <div>
              <div className="pitch-solution-name">
                First-mover per market &mdash; network effects compound
                locally
              </div>
              <p className="pitch-solution-desc">
                Once a token has a Percolator market with seeded LP and
                a creator earning rev-share, the next fork has to
                bootstrap that market from zero against a live one. We
                defend market-by-market rather than needing a single
                $1B TVL number. Long-tail compounds in our favour: the
                more markets we onboard, the more local moats we own.
              </p>
            </div>
          </div>
          <div className="pitch-solution-item">
            <div className="pitch-solution-num cyan">4</div>
            <div>
              <div className="pitch-solution-name">
                Distribution &amp; integrations
              </div>
              <p className="pitch-solution-desc">
                Aggregator routing (Jupiter, Titan), keeper networks,
                indexers, wallet integrations &mdash; relationships
                forks can&apos;t copy. Plus the team&apos;s ability to
                ship correctness updates faster than any fork can
                reverse-engineer them. Toly publicly engaging is itself
                a distribution asset no copycat can replicate.
              </p>
            </div>
          </div>
        </div>

        <p className="pitch-matrix-sub" style={{ marginTop: "1.25rem" }}>
          The Solana perp niche behaves like an order-book market:
          liquidity concentrates by network effect, and forks split the
          LP base which hurts both sides. That dynamic is structurally
          protective once the canonical venue is established.
        </p>
      </div>
    </div>
  );
}

// ─── Slide · Roadmap & Ask (Roadmap + Risks + Next Steps merged) ─────────────

function SlideRoadmapAsk(_: SlideProps) {
  return (
    <div className="pitch-slide">
      <div className="pitch-slide-inner">
        <div className="pitch-label">Roadmap, Risks &amp; Ask</div>
        <h2 className="pitch-title">
          $2M on a SAFE at $20M post-money cap. 18 months to public
          mainnet, 50+ markets, and Series A.
        </h2>

        <div className="pitch-roadmap">
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase purple">Q2 2026</div>
            <div className="pitch-roadmap-name">Closed beta · audit</div>
            <div className="pitch-roadmap-desc">Mainnet program live, OSS-contributor beta, audit firm selected</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase cyan">Q3 2026</div>
            <div className="pitch-roadmap-name">Public mainnet</div>
            <div className="pitch-roadmap-desc">Audit complete, four-way fee split wired, first 10 cohort markets</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase purple">Q4 2026</div>
            <div className="pitch-roadmap-name">50+ markets live</div>
            <div className="pitch-roadmap-desc">Creator-led listings ramp, Jupiter / Birdeye routing live</div>
          </div>
          <div className="pitch-roadmap-connector" />
          <div className="pitch-roadmap-item">
            <div className="pitch-roadmap-phase cyan">2027</div>
            <div className="pitch-roadmap-name">$1M+ daily fees</div>
            <div className="pitch-roadmap-desc">Cross-margining, MM partnerships, Series A or strategic LP round</div>
          </div>
        </div>

        <div
          style={{
            marginTop: "2rem",
            padding: "1.1rem 1.25rem",
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "12px",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: "0.7rem",
              color: "rgba(153,69,255,0.85)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: "0.75rem",
            }}
          >
            Risks we take seriously
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "0.9rem",
              fontSize: "0.82rem",
              lineHeight: 1.5,
              color: "rgba(255,255,255,0.65)",
            }}
          >
            <div>
              <strong style={{ color: "#fff", fontWeight: 700 }}>
                Toxic flow on long-tail.
              </strong>{" "}
              Per-market LP isolation, dynamic LP caps tied to on-DEX
              spot float, per-market insurance sub-vaults.
            </div>
            <div>
              <strong style={{ color: "#fff", fontWeight: 700 }}>
                Oracle attacks on thin tokens.
              </strong>{" "}
              Pyth/Switchboard primary + pinned on-chain reference +
              deviation circuit breaker + warmup-H gate on PnL extract.
            </div>
            <div>
              <strong style={{ color: "#fff", fontWeight: 700 }}>
                Admin-key compromise (Drift Apr 2026).
              </strong>{" "}
              4-of-7 Squads multisig at audit clearance,
              blind-signing simulation, hardware-only rotation.
            </div>
          </div>
        </div>

        <div className="pitch-ask-grid" style={{ marginTop: "1.5rem" }}>
          <div className="pitch-ask-card pitch-ask-card-primary">
            <div className="pitch-ask-card-label mono">The ask</div>
            <div className="pitch-ask-card-headline">
              $2M · SAFE · $20M post-money cap
            </div>
            <div className="pitch-ask-card-sub">
              Pro-rata on Series A. Standard info rights. Future token
              rights, if and when issued, to be negotiated at the
              cap-equivalent price. We&apos;re shipping with or without
              capital; the right partner shortens the timeline from 24
              months to 9.
            </div>
          </div>
          <div className="pitch-ask-card">
            <div className="pitch-ask-card-label mono">Use of funds &middot; 18 months</div>
            <ul className="pitch-ask-list">
              <li><strong>40%</strong> external audit + bug bounty</li>
              <li><strong>30%</strong> LP-vault bootstrap on first 10 cohort markets</li>
              <li><strong>15%</strong> creator acquisition via rev-share rebates (no paid spend)</li>
              <li><strong>15%</strong> two senior hires (matching engine, risk research)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Slide Registry ───────────────────────────────────────────────────────────

const SLIDES = [
  { id: 1, title: "One-Liner", component: Slide01OneLiner },
  { id: 2, title: "Problem", component: SlideProblem },
  { id: 3, title: "Team", component: Slide02Team },
  { id: 4, title: "Traction", component: Slide03Traction },
  { id: 5, title: "Origin", component: SlideOrigin },
  { id: 6, title: "How the Math Works", component: SlideMath },
  { id: 7, title: "Demo Product", component: Slide05Product },
  { id: 8, title: "Business Model", component: Slide06Money },
  { id: 9, title: "Moat", component: SlideMoat },
  { id: 10, title: "Why Now", component: Slide09WhyNow },
  { id: 11, title: "Go-to-Market", component: SlideGTM },
  { id: 12, title: "Roadmap & Ask", component: SlideRoadmapAsk },
  { id: 13, title: "Contact", component: Slide13Contact },
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
          overflow-y: auto;
          padding: 0 0 80px 0;
        }

        .pitch-slide-inner {
          width: 100%;
          max-width: 1000px;
          margin: 0 auto;
          padding: 1.5rem 2.5rem;
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
          color: rgba(34,211,238,0.75);
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
          gap: 0.85rem;
        }

        .pitch-solution-item {
          display: flex;
          gap: 1.5rem;
          align-items: flex-start;
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 12px;
          padding: 0.95rem 1.25rem;
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
          font-family: 'Inter', sans-serif;
          font-size: 0.92rem;
          font-weight: 500;
          color: rgba(255, 255, 255, 0.65);
          letter-spacing: 0;
          line-height: 1.5;
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
          border-radius: 12px;
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
          color: rgba(255,255,255,0.8);
          padding: 0.75rem 1rem;
          text-align: center;
        }

        .pitch-matrix th:first-child { text-align: left; }

        .pitch-matrix tbody tr {
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }

        .pitch-matrix tbody tr:last-child { border-bottom: none; }

        .pitch-matrix td {
          padding: 0.85rem 1rem;
          text-align: center;
          color: rgba(255,255,255,0.5);
        }

        .pitch-matrix-feature {
          text-align: left !important;
          color: rgba(255,255,255,0.65) !important;
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
          font-size: 0.9rem;
          color: rgba(255,255,255,0.6);
          font-style: italic;
          margin-top: 1rem;
          line-height: 1.5;
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

        /* ── Revenue (Slide 10 — redesigned) ── */

        .pitch-revenue-hero {
          display: flex;
          gap: 1.75rem;
          align-items: stretch;
          padding: 1.4rem 1.6rem;
          margin: 1.5rem 0;
          background: linear-gradient(95deg,
            rgba(153, 69, 255, 0.10) 0%,
            rgba(34, 211, 238, 0.10) 100%);
          border: 1px solid rgba(34, 211, 238, 0.28);
          border-radius: 12px;
        }

        .pitch-revenue-hero-side {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 0.25rem;
          padding-right: 1.6rem;
          border-right: 1px solid rgba(255, 255, 255, 0.08);
          flex: 0 0 auto;
        }

        .pitch-revenue-hero-num {
          font-size: clamp(1.85rem, 3.4vw, 2.6rem);
          font-weight: 700;
          color: #22D3EE;
          letter-spacing: -0.025em;
          line-height: 1;
        }

        .pitch-revenue-hero-tag {
          font-size: 0.62rem;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: rgba(34, 211, 238, 0.7);
        }

        .pitch-revenue-hero-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.92rem;
          line-height: 1.5;
          color: rgba(255, 255, 255, 0.78);
          flex: 1;
          display: flex;
          align-items: center;
        }

        .pitch-revenue-splits {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.85rem;
          margin: 1.5rem 0;
        }

        .pitch-revenue-split {
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 1.1rem 1.15rem;
        }

        .pitch-revenue-split-us {
          border-color: rgba(34, 211, 238, 0.38);
          background: rgba(34, 211, 238, 0.05);
        }

        .pitch-revenue-split-name {
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.72);
          margin-bottom: 0.55rem;
        }

        .pitch-revenue-split-us .pitch-revenue-split-name {
          color: #22D3EE;
        }

        .pitch-revenue-split-desc {
          font-family: 'Inter', sans-serif;
          font-size: 0.78rem;
          line-height: 1.5;
          color: rgba(255, 255, 255, 0.6);
          margin: 0;
        }

        .pitch-revenue-econ {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.85rem;
        }

        .pitch-revenue-econ-stat {
          display: flex;
          align-items: baseline;
          gap: 0.7rem;
          padding: 0.85rem 1.05rem;
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 10px;
        }

        .pitch-revenue-econ-num {
          font-size: 1.35rem;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.95);
          letter-spacing: -0.01em;
          line-height: 1;
        }

        .pitch-revenue-econ-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.78rem;
          line-height: 1.35;
          color: rgba(255, 255, 255, 0.55);
        }

        @media (max-width: 720px) {
          .pitch-revenue-hero {
            flex-direction: column;
            gap: 0.85rem;
          }
          .pitch-revenue-hero-side {
            border-right: none;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding: 0 0 0.85rem;
          }
          .pitch-revenue-splits,
          .pitch-revenue-econ {
            grid-template-columns: 1fr 1fr;
          }
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

        @media (max-width: 720px) {
          .pitch-traction-mini-row {
            grid-template-columns: repeat(2, 1fr);
          }
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

        .pitch-traction-network-sublabel {
          font-size: 0.62rem;
          color: rgba(34, 211, 238, 0.65);
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-top: 0.25rem;
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
          border-radius: 12px;
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

        .pitch-team-bullets {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          font-family: 'Inter', sans-serif;
          font-size: 0.85rem;
          line-height: 1.5;
          color: rgba(255,255,255,0.62);
        }

        .pitch-team-bullets li {
          padding-left: 0.9rem;
          position: relative;
        }

        .pitch-team-bullets li::before {
          content: "·";
          position: absolute;
          left: 0;
          color: rgba(34,211,238,0.7);
          font-weight: 700;
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

        .pitch-hero-body {
          font-family: 'Inter', sans-serif;
          font-size: clamp(0.95rem, 1.6vw, 1.1rem);
          line-height: 1.65;
          color: rgba(255, 255, 255, 0.78);
          text-align: center;
          max-width: 620px;
          margin: 0 auto 1.85rem;
        }

        .pitch-hero-ctas {
          display: flex;
          gap: 0.75rem;
          justify-content: center;
          flex-wrap: wrap;
          margin: 0.5rem 0 1.6rem;
        }

        .pitch-hero-cta {
          display: inline-flex;
          align-items: center;
          gap: 0.55rem;
          padding: 0.78rem 1.4rem;
          border-radius: 10px;
          font-family: 'Inter', sans-serif;
          font-size: 0.95rem;
          font-weight: 500;
          text-decoration: none;
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: rgba(255, 255, 255, 0.88);
          transition: border-color 200ms ease, background 200ms ease, color 200ms ease;
        }

        @media (hover: hover) {
          .pitch-hero-cta:hover {
            border-color: rgba(34, 211, 238, 0.5);
            background: rgba(34, 211, 238, 0.06);
            color: #fff;
          }
        }

        .pitch-hero-cta-primary {
          background: linear-gradient(135deg, rgba(153, 69, 255, 0.18), rgba(34, 211, 238, 0.18));
          border-color: rgba(34, 211, 238, 0.42);
          border-left: 3px solid #22D3EE;
          color: #fff;
          padding-left: calc(1.4rem - 2px);
        }

        @media (hover: hover) {
          .pitch-hero-cta-primary:hover {
            background: linear-gradient(135deg, rgba(153, 69, 255, 0.3), rgba(34, 211, 238, 0.3));
            border-color: rgba(34, 211, 238, 0.75);
            border-left-color: #22D3EE;
          }
        }

        .pitch-hero-cta-arrow {
          font-family: 'JetBrains Mono', monospace;
          transition: transform 200ms ease;
        }

        @media (hover: hover) {
          .pitch-hero-cta:hover .pitch-hero-cta-arrow {
            transform: translateX(3px);
          }
        }

        /* ─── Team PFPs ────────────────────────────────────────────── */

        .pitch-team-pfp {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          border: 2px solid rgba(34, 211, 238, 0.22);
          margin-bottom: 0.85rem;
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

        /* New: attribution strip wrapping Toly thumbnails below devnet card */
        .pitch-toly-attribution-strip {
          margin-top: 1.25rem;
          padding-top: 1rem;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }

        .pitch-toly-attribution-caption {
          font-size: 0.65rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(153, 69, 255, 0.75);
          margin-bottom: 0.6rem;
        }

        .pitch-toly-photo-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.75rem;
          margin-bottom: 1rem;
        }

        .pitch-toly-photo-grid-compact {
          gap: 0.5rem;
          margin-bottom: 0.85rem;
        }

        .pitch-toly-photo-grid-compact .pitch-toly-photo {
          padding: 0.4rem;
        }

        .pitch-toly-photo-grid-compact .pitch-toly-photo img {
          aspect-ratio: 4 / 3;
        }

        .pitch-toly-photo-grid-compact .pitch-toly-photo-cap {
          font-size: 0.58rem;
        }

        @media (max-width: 900px) {
          .pitch-toly-photo-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        .pitch-toly-photo {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 0.5rem;
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
          aspect-ratio: 3 / 2;
          object-fit: contain;
          background: rgba(0, 0, 0, 0.35);
          border-radius: 8px;
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
            aspect-ratio: 16 / 9;
          }
          /* Compact variant (used on Traction slide) stays 2x2 on mobile so
             devnet stats + mini-row stay above the fold. Reza UX note 2026-05-11. */
          .pitch-toly-photo-grid-compact {
            grid-template-columns: repeat(2, 1fr);
          }
          .pitch-toly-photo-grid-compact .pitch-toly-photo img {
            aspect-ratio: 4 / 3;
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
          border-radius: 12px;
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
          padding: 0.7rem 1rem;
          margin-top: 0.85rem;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.55rem;
        }

        .pitch-kani-vs-title {
          font-size: 0.68rem;
          font-weight: 700;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(153, 69, 255, 0.7);
          margin-bottom: 0.6rem;
        }

        .pitch-kani-vs-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.6rem;
        }

        .pitch-kani-vs-cell {
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px;
          padding: 0.55rem 0.4rem;
          text-align: center;
        }

        .pitch-kani-vs-cell-num {
          font-size: 1.3rem;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.4);
          line-height: 1;
          margin-bottom: 0.25rem;
        }

        .pitch-kani-vs-cell-label {
          font-family: 'Inter', sans-serif;
          font-size: 0.7rem;
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
          font-size: 1.1rem;
          font-weight: 700;
          color: #fff;
          margin-bottom: 0.5rem;
          letter-spacing: -0.005em;
          line-height: 1.35;
        }

        .pitch-ask-card-primary {
          border-color: rgba(34, 211, 238, 0.32);
          background: rgba(34, 211, 238, 0.04);
        }

        .pitch-ask-card-primary .pitch-ask-card-label {
          color: rgba(34, 211, 238, 0.85);
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
          grid-template-columns: repeat(4, 1fr);
          gap: 0.85rem;
          width: 100%;
          max-width: 860px;
          margin: 0 auto;
        }

        @media (max-width: 720px) {
          .pitch-contact-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        .pitch-contact-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px;
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

        .pitch-onchain-footer {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.4);
          letter-spacing: 0.04em;
          margin: 1rem 0 0;
          text-align: center;
        }

        .pitch-onchain-footer a {
          color: rgba(34, 211, 238, 0.7);
          text-decoration: none;
          transition: color 200ms ease;
        }

        .pitch-onchain-footer a:hover {
          color: #22D3EE;
          text-decoration: underline;
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
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 12px;
          padding: 0.95rem 1.1rem;
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
          font-size: 0.92rem;
          color: rgba(255, 255, 255, 0.7);
          font-style: italic;
          border-left: 3px solid #22D3EE;
          padding-left: 1rem;
          max-width: 580px;
          line-height: 1.55;
          margin-top: 0.5rem;
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
          width: 32px;
          height: 32px;
          color: rgba(153, 69, 255, 0.85);
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
