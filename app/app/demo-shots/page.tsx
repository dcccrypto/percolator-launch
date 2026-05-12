"use client";

// /demo-shots — three pre-populated UI mockups for pitch-deck screenshots.
// No wallet, no RPC. Visually matches the actual Percolator create + trade UI.
// Scroll through, screenshot each section, drop into /public/images/product/.

import { useState } from "react";

// Real CSS tokens from app/globals.css
const BG = "#0A0A0F";
const BG_ELEVATED = "#0F1018";
const BG_SURFACE = "#141820";
const BORDER = "#1C1F2E";
const BORDER_SUBTLE = "#14161F";
const BORDER_HOVER = "#2A2E42";
const ACCENT = "#9945FF";           // Solana purple
const ACCENT_SUBTLE = "rgba(153,69,255,0.06)";
const HYPERP = "#22D3EE";           // HYPERP cyan
const HYPERP_SUBTLE = "rgba(34,211,238,0.10)";
const PYTH_VIOLET = "#A78BFA";
const TEXT = "#E1E2E8";
const TEXT_SECONDARY = "#7A7F96";
const TEXT_MUTED = "#454B5F";
const TEXT_DIM = "#2A2E3D";
const LONG = "#14F195";              // Solana green
const SHORT = "#FF3B5C";

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
      <nav
        style={{
          position: "sticky",
          top: 0,
          background: "rgba(10,10,15,0.92)",
          backdropFilter: "blur(8px)",
          borderBottom: `1px solid ${BORDER}`,
          padding: "0.75rem 2rem",
          display: "flex",
          gap: "1.5rem",
          fontSize: "10px",
          fontFamily: monoFont,
          letterSpacing: "0.08em",
          zIndex: 100,
          textTransform: "uppercase",
        }}
      >
        <span style={{ color: TEXT_MUTED }}>// pitch screenshots</span>
        <a href="#create" style={navLink}>1. CREATE FORM</a>
        <a href="#created" style={navLink}>2. CREATED</a>
        <a href="#trade" style={navLink}>3. TRADE UI</a>
        <span style={{ marginLeft: "auto", color: TEXT_MUTED }}>
          screenshot each &middot; save to /images/product/
        </span>
      </nav>

      <CreateMarketScreen />
      <CreatedScreen />
      <TradeScreen />
    </div>
  );
}

const navLink: React.CSSProperties = {
  color: TEXT_SECONDARY,
  textDecoration: "none",
};

// ─── Section 1 · Create Market form ──────────────────────────────────────────

