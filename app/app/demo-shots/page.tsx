"use client";

// /demo-shots — three pre-populated UI mockups for pitch-deck screenshots.
// No wallet, no RPC. Pure presentational HTML.
// Scroll through, screenshot each section, drop into /public/images/product/.

import { useState } from "react";

const PURPLE = "#9945FF";
const CYAN = "#22D3EE";
const BG = "#0D0D0F";
const PANEL = "rgba(255,255,255,0.025)";
const PANEL_BORDER = "rgba(255,255,255,0.08)";
const TEXT = "#ffffff";
const TEXT_DIM = "rgba(255,255,255,0.55)";
const TEXT_FAINT = "rgba(255,255,255,0.35)";
const GREEN = "#3FCB7E";

const monoFont = "JetBrains Mono, ui-monospace, monospace";
const bodyFont = "Inter, system-ui, sans-serif";

export default function DemoShotsPage() {
  return (
    <div
      style={{
        background: BG,
        color: TEXT,
        fontFamily: bodyFont,
        minHeight: "100vh",
      }}
    >
      {/* Sticky top nav for jumping between sections */}
      <nav
        style={{
          position: "sticky",
          top: 0,
          background: "rgba(13,13,15,0.9)",
          backdropFilter: "blur(8px)",
          borderBottom: `1px solid ${PANEL_BORDER}`,
          padding: "0.75rem 2rem",
          display: "flex",
          gap: "1.5rem",
          fontSize: "0.75rem",
          fontFamily: monoFont,
          letterSpacing: "0.05em",
          zIndex: 100,
        }}
      >
        <span style={{ color: TEXT_FAINT }}>// pitch screenshots</span>
        <a href="#create" style={navLink}>1. CREATE FORM</a>
        <a href="#created" style={navLink}>2. CREATED</a>
        <a href="#trade" style={navLink}>3. TRADE UI</a>
        <span style={{ marginLeft: "auto", color: TEXT_FAINT }}>
          screenshot each section &middot; drop into /images/product/
        </span>
      </nav>

      <CreateMarketScreen />
      <CreatedScreen />
      <TradeScreen />
    </div>
  );
}

const navLink = {
  color: TEXT_DIM,
  textDecoration: "none",
  textTransform: "uppercase" as const,
};

// ─── Section 1 · Create Market form ──────────────────────────────────────────

function CreateMarketScreen() {
  const [baseMint, setBaseMint] = useState(
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
  );
  const [tier, setTier] = useState<"small" | "medium" | "large">("medium");
  const [leverage, setLeverage] = useState(10);
  const [feeBps, setFeeBps] = useState(10);
  const [lpSeed, setLpSeed] = useState(1000);

  return (
    <section id="create" style={sectionWrap}>
      <SectionHeader
        label="// deploy"
        title="Create a perp market"
        sub="Permissionless. Per-market vault, JLP-style LP, ~60 second deploy."
      />

      <div style={formGrid}>
        <FormRow label="Base token mint" hint="Any DEX-listed SPL with spot liquidity">
          <input
            type="text"
            value={baseMint}
            onChange={(e) => setBaseMint(e.target.value)}
            style={inputStyle}
            spellCheck={false}
          />
          <div style={mintBadge}>BONK &middot; spot 24h $14.2M</div>
        </FormRow>

        <FormRow label="Quote" hint="Locked to USDC for closed beta">
          <div style={{ ...inputStyle, color: TEXT, cursor: "default", opacity: 0.7 }}>
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v &middot; USDC
          </div>
        </FormRow>

        <FormRow label="Slab tier" hint="Account size affects max OI">
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {(["small", "medium", "large"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTier(t)}
                style={tier === t ? pillActive : pillInactive}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </FormRow>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <FormRow label={`Max leverage · ${leverage}×`} hint="Initial / maint = 10% / 5%">
            <input
              type="range"
              min={2}
              max={20}
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              style={sliderStyle}
            />
          </FormRow>

          <FormRow label={`Trading fee · ${feeBps} bps`} hint="On notional. Both sides pay.">
            <input
              type="range"
              min={5}
              max={50}
              value={feeBps}
              onChange={(e) => setFeeBps(Number(e.target.value))}
              style={sliderStyle}
            />
          </FormRow>
        </div>

        <FormRow label="Oracle" hint="Pyth primary + pinned on-chain spot reference">
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <div style={pillActive}>PYTH</div>
            <div style={pillInactive}>SWITCHBOARD</div>
            <div style={{ marginLeft: "0.5rem", fontFamily: monoFont, fontSize: "0.78rem", color: TEXT_DIM }}>
              feed: 8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCRecXKLPVJVR &middot; BONK/USD
            </div>
          </div>
        </FormRow>

        <FormRow label={`Initial LP seed · ${lpSeed.toLocaleString()} USDC`} hint="Creator deposit. Earns the creator fee share.">
          <input
            type="range"
            min={500}
            max={50000}
            step={500}
            value={lpSeed}
            onChange={(e) => setLpSeed(Number(e.target.value))}
            style={sliderStyle}
          />
        </FormRow>

        <div style={costEstimate}>
          <div>
            <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.1em" }}>
              EST. DEPLOY COST
            </div>
            <div style={{ fontFamily: monoFont, fontSize: "1.6rem", color: CYAN, marginTop: "0.25rem" }}>
              ~0.029 SOL
            </div>
            <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_DIM, marginTop: "0.2rem" }}>
              rent + LP seed + crank fund
            </div>
          </div>
          <button style={deployButton}>Deploy market &nbsp;→</button>
        </div>
      </div>
    </section>
  );
}

