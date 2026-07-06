import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const alt = "Percolator — Permissionless Perpetuals on Solana";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Load a Google font as a TTF for Satori. Wrapped by the caller in try/catch so
// a network hiccup degrades to the embedded default font rather than 500ing the
// route (crawlers must always get a valid image).
async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const url = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`;
  const css = await (
    await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  ).text();
  const src = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/);
  if (!src) throw new Error("font src not found");
  const res = await fetch(src[1]!);
  if (!res.ok) throw new Error("font fetch failed");
  return res.arrayBuffer();
}

export default async function OpengraphImage() {
  const logoBuffer = await readFile(
    join(process.cwd(), "public/images/logo-mark.png"),
  );
  const logoSrc = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  // Site type system: Plus Jakarta Sans is the logo wordmark (--font-display); JetBrains
  // Mono is the body/heading face (--font-sans / --font-heading). Match both so
  // the card reads like the site rather than a generic sans.
  let fonts:
    | { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[]
    | undefined;
  try {
    const [display700, mono400, mono700] = await Promise.all([
      loadGoogleFont("Plus+Jakarta+Sans", 700),
      loadGoogleFont("JetBrains+Mono", 400),
      loadGoogleFont("JetBrains+Mono", 700),
    ]);
    fonts = [
      { name: "Plus Jakarta Sans", data: display700, weight: 700, style: "normal" },
      { name: "JetBrains Mono", data: mono400, weight: 400, style: "normal" },
      { name: "JetBrains Mono", data: mono700, weight: 700, style: "normal" },
    ];
  } catch {
    fonts = undefined;
  }

  const monoFamily = fonts ? "JetBrains Mono, monospace" : "monospace";
  const displayFamily = fonts ? "Plus Jakarta Sans, sans-serif" : "sans-serif";
  // Site signature gradient (waitlist hero): purple → Solana green.
  const brandGradient =
    "linear-gradient(110deg, #B97AFF 0%, #9945FF 38%, #14F195 100%)";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          backgroundColor: "#0A0A0F",
          // Dual aurora — one purple light top-left, one green wash bottom-right.
          backgroundImage:
            "radial-gradient(ellipse 1000px 760px at 12% 6%, rgba(153,69,255,0.42) 0%, rgba(10,10,15,0) 56%), radial-gradient(ellipse 920px 720px at 100% 104%, rgba(20,241,149,0.22) 0%, rgba(10,10,15,0) 55%)",
          fontFamily: monoFamily,
        }}
      >
        {/* Grid — mirrors the site backdrop, kept visible */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage:
              "linear-gradient(to right, rgba(225,226,232,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(225,226,232,0.14) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)",
          }}
        />

        {/* Logo — transparent colorful mark on a soft purple glow halo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 400,
            height: 260,
            backgroundImage:
              "radial-gradient(closest-side, rgba(153,69,255,0.42) 0%, rgba(153,69,255,0) 72%)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={258} height={214} alt="Percolator" />
        </div>

        {/* Wordmark — Outfit, matches the site header wordmark (--font-display) */}
        <div
          style={{
            display: "flex",
            marginTop: 16,
            fontFamily: displayFamily,
            fontSize: 120,
            fontWeight: 700,
            letterSpacing: "-0.035em",
            lineHeight: 1,
            color: "#E1E2E8",
          }}
        >
          Percolator
        </div>

        {/* Tagline — JetBrains Mono (site body/heading face) + gradient accent */}
        <div
          style={{
            display: "flex",
            marginTop: 30,
            fontFamily: monoFamily,
            fontSize: 34,
            fontWeight: 400,
            letterSpacing: "-0.01em",
          }}
        >
          <span style={{ color: "#8A8BA8", marginRight: 16 }}>
            Perp futures for
          </span>
          <span
            style={{
              backgroundImage: brandGradient,
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            every Solana token
          </span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