function CreateMarketScreen() {
  // BONK token mint (long-tail SPL with DEX liquidity but no perp anywhere)
  const baseMint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const [tier, setTier] = useState<"small" | "medium" | "large">("medium");
  const [leverage, setLeverage] = useState(10);
  const [feeBps, setFeeBps] = useState(10);
  const [lpSeed, setLpSeed] = useState(1000);
  const [oracleType, setOracleType] = useState<"pyth" | "hyperp_ema">("hyperp_ema");

  return (
    <section id="create" style={sectionWrap}>
      <SectionHeader label="// deploy" title="Create perp market" sub="Step 2 of 4 · Oracle &amp; parameters" />

      <div style={card}>
        <FormRow label="Base token mint" hint="Any DEX-listed SPL with $50K+ daily spot volume">
          <input
            type="text"
            defaultValue={baseMint}
            style={inputStyle}
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center" }}>
            <Badge color={LONG} bg="rgba(20,241,149,0.08)">✓ Valid mint &middot; 5 decimals</Badge>
            <Badge color={HYPERP} bg={HYPERP_SUBTLE}>BONK &middot; spot 24h $14.2M</Badge>
          </div>
        </FormRow>

        <div style={{ height: 1, background: BORDER_SUBTLE, margin: "1.25rem 0" }} />

        <div>
          <Label>Oracle</Label>
          <p style={{ fontSize: "11px", color: TEXT_SECONDARY, marginTop: "0.3rem", marginBottom: "0.85rem" }}>
            How should this market price be determined?
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <OracleCard
              label="PYTH NETWORK"
              desc="Off-chain price feed"
              detail="Best for: major tokens with Pyth price feeds"
              note="● Available for SOL, BTC, ETH"
              selected={oracleType === "pyth"}
              onClick={() => setOracleType("pyth")}
            />
            <OracleCard
              label="HYPERP EMA"
              desc="On-chain DEX pool EMA"
              detail="Best for: new / long-tail tokens"
              note="● Auto-selected · BONK has $14M Raydium pool"
              selected={oracleType === "hyperp_ema"}
              onClick={() => setOracleType("hyperp_ema")}
            />
          </div>

          {oracleType === "hyperp_ema" && (
            <div style={{ marginTop: "0.85rem" }}>
              <div style={{ ...inputStyle, color: HYPERP, fontSize: "11px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>3ucNos4NPDqRJWoHfiCJSCgPxn2yPmYbE3svSDdsUxv</span>
                <span style={{ color: TEXT_SECONDARY, fontSize: "10px" }}>Raydium CLMM &middot; $14.2M liq ✓</span>
              </div>
            </div>
          )}
          {oracleType === "pyth" && (
            <div style={{ marginTop: "0.85rem", padding: "0.65rem 0.85rem", background: "rgba(255,59,92,0.04)", border: `1px solid rgba(255,59,92,0.25)`, fontSize: "11px" }}>
              <span style={{ color: SHORT }}>✗ No Pyth feed for BONK</span>
              <span style={{ color: TEXT_SECONDARY, marginLeft: "0.5rem" }}>Switch to HYPERP EMA</span>
            </div>
          )}
        </div>

        <div style={{ height: 1, background: BORDER_SUBTLE, margin: "1.25rem 0" }} />

        <FormRow label="Slab tier" hint="Account size sets max OI ceiling">
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
            <span style={{ marginLeft: "auto", fontFamily: monoFont, fontSize: "10px", color: TEXT_SECONDARY, alignSelf: "center" }}>
              max OI: {tier === "small" ? "$500K" : tier === "medium" ? "$5M" : "$50M"}
            </span>
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

          <FormRow label={`Trading fee · ${feeBps} bps`} hint="On notional. Routes to per-market insurance.">
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

        <FormRow label={`Initial LP seed · ${lpSeed.toLocaleString()} USDC`} hint="Your deposit. You earn the creator fee share until you transfer the LP NFT.">
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
            <div style={miniLabel}>EST. DEPLOY COST</div>
            <div style={{ fontFamily: monoFont, fontSize: "1.4rem", color: HYPERP, marginTop: "0.25rem", letterSpacing: "-0.01em" }}>
              ~0.029 SOL
            </div>
            <div style={{ fontFamily: monoFont, fontSize: "10px", color: TEXT_SECONDARY, marginTop: "0.2rem" }}>
              slab rent + LP seed + crank fund
            </div>
          </div>
          <button style={hudButtonPrimary}>
            <span style={{ position: "relative", zIndex: 1 }}>CONTINUE  →</span>
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── Section 2 · Created success ─────────────────────────────────────────────

function CreatedScreen() {
  return (
    <section id="created" style={sectionWrap}>
      <SectionHeader label="// deployed" title="Market live on mainnet" sub="On-chain in ~60 seconds. Ready for trading." />

      <div style={successCard}>
        <div style={successCheckRing}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12.5L10 17L19 7"
              stroke={LONG}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ ...miniLabel, color: LONG }}>BONK / USDC PERP &middot; MEDIUM TIER &middot; HYPERP EMA</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600, marginTop: "0.3rem", fontFamily: monoFont, letterSpacing: "-0.01em" }}>
            Market created
          </div>

          <div style={detailGrid}>
            <Detail label="Slab account" value="7HwZ9k4xK8YqLnT2vMnR3pAjV5cQeF6BzS8wU1yX3J9Q" mono />
            <Detail label="LP vault PDA" value="BzC4MnVqR2bN8kHt9pX1J3yK6Wf5LpZ7QrS4Vn2X8mY3" mono />
            <Detail label="Created at slot" value="234,567,890" mono />
            <Detail label="LP seeded" value="1,000.00 USDC" mono />
            <Detail label="Pinned Raydium pool" value="3ucNos4N…sUxv · $14.2M liq" mono />
            <Detail label="Trading fee" value="10 bps · routes to insurance" />
            <Detail label="Permissionless resolve" value="Enabled · 8,640 slots cooldown" />
            <Detail label="Status" value="Live · oracle cranked" />
          </div>
        </div>

        <button style={{ ...hudButtonPrimary, alignSelf: "flex-start" }}>
          <span style={{ position: "relative", zIndex: 1 }}>OPEN TRADING  →</span>
        </button>
      </div>

      <div style={postCreateCallout}>
        <div style={{ ...miniLabel, marginBottom: "0.5rem" }}>NEXT</div>
        Trades route fee to the per-market insurance fund. LPs accrue via the
        vault crank. You earn the creator share until you transfer the LP NFT.
        The four-way split with creator and protocol routing ships with audit Q3.
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
        sub="Mainnet · closed beta · pinned Raydium CLMM 3ucNos4N…sUxv"
      />

      {/* Top market bar */}
      <div style={marketBar}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <div style={solIconRing}>S</div>
          <div>
            <div style={{ fontFamily: monoFont, fontSize: "11px", color: TEXT, letterSpacing: "0.05em" }}>
              SOL/USDC
            </div>
            <div style={{ fontFamily: monoFont, fontSize: "9px", color: TEXT_SECONDARY, letterSpacing: "0.08em" }}>
              PERP &middot; MEDIUM
            </div>
          </div>
        </div>

        <HyperpBadge />
        <HealthBadge />

        <Stat label="MARK" value={`$${markPrice.toFixed(2)}`} bigger />
        <Stat label="24H CHANGE" value="+2.31%" color={LONG} />
        <Stat label="24H VOLUME" value="$0" sub="closed beta" />
        <Stat label="FUNDING / 8H" value="+0.094%" color={LONG} />
      </div>

      <div style={tradeGrid}>
        {/* Left — order panel */}
        <div style={card}>
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

          <FormRow label={`Leverage · ${lev}×`} hint="Max 10× · IM 10%">
            <input
              type="range"
              min={1}
              max={10}
              value={lev}
              onChange={(e) => setLev(Number(e.target.value))}
              style={sliderStyle}
            />
          </FormRow>

          <FormRow label="Size · USDC notional" hint="Margin = size / leverage">
            <input
              type="number"
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              style={inputStyle}
            />
          </FormRow>

          <div style={previewBox}>
            <PreviewRow label="Entry" value={`$${entryPrice.toFixed(2)}`} />
            <PreviewRow label="Liquidation" value={`$${liqPrice}`} color={SHORT} />
            <PreviewRow label="Margin required" value={`${(size / lev).toFixed(2)} USDC`} />
            <PreviewRow label="Trading fee · 10 bps" value={`${fee.toFixed(2)} USDC`} sub="→ per-market insurance" />
            <PreviewRow label="Warmup window" value="60 slots" sub="PnL extract gate" />
          </div>

          <button style={side === "long" ? openLong : openShort}>
            OPEN {side === "long" ? "LONG" : "SHORT"} &middot; ${size.toLocaleString()} &middot; {lev}×
          </button>

          <div style={{ marginTop: "0.85rem", fontFamily: monoFont, fontSize: "10px", color: TEXT_MUTED, lineHeight: 1.6, letterSpacing: "0.02em" }}>
            Position mints as Token-2022 NFT. Transferable. LP vault is your counterparty (no MM).
          </div>
        </div>

        {/* Right — open position + recent trades */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <div style={card}>
            <div style={{ ...miniLabel, marginBottom: "0.85rem" }}>OPEN POSITION</div>
            <div style={positionCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem" }}>
                <div>
                  <div style={{ fontFamily: monoFont, fontWeight: 700, fontSize: "12px", letterSpacing: "0.05em" }}>
                    SOL LONG &middot; 5×
                  </div>
                  <div style={{ fontFamily: monoFont, fontSize: "10px", color: TEXT_MUTED, marginTop: "0.2rem" }}>
                    opened 4m ago &middot; slot 234,571,203
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: monoFont, fontSize: "1.2rem", color: LONG, letterSpacing: "-0.01em" }}>
                    +$21.45
                  </div>
                  <div style={{ fontFamily: monoFont, fontSize: "10px", color: LONG, opacity: 0.85 }}>
                    +1.69%
                  </div>
                </div>
              </div>

              <div style={positionDetailGrid}>
                <Detail label="Entry" value="$148.20" mono />
                <Detail label="Mark" value="$151.42" mono />
                <Detail label="Size" value="$1,000 notional" mono />
                <Detail label="Margin" value="$200 USDC" mono />
                <Detail label="Liq price" value="$119.46" mono />
                <Detail label="Funding paid" value="$0.12" mono />
              </div>

              {/* Warmup progress — unique Percolator UI element */}
              <div style={warmupBar}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.35rem" }}>
                  <div style={{ ...miniLabel, color: HYPERP }}>WARMUP &middot; PNL EXTRACT GATE</div>
                  <div style={{ fontFamily: monoFont, fontSize: "10px", color: HYPERP }}>42 / 60 slots</div>
                </div>
                <div style={warmupTrack}>
                  <div style={{ ...warmupFill, width: "70%" }} />
                </div>
                <div style={{ fontFamily: monoFont, fontSize: "9px", color: TEXT_MUTED, marginTop: "0.3rem", letterSpacing: "0.04em" }}>
                  positive PnL extractable in ~12s · prevents oracle-manipulate-then-extract
                </div>
              </div>

              <div style={nftRow}>
                <div style={miniLabel}>TOKEN-2022 NFT POSITION</div>
                <div style={nftMint}>
                  PnGT8jKqR4mN9wXzL2vYbC5fH7AkS3rD6QpV1uE9JhM4 ↗
                </div>
                <div style={{ fontFamily: monoFont, fontSize: "10px", color: TEXT_MUTED, marginTop: "0.35rem" }}>
                  transferable · first perp-position primitive on Solana
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
                <button style={closeBtn}>CLOSE · MARKET</button>
                <button style={addBtn}>ADD · MARGIN</button>
                <button style={sendBtn}>SEND NFT</button>
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ ...miniLabel, marginBottom: "0.85rem" }}>RECENT TRADES &middot; SOL/USDC</div>
            {[
              { side: "BUY", price: 151.42, size: 250, time: "12s" },
              { side: "SELL", price: 151.40, size: 180, time: "34s" },
              { side: "BUY", price: 151.41, size: 410, time: "1m" },
              { side: "BUY", price: 151.38, size: 95, time: "1m" },
              { side: "SELL", price: 151.35, size: 620, time: "2m" },
            ].map((t, i) => (
              <div key={i} style={tradeRow}>
                <span style={{ color: t.side === "BUY" ? LONG : SHORT, fontFamily: monoFont, fontSize: "10px", fontWeight: 700, width: "40px", letterSpacing: "0.06em" }}>
                  {t.side}
                </span>
                <span style={{ fontFamily: monoFont, fontSize: "11px", color: TEXT, flex: 1 }}>
                  ${t.price.toFixed(2)}
                </span>
                <span style={{ fontFamily: monoFont, fontSize: "11px", color: TEXT_SECONDARY, flex: 1 }}>
                  ${t.size}
                </span>
                <span style={{ fontFamily: monoFont, fontSize: "10px", color: TEXT_MUTED }}>
                  {t.time} ago
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
    <div style={{ marginBottom: "1.5rem" }}>
      <div style={{ fontFamily: monoFont, fontSize: "10px", color: ACCENT, letterSpacing: "0.25em", marginBottom: "0.5rem", opacity: 0.7, textTransform: "uppercase" }}>
        {label}
      </div>
      <h1 style={{ fontSize: "1.65rem", fontWeight: 500, letterSpacing: "-0.01em", margin: 0, fontFamily: monoFont, color: TEXT }}>
        {title}
      </h1>
      <div style={{ fontSize: "12px", color: TEXT_SECONDARY, marginTop: "0.4rem" }}>{sub}</div>
    </div>
  );
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.4rem" }}>
        <Label>{label}</Label>
        {hint && <div style={{ fontFamily: monoFont, fontSize: "10px", color: TEXT_MUTED }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: monoFont, fontSize: "11px", color: TEXT, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 500 }}>
      {children}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={miniLabel}>{label.toUpperCase()}</div>
      <div style={{
        fontFamily: mono ? monoFont : bodyFont,
        fontSize: mono ? "11px" : "12px",
        color: TEXT,
        marginTop: "0.2rem",
        wordBreak: "break-all",
      }}>
        {value}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color, bigger }: { label: string; value: string; sub?: string; color?: string; bigger?: boolean }) {
  return (
    <div>
      <div style={miniLabel}>{label}</div>
      <div style={{
        fontFamily: monoFont,
        fontSize: bigger ? "16px" : "13px",
        color: color || TEXT,
        marginTop: "0.25rem",
        letterSpacing: "-0.005em",
      }}>{value}</div>
      {sub && <div style={{ fontFamily: monoFont, fontSize: "9px", color: TEXT_MUTED, marginTop: "0.15rem" }}>{sub}</div>}
    </div>
  );
}