// ─── Section 2 · Created success ─────────────────────────────────────────────

function CreatedScreen() {
  return (
    <section id="created" style={sectionWrap}>
      <SectionHeader label="// deployed" title="Market created" sub="On-chain in ~60 seconds. Ready for trading." />

      <div style={successCard}>
        <div style={successCheckRing}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12.5L10 17L19 7"
              stroke={GREEN}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.12em" }}>
            BONK / USDC PERP &middot; TIER MEDIUM
          </div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600, marginTop: "0.3rem" }}>
            Live on mainnet
          </div>

          <div style={detailGrid}>
            <Detail label="Slab" value="7HwZ9k4xK8YqLnT2vMnR3pAjV5cQeF6BzS8wU1yX3J9Q" />
            <Detail label="LP vault PDA" value="BzC4MnVqR2bN8kHt9pX1J3yK6Wf5LpZ7QrS4Vn2X8mY3" />
            <Detail label="Created at slot" value="234,567,890" />
            <Detail label="LP seeded" value="1,000.00 USDC" />
            <Detail label="Trading fee" value="10 bps · routes to per-market insurance" />
            <Detail label="Permissionless resolve" value="Enabled · 8,640 slots" />
          </div>
        </div>

        <button style={{ ...deployButton, alignSelf: "flex-start" }}>
          Open trading panel &nbsp;→
        </button>
      </div>

      <div style={postCreateCallout}>
        <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.12em", marginBottom: "0.5rem" }}>
          NEXT
        </div>
        Your market shares fees four ways on-chain in the same transaction as
        every trade settles. You earn the creator share until you transfer the
        LP NFT.
      </div>
    </section>
  );
}

// ─── Section 3 · Trade UI ────────────────────────────────────────────────────

