"use client";

// /demo-shots — launcher page for capturing pitch-deck screenshots from
// the REAL production UI (not a mockup canvas). Deep-links to /create
// (real wizard, needs any connected wallet) and /trade/[mockSlab]?mock=1
// (real trade UI with the in-codebase mock SOL/USDC market).

import Link from "next/link";

// Mock markets pre-configured in app/lib/mock-trade-data.ts.
// BONK is the primary screenshot subject because it's the canonical
// long-tail SPL example — the exact category the deck pitches.
// Prices and 24h ranges are pulled from real CoinGecko spot data
// (refreshed 2026-05-12). See mock-trade-data.ts header.
const MOCK_BONK_SLAB = "HN7cABqLq46Es1jh92hQnvWo6BuZPdSmTQ5P2NMeVRgr";
const MOCK_SOL_SLAB  = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const MOCK_WIF_SLAB  = "4nF7d2Z3oF8bTKwhat9k8xsR1TLAo9U7Bd2Rk3pYJne5";
const MOCK_JUP_SLAB  = "B8mnfpCEt2z3SMz4giHGPNMB3DzBAJEYrPq9Uhnj4zXh";

const PURPLE = "#9945FF";
const HYPERP = "#22D3EE";
const LONG = "#14F195";
const TEXT = "#E1E2E8";
const TEXT_SECONDARY = "#7A7F96";
const TEXT_MUTED = "#454B5F";
const BG = "#0A0A0F";
const BG_ELEVATED = "#0F1018";
const BORDER = "#1C1F2E";

const mono = "JetBrains Mono, ui-monospace, monospace";

export default function DemoShotsLauncher() {
  return (
    <div style={{ background: BG, color: TEXT, minHeight: "100vh", padding: "3rem 2rem" }}>
      <div style={{ maxWidth: "880px", margin: "0 auto" }}>
        <div style={{ fontFamily: mono, fontSize: "10px", color: PURPLE, letterSpacing: "0.25em", marginBottom: "0.5rem", textTransform: "uppercase" }}>
          // screenshots
        </div>
        <h1 style={{ fontFamily: mono, fontSize: "1.75rem", fontWeight: 500, letterSpacing: "-0.01em", margin: 0 }}>
          Capture pitch-deck screenshots from the real UI
        </h1>
        <p style={{ fontSize: "13px", color: TEXT_SECONDARY, marginTop: "0.6rem", lineHeight: 1.6 }}>
          These two links open the actual production routes &mdash; same
          components, same styling, same flow as a live customer. Mock
          data is pre-loaded so nothing requires a real market or
          on-chain state.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginTop: "2rem" }}>
          <LauncherCard
            step="STEP 1"
            color={PURPLE}
            title="Open Create Wizard"
            body="The real /create market form with ?mock=1, which bypasses wallet-balance checks so you can step through Token → Oracle → Parameters → Review without funding anything. Do NOT click Deploy on the final step."
            href="/create?mock=1"
            cta="Open /create ?mock=1 →"
            note="Balance checks disabled · still needs a wallet connected for the form to render"
          />
          <LauncherCard
            step="STEP 2"
            color={HYPERP}
            title="Open Trade UI (BONK · long-tail)"
            body="The real /trade page with a populated mock BONK/USDC market. Full production layout: market bar with mark price, chart with 24h history, order panel with leverage slider, position card with NFT mint and warmup-H indicator, recent trades feed. Prices reflect real BONK spot (~$0.00000744)."
            href={`/trade/${MOCK_BONK_SLAB}?mock=1`}
            cta="Open /trade · BONK ?mock=1 →"
            note="?mock=1 enables mock data for this URL only"
          />
        </div>

        <div style={{ marginTop: "1.5rem", padding: "1rem 1.25rem", background: BG_ELEVATED, border: `1px solid ${BORDER}`, fontSize: "12px", color: TEXT_SECONDARY, lineHeight: 1.65 }}>
          <div style={{ fontFamily: mono, fontSize: "10px", color: TEXT_MUTED, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "0.5rem" }}>
            other mock markets · prices live from spot
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <MockLink href={`/trade/${MOCK_SOL_SLAB}?mock=1`} label="SOL · $96.63" />
            <MockLink href={`/trade/${MOCK_WIF_SLAB}?mock=1`} label="WIF · $0.2275" />
            <MockLink href={`/trade/${MOCK_JUP_SLAB}?mock=1`} label="JUP · $0.2469" />
          </div>
        </div>

        <div style={{ marginTop: "2.5rem", paddingTop: "1.5rem", borderTop: `1px dashed ${BORDER}` }}>
          <div style={{ fontFamily: mono, fontSize: "10px", color: PURPLE, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: "0.6rem" }}>
            how to capture
          </div>
          <ol style={{ fontSize: "13px", color: TEXT_SECONDARY, lineHeight: 1.7, paddingLeft: "1.2rem", margin: 0 }}>
            <li>Open <span style={{ color: TEXT, fontFamily: mono }}>Step 1</span> in a new tab. Connect any wallet. Step through the wizard. Screenshot the form at the parameters step (most visually rich).</li>
            <li>Open <span style={{ color: TEXT, fontFamily: mono }}>Step 2</span>. Wait for the chart to render. Screenshot the full trade UI &mdash; market bar + order panel + position card all visible.</li>
            <li>For the deck&apos;s Slide 7 (Demo Product), three captures recommended:
              <ul style={{ marginTop: "0.4rem", paddingLeft: "1.2rem" }}>
                <li><span style={{ color: TEXT, fontFamily: mono }}>screenshot-deposit.png</span> &mdash; create wizard at the Oracle or Parameters step</li>
                <li><span style={{ color: TEXT, fontFamily: mono }}>screenshot-position.png</span> &mdash; trade UI with leverage slider engaged</li>
                <li><span style={{ color: TEXT, fontFamily: mono }}>screenshot-settle.png</span> &mdash; trade UI scrolled to position card (NFT mint visible)</li>
              </ul>
            </li>
            <li>Drop captures into <span style={{ color: TEXT, fontFamily: mono }}>app/public/images/product/</span>. Slide 7 will pick them up automatically.</li>
          </ol>
        </div>

        <div style={{ marginTop: "2rem", fontSize: "11px", color: TEXT_MUTED, fontFamily: mono, letterSpacing: "0.03em" }}>
          source of mock data: <span style={{ color: TEXT_SECONDARY }}>app/lib/mock-trade-data.ts</span>
        </div>
      </div>
    </div>
  );
}