function PreviewRow({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "0.4rem 0", borderBottom: `1px dashed ${BORDER_SUBTLE}` }}>
      <div>
        <div style={{ fontFamily: monoFont, fontSize: "11px", color: TEXT_SECONDARY }}>{label}</div>
        {sub && <div style={{ fontFamily: monoFont, fontSize: "9px", color: TEXT_MUTED, marginTop: "0.15rem" }}>{sub}</div>}
      </div>
      <div style={{ fontFamily: monoFont, fontSize: "12px", color: color || TEXT }}>{value}</div>
    </div>
  );
}

function OracleCard({ label, desc, detail, note, selected, onClick }: {
  label: string;
  desc: string;
  detail: string;
  note: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "0.85rem",
        textAlign: "left",
        border: selected ? `1px solid ${ACCENT}` : `1px solid ${BORDER}`,
        background: selected ? ACCENT_SUBTLE : "transparent",
        cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      <div style={{ fontFamily: monoFont, fontSize: "12px", color: TEXT, letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ marginTop: "0.4rem", height: 1, background: BORDER }} />
      <div style={{ marginTop: "0.5rem", fontSize: "11px", color: TEXT_SECONDARY }}>{desc}</div>
      <div style={{ marginTop: "0.25rem", fontSize: "10px", color: TEXT_SECONDARY }}>{detail}</div>
      <div style={{ marginTop: "0.5rem", fontSize: "9px", color: selected ? ACCENT : TEXT_MUTED }}>{note}</div>
    </button>
  );
}