function TradeScreen() {
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState(5);
  const [size, setSize] = useState(1000);
  const markPrice = 151.42;
  const entryPrice = markPrice;
  const liqPrice = side === "long"
    ? +(entryPrice * (1 - 0.95 / lev)).toFixed(2)
    : +(entryPrice * (1 + 0.95 / lev)).toFixed(2);
  const fee = +(size * 0.001).toFixed(2);

  return (
    <section id="trade" style={sectionWrap}>
      <SectionHeader
        label="// trade"
        title="SOL / USDC perp"
        sub="Mainnet · closed beta · pinned to Raydium CLMM 3ucNos4N…sUxv"
      />

      {/* Top market bar */}
      <div style={marketBar}>
        <div>
          <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.1em" }}>
            MARK PRICE
          </div>
          <div style={{ fontFamily: monoFont, fontSize: "1.8rem", color: TEXT, marginTop: "0.2rem" }}>
            ${markPrice.toFixed(2)}
          </div>
        </div>
        <Stat label="24H CHANGE" value="+2.31%" color={GREEN} />
        <Stat label="24H VOLUME" value="$0" sub="closed beta" />
        <Stat label="OPEN INTEREST" value="$0" sub="closed beta" />
        <Stat label="FUNDING (1H)" value="+0.0012%" />
      </div>

      <div style={tradeGrid}>
        {/* Left — order panel */}
        <div style={panel}>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
            <button
              onClick={() => setSide("long")}
              style={side === "long" ? sideLong : sideInactive}
            >
              LONG
            </button>
            <button
              onClick={() => setSide("short")}
              style={side === "short" ? sideShort : sideInactive}
            >
              SHORT
            </button>
          </div>

          <FormRow label={`Leverage · ${lev}×`} hint="Max 10×">
            <input
              type="range"
              min={1}
              max={10}
              value={lev}
              onChange={(e) => setLev(Number(e.target.value))}
              style={sliderStyle}
            />
          </FormRow>

          <FormRow label="Size · USDC" hint="Notional, not margin">
            <input
              type="number"
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              style={inputStyle}
            />
          </FormRow>

          <div style={previewBox}>
            <PreviewRow label="Entry" value={`$${entryPrice.toFixed(2)}`} />
            <PreviewRow label="Liquidation" value={`$${liqPrice}`} />
            <PreviewRow label="Margin required" value={`${(size / lev).toFixed(2)} USDC`} />
            <PreviewRow label="Trading fee (10 bps)" value={`${fee.toFixed(2)} USDC`} sub="routes to per-market insurance" />
          </div>

          <button style={side === "long" ? openLong : openShort}>
            Open {side === "long" ? "Long" : "Short"} &middot; ${size.toLocaleString()} &middot; {lev}×
          </button>

          <div style={{ marginTop: "0.85rem", fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, lineHeight: 1.6 }}>
            Position mints as Token-2022 NFT. Transferable. Per-market vault is your counterparty.
          </div>
        </div>

        {/* Right — open positions + recent trades */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={panel}>
            <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.12em", marginBottom: "0.85rem" }}>
              OPEN POSITION
            </div>
            <div style={positionCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>SOL Long &middot; 5×</div>
                  <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, marginTop: "0.2rem" }}>
                    Opened 4 min ago
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: monoFont, fontSize: "1.2rem", color: GREEN }}>
                    +$21.45
                  </div>
                  <div style={{ fontFamily: monoFont, fontSize: "0.75rem", color: GREEN, opacity: 0.8 }}>
                    +1.69%
                  </div>
                </div>
              </div>

              <div style={positionDetailGrid}>
                <Detail label="Entry" value="$148.20" mono />
                <Detail label="Mark" value="$151.42" mono />
                <Detail label="Size" value="$1,000 notional" mono />
                <Detail label="Margin" value="$200 USDC" mono />
              </div>

              <div style={nftRow}>
                <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.1em" }}>
                  TOKEN-2022 NFT POSITION
                </div>
                <div style={nftMint}>
                  PnGT8jKqR4mN9wXzL2vYbC5fH7AkS3rD6QpV1uE9JhM4 ↗
                </div>
                <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, marginTop: "0.4rem" }}>
                  Transferable. First perp-position primitive on Solana.
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
                <button style={closeBtn}>Close &middot; Market</button>
                <button style={addBtn}>Add &middot; Margin</button>
              </div>
            </div>
          </div>

          <div style={panel}>
            <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.12em", marginBottom: "0.85rem" }}>
              RECENT TRADES &middot; SOL/USDC
            </div>
            {[
              { side: "BUY", price: 151.42, size: 250, time: "12s ago" },
              { side: "SELL", price: 151.40, size: 180, time: "34s ago" },
              { side: "BUY", price: 151.41, size: 410, time: "1m ago" },
              { side: "BUY", price: 151.38, size: 95, time: "1m ago" },
              { side: "SELL", price: 151.35, size: 620, time: "2m ago" },
            ].map((t, i) => (
              <div key={i} style={tradeRow}>
                <span style={{ color: t.side === "BUY" ? GREEN : "#FF6B7A", fontFamily: monoFont, fontSize: "0.75rem", fontWeight: 700, width: "44px" }}>
                  {t.side}
                </span>
                <span style={{ fontFamily: monoFont, fontSize: "0.78rem", color: TEXT, flex: 1 }}>
                  ${t.price.toFixed(2)}
                </span>
                <span style={{ fontFamily: monoFont, fontSize: "0.75rem", color: TEXT_DIM, flex: 1 }}>
                  ${t.size}
                </span>
                <span style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT }}>
                  {t.time}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SectionHeader({ label, title, sub }: { label: string; title: string; sub: string }) {
  return (
    <div style={{ marginBottom: "2rem" }}>
      <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: PURPLE, letterSpacing: "0.18em", marginBottom: "0.4rem" }}>
        {label}
      </div>
      <h1 style={{ fontSize: "2rem", fontWeight: 600, letterSpacing: "-0.015em", margin: 0 }}>{title}</h1>
      <div style={{ fontSize: "0.95rem", color: TEXT_DIM, marginTop: "0.5rem" }}>{sub}</div>
    </div>
  );
}

function FormRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.4rem" }}>
        <div style={{ fontFamily: monoFont, fontSize: "0.72rem", color: TEXT, letterSpacing: "0.06em", fontWeight: 600 }}>
          {label.toUpperCase()}
        </div>
        <div style={{ fontFamily: monoFont, fontSize: "0.68rem", color: TEXT_FAINT }}>{hint}</div>
      </div>
      {children}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontFamily: monoFont, fontSize: "0.66rem", color: TEXT_FAINT, letterSpacing: "0.08em" }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: mono ? monoFont : bodyFont, fontSize: mono ? "0.85rem" : "0.92rem", color: TEXT, marginTop: "0.2rem", wordBreak: "break-all" }}>
        {value}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: monoFont, fontSize: "0.7rem", color: TEXT_FAINT, letterSpacing: "0.1em" }}>{label}</div>
      <div style={{ fontFamily: monoFont, fontSize: "1.15rem", color: color || TEXT, marginTop: "0.25rem" }}>{value}</div>
      {sub && <div style={{ fontFamily: monoFont, fontSize: "0.65rem", color: TEXT_FAINT, marginTop: "0.15rem" }}>{sub}</div>}
    </div>
  );
}

function PreviewRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "0.4rem 0", borderBottom: `1px dashed ${PANEL_BORDER}` }}>
      <div>
        <div style={{ fontFamily: monoFont, fontSize: "0.72rem", color: TEXT_DIM }}>{label}</div>
        {sub && <div style={{ fontFamily: monoFont, fontSize: "0.62rem", color: TEXT_FAINT, marginTop: "0.15rem" }}>{sub}</div>}
      </div>
      <div style={{ fontFamily: monoFont, fontSize: "0.85rem", color: TEXT }}>{value}</div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const sectionWrap: React.CSSProperties = {
  maxWidth: "1100px",
  margin: "0 auto",
  padding: "3rem 2rem 5rem",
  borderBottom: `1px dashed ${PANEL_BORDER}`,
};

const formGrid: React.CSSProperties = {
  background: PANEL,
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "12px",
  padding: "1.75rem 2rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.3)",
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "8px",
  padding: "0.7rem 0.85rem",
  color: TEXT,
  fontFamily: monoFont,
  fontSize: "0.85rem",
  outline: "none",
};

const sliderStyle: React.CSSProperties = {
  width: "100%",
  accentColor: PURPLE,
};

const pillBase: React.CSSProperties = {
  fontFamily: monoFont,
  fontSize: "0.72rem",
  letterSpacing: "0.08em",
  padding: "0.5rem 1rem",
  borderRadius: "8px",
  cursor: "pointer",
  fontWeight: 600,
};

const pillActive: React.CSSProperties = {
  ...pillBase,
  background: `linear-gradient(135deg, ${PURPLE}, ${CYAN})`,
  border: `1px solid ${CYAN}`,
  color: TEXT,
};

const pillInactive: React.CSSProperties = {
  ...pillBase,
  background: "transparent",
  border: `1px solid ${PANEL_BORDER}`,
  color: TEXT_DIM,
};

const mintBadge: React.CSSProperties = {
  marginTop: "0.5rem",
  display: "inline-block",
  fontFamily: monoFont,
  fontSize: "0.68rem",
  color: CYAN,
  background: "rgba(34,211,238,0.08)",
  border: `1px solid rgba(34,211,238,0.2)`,
  borderRadius: "6px",
  padding: "0.25rem 0.55rem",
  letterSpacing: "0.04em",
};