function LauncherCard({ step, color, title, body, href, cta, note }: {
  step: string;
  color: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  note: string;
}) {
  return (
    <div style={{
      background: BG_ELEVATED,
      border: `1px solid ${BORDER}`,
      borderLeft: `2px solid ${color}`,
      padding: "1.5rem 1.5rem 1.25rem",
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{ fontFamily: mono, fontSize: "10px", color, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "0.5rem", fontWeight: 600 }}>
        {step}
      </div>
      <div style={{ fontFamily: mono, fontSize: "1.05rem", fontWeight: 500, color: TEXT, marginBottom: "0.6rem", letterSpacing: "-0.005em" }}>
        {title}
      </div>
      <p style={{ fontSize: "12px", color: TEXT_SECONDARY, lineHeight: 1.6, margin: "0 0 1.2rem", flex: 1 }}>
        {body}
      </p>
      <Link
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-block",
          padding: "0.7rem 1.1rem",
          background: `${color}11`,
          border: `1px solid ${color}`,
          color,
          fontFamily: mono,
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textDecoration: "none",
          textAlign: "center",
        }}
      >
        {cta}
      </Link>
      <div style={{ marginTop: "0.7rem", fontFamily: mono, fontSize: "10px", color: TEXT_MUTED, letterSpacing: "0.02em" }}>
        {note}
      </div>
    </div>
  );
}

function MockLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "inline-block",
        padding: "0.35rem 0.7rem",
        background: "transparent",
        border: `1px solid ${BORDER}`,
        color: HYPERP,
        fontFamily: mono,
        fontSize: "11px",
        textDecoration: "none",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </Link>
  );
}