function Badge({ children, color, bg }: { children: React.ReactNode; color: string; bg: string }) {
  return (
    <span style={{
      display: "inline-block",
      fontFamily: monoFont,
      fontSize: "10px",
      color,
      background: bg,
      border: `1px solid ${color}`,
      padding: "0.2rem 0.5rem",
      letterSpacing: "0.04em",
    }}>
      {children}
    </span>
  );
}

function HyperpBadge() {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "0.3rem",
      fontFamily: monoFont,
      fontSize: "9px",
      color: HYPERP,
      background: HYPERP_SUBTLE,
      border: `1px solid ${HYPERP}`,
      padding: "0.25rem 0.55rem",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={HYPERP} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l8.5 5v10L12 22l-8.5-5V7z" />
      </svg>
      HYPERP
    </span>
  );
}

function HealthBadge() {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "0.25rem",
      fontFamily: monoFont,
      fontSize: "9px",
      color: LONG,
      background: "rgba(20,241,149,0.10)",
      border: `1px solid rgba(20,241,149,0.4)`,
      padding: "0.25rem 0.55rem",
      letterSpacing: "0.08em",
    }}>
      <span>●</span> LIVE
    </span>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const sectionWrap: React.CSSProperties = {
  maxWidth: "1100px",
  margin: "0 auto",
  padding: "2.5rem 2rem 4rem",
  borderBottom: `1px dashed ${BORDER}`,
};