const costEstimate: React.CSSProperties = {
  marginTop: "1.5rem",
  paddingTop: "1.5rem",
  borderTop: `1px solid ${PANEL_BORDER}`,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1.5rem",
};

const deployButton: React.CSSProperties = {
  background: `linear-gradient(135deg, ${PURPLE}, ${CYAN})`,
  border: "none",
  color: TEXT,
  fontFamily: monoFont,
  fontSize: "0.85rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  padding: "0.85rem 1.6rem",
  borderRadius: "10px",
  cursor: "pointer",
};

const successCard: React.CSSProperties = {
  background: `linear-gradient(135deg, rgba(63,203,126,0.06), rgba(34,211,238,0.04))`,
  border: `1px solid rgba(63,203,126,0.3)`,
  borderRadius: "14px",
  padding: "2rem",
  display: "flex",
  gap: "1.5rem",
  alignItems: "flex-start",
};

const successCheckRing: React.CSSProperties = {
  width: "56px",
  height: "56px",
  borderRadius: "50%",
  background: "rgba(63,203,126,0.1)",
  border: `2px solid ${GREEN}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const detailGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.85rem 1.5rem",
  marginTop: "1.25rem",
};

const postCreateCallout: React.CSSProperties = {
  marginTop: "1.5rem",
  padding: "1rem 1.25rem",
  background: PANEL,
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "10px",
  fontSize: "0.88rem",
  color: TEXT_DIM,
  lineHeight: 1.6,
};

const marketBar: React.CSSProperties = {
  background: PANEL,
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "12px",
  padding: "1.25rem 1.75rem",
  display: "flex",
  gap: "2.5rem",
  alignItems: "center",
  marginBottom: "1.5rem",
};

const tradeGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 380px) 1fr",
  gap: "1.25rem",
};

const panel: React.CSSProperties = {
  background: PANEL,
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "12px",
  padding: "1.5rem 1.5rem",
};

const sideBase: React.CSSProperties = {
  flex: 1,
  padding: "0.7rem",
  borderRadius: "8px",
  fontFamily: monoFont,
  fontSize: "0.85rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  cursor: "pointer",
};

const sideLong: React.CSSProperties = {
  ...sideBase,
  background: GREEN,
  border: `1px solid ${GREEN}`,
  color: "#0D0D0F",
};

const sideShort: React.CSSProperties = {
  ...sideBase,
  background: "#FF6B7A",
  border: `1px solid #FF6B7A`,
  color: "#0D0D0F",
};

const sideInactive: React.CSSProperties = {
  ...sideBase,
  background: "transparent",
  border: `1px solid ${PANEL_BORDER}`,
  color: TEXT_DIM,
};

const previewBox: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "8px",
  padding: "0.5rem 0.95rem",
  margin: "0.85rem 0",
};

const openLong: React.CSSProperties = {
  width: "100%",
  background: GREEN,
  border: "none",
  color: "#0D0D0F",
  fontFamily: monoFont,
  fontSize: "0.85rem",
  fontWeight: 700,
  letterSpacing: "0.04em",
  padding: "0.95rem",
  borderRadius: "10px",
  cursor: "pointer",
  marginTop: "0.5rem",
};

const openShort: React.CSSProperties = {
  ...openLong,
  background: "#FF6B7A",
};

const positionCard: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: "10px",
  padding: "1.1rem 1.25rem",
};

const positionDetailGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.6rem 1.25rem",
  paddingBottom: "1rem",
  borderBottom: `1px dashed ${PANEL_BORDER}`,
};

const nftRow: React.CSSProperties = {
  paddingTop: "1rem",
};

const nftMint: React.CSSProperties = {
  fontFamily: monoFont,
  fontSize: "0.82rem",
  color: CYAN,
  marginTop: "0.4rem",
  wordBreak: "break-all",
};

const closeBtn: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: `1px solid ${PANEL_BORDER}`,
  color: TEXT,
  fontFamily: monoFont,
  fontSize: "0.78rem",
  padding: "0.6rem",
  borderRadius: "8px",
  cursor: "pointer",
  letterSpacing: "0.05em",
};

const addBtn: React.CSSProperties = {
  ...closeBtn,
  color: CYAN,
  borderColor: "rgba(34,211,238,0.4)",
};

const tradeRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.4rem 0",
  borderBottom: `1px dashed ${PANEL_BORDER}`,
};