const card: React.CSSProperties = {
  background: BG_ELEVATED,
  border: `1px solid ${BORDER}`,
  padding: "1.5rem 1.75rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: BG,
  border: `1px solid ${BORDER}`,
  padding: "0.65rem 0.85rem",
  color: TEXT,
  fontFamily: monoFont,
  fontSize: "12px",
  outline: "none",
};

const sliderStyle: React.CSSProperties = {
  width: "100%",
  accentColor: ACCENT,
};

const pillBase: React.CSSProperties = {
  fontFamily: monoFont,
  fontSize: "11px",
  letterSpacing: "0.08em",
  padding: "0.5rem 1rem",
  cursor: "pointer",
  fontWeight: 600,
  transition: "all 0.15s",
};

const pillActive: React.CSSProperties = {
  ...pillBase,
  background: ACCENT_SUBTLE,
  border: `1px solid ${ACCENT}`,
  color: ACCENT,
};

const pillInactive: React.CSSProperties = {
  ...pillBase,
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: TEXT_SECONDARY,
};

const miniLabel: React.CSSProperties = {
  fontFamily: monoFont,
  fontSize: "9px",
  color: TEXT_MUTED,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
};

const costEstimate: React.CSSProperties = {
  marginTop: "1.5rem",
  paddingTop: "1.5rem",
  borderTop: `1px solid ${BORDER}`,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1.5rem",
};

const hudButtonPrimary: React.CSSProperties = {
  background: ACCENT_SUBTLE,
  border: `1px solid ${ACCENT}`,
  color: ACCENT,
  fontFamily: monoFont,
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.1em",
  padding: "0.85rem 1.6rem",
  cursor: "pointer",
  textTransform: "uppercase",
  position: "relative",
};

const successCard: React.CSSProperties = {
  background: "linear-gradient(135deg, rgba(20,241,149,0.04), rgba(34,211,238,0.03))",
  border: `1px solid rgba(20,241,149,0.3)`,
  padding: "1.75rem",
  display: "flex",
  gap: "1.5rem",
  alignItems: "flex-start",
};

const successCheckRing: React.CSSProperties = {
  width: "48px",
  height: "48px",
  background: "rgba(20,241,149,0.08)",
  border: `1.5px solid ${LONG}`,
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
  marginTop: "1.25rem",
  padding: "1rem 1.25rem",
  background: BG_ELEVATED,
  border: `1px solid ${BORDER}`,
  fontSize: "12px",
  color: TEXT_SECONDARY,
  lineHeight: 1.6,
};

const marketBar: React.CSSProperties = {
  background: BG_ELEVATED,
  border: `1px solid ${BORDER}`,
  padding: "1rem 1.5rem",
  display: "flex",
  gap: "2rem",
  alignItems: "center",
  marginBottom: "1rem",
};

const solIconRing: React.CSSProperties = {
  width: "32px",
  height: "32px",
  background: "linear-gradient(135deg, #14F195, #9945FF)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: monoFont,
  fontSize: "14px",
  fontWeight: 700,
  color: BG,
};

const tradeGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 360px) 1fr",
  gap: "1rem",
};

const sideBase: React.CSSProperties = {
  flex: 1,
  padding: "0.7rem",
  fontFamily: monoFont,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.1em",
  cursor: "pointer",
  transition: "all 0.15s",
};

const sideLong: React.CSSProperties = {
  ...sideBase,
  background: "rgba(20,241,149,0.12)",
  border: `1px solid ${LONG}`,
  color: LONG,
};

const sideShort: React.CSSProperties = {
  ...sideBase,
  background: "rgba(255,59,92,0.12)",
  border: `1px solid ${SHORT}`,
  color: SHORT,
};

const sideInactive: React.CSSProperties = {
  ...sideBase,
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: TEXT_SECONDARY,
};

const previewBox: React.CSSProperties = {
  background: BG,
  border: `1px solid ${BORDER}`,
  padding: "0.5rem 0.95rem",
  margin: "0.85rem 0",
};

const openLong: React.CSSProperties = {
  width: "100%",
  background: "rgba(20,241,149,0.15)",
  border: `1px solid ${LONG}`,
  color: LONG,
  fontFamily: monoFont,
  fontSize: "12px",
  fontWeight: 700,
  letterSpacing: "0.1em",
  padding: "0.9rem",
  cursor: "pointer",
  marginTop: "0.5rem",
};

const openShort: React.CSSProperties = {
  ...openLong,
  background: "rgba(255,59,92,0.15)",
  borderColor: SHORT,
  color: SHORT,
};

const positionCard: React.CSSProperties = {
  background: BG,
  border: `1px solid ${BORDER}`,
  padding: "1.1rem 1.25rem",
};

const positionDetailGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: "0.7rem 1rem",
  paddingBottom: "1rem",
  borderBottom: `1px dashed ${BORDER}`,
};

const warmupBar: React.CSSProperties = {
  marginTop: "1rem",
  padding: "0.75rem 0.85rem",
  background: HYPERP_SUBTLE,
  border: `1px solid rgba(34,211,238,0.3)`,
};

const warmupTrack: React.CSSProperties = {
  height: "4px",
  background: "rgba(34,211,238,0.15)",
  position: "relative",
};

const warmupFill: React.CSSProperties = {
  height: "100%",
  background: `linear-gradient(90deg, ${HYPERP}, ${ACCENT})`,
  transition: "width 0.2s",
};

const nftRow: React.CSSProperties = {
  paddingTop: "1rem",
};

const nftMint: React.CSSProperties = {
  fontFamily: monoFont,
  fontSize: "11px",
  color: HYPERP,
  marginTop: "0.4rem",
  wordBreak: "break-all",
};

const closeBtn: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: `1px solid ${BORDER}`,
  color: TEXT,
  fontFamily: monoFont,
  fontSize: "10px",
  padding: "0.6rem",
  cursor: "pointer",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

const addBtn: React.CSSProperties = {
  ...closeBtn,
  color: ACCENT,
  borderColor: "rgba(153,69,255,0.4)",
};

const sendBtn: React.CSSProperties = {
  ...closeBtn,
  color: HYPERP,
  borderColor: "rgba(34,211,238,0.4)",
};

const tradeRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.45rem 0",
  borderBottom: `1px dashed ${BORDER_SUBTLE}`,
};
