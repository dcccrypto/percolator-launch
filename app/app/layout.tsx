import "@/lib/polyfills";
import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { TickerBanner } from "@/components/layout/TickerBanner";
import { PositionsBar } from "@/components/layout/PositionsBar";
import { MusicPlayer } from "@/components/ui/MusicPlayer";
import { MainnetBetaBanner } from "@/components/layout/MainnetBetaBanner";
import { ChromeGate } from "@/components/layout/ChromeGate";
import { JsonLd } from "@/components/seo/JsonLd";
import { organizationSchema, websiteSchema } from "@/lib/structured-data";
import { Analytics } from "@vercel/analytics/next";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import { CloudflareAnalytics } from "@/components/analytics/CloudflareAnalytics";

// Geist (sans), Inter Tight, Geist Mono, and Space Grotesk removed — they were
// never rendered (fallback-only entries in globals.css's font stacks, sitting
// behind fonts that next/font self-hosts and therefore always loads). Down to
// the 2 families actually painted on screen:
//   JetBrains Mono  → --font-sans, --font-mono, --font-heading (the body/data font)
//   Outfit          → --font-display (headings, OG image wordmark)
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });

// globals.css's font stacks still reference --font-geist-mono / --font-space-grotesk
// as the (now-dropped) fallback link before the final generic keyword — alias them
// to the fonts we kept instead of touching that file, so var() never resolves to
// the guaranteed-invalid value (which would blank out the *entire* font-family
// declaration at computed-value time, not just skip the missing link).
const fontVarAliases = {
  "--font-geist-mono": "var(--font-jetbrains-mono)",
  "--font-space-grotesk": "var(--font-outfit)",
} as React.CSSProperties;

export const metadata: Metadata = {
  // Canonical host is percolator.trade — percolatorlaunch.com 301s to it.
  // metadataBase MUST be the live host so og:image / twitter:image resolve to a
  // direct 200 (X's card renderer won't follow a 301 on the image URL, which
  // left the card image blank).
  metadataBase: new URL("https://percolator.trade"),
  // `default` is the home-page title; `template` appends " | Percolator" to any
  // bare title set by a child route segment (see lib/seo.ts → pageMetadata).
  title: {
    default: "Percolator | Permissionless Perpetual Markets on Solana",
    template: "%s | Percolator",
  },
  description: "Launch and trade perpetual futures for any Solana token. Fully on-chain, permissionless, transparent.",
  keywords: ["Solana", "perpetual futures", "DeFi", "trading", "perps", "on-chain"],
  applicationName: "Percolator",
  alternates: { canonical: "/" },
  icons: {
    icon: '/icon.png',
    apple: '/icon.png',
  },
  openGraph: {
    url: "https://percolator.trade",
    siteName: "Percolator",
    title: "Percolator - Permissionless Perps on Solana",
    description: "Launch and trade perpetual futures for any Solana token.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@PercolatorTrade",
    title: "Percolator - Permissionless Perps on Solana",
    description: "Launch and trade perpetual futures for any Solana token.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  // GSC verification — set NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION in Vercel env.
  // Renders <meta name="google-site-verification" …> only when present.
  verification: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
    ? { google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION }
    : undefined,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth" className={`${jetbrainsMono.variable} ${outfit.variable}`} style={fontVarAliases}>
      <head>
        {/* suppressHydrationWarning: browsers blank the nonce content attribute after
            parsing (nonce hiding), so React's hydration diff always sees nonce="" vs
            the server value and logs a mismatch error on every load. The nonce itself
            still applies — only the noisy warning is suppressed. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('pco-theme');
                if (t !== 'dark' && t !== 'light') t = 'dark';
                document.documentElement.setAttribute('data-theme', t);
              } catch(e) {
                document.documentElement.setAttribute('data-theme', 'dark');
              }
            `,
          }}
        />
        {/* Network hints: token logos are fetched cross-origin (next/image
            unoptimized), so resolve/warm the logo CDN's connection early.
            Cheap and safe — a no-op when unused. */}
        <link rel="dns-prefetch" href="https://assets.coingecko.com" />
        <link rel="preconnect" href="https://assets.coingecko.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://coin-images.coingecko.com" />
        <link rel="preconnect" href="https://coin-images.coingecko.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cdn.dexscreener.com" />
      </head>
        <body suppressHydrationWarning className="min-h-screen antialiased">
        <JsonLd data={[organizationSchema(), websiteSchema()]} />
        <Providers>
          <div className="relative z-[1] flex min-h-screen flex-col">
            <ChromeGate>
              <TickerBanner />
              <MainnetBetaBanner />
            </ChromeGate>
            <Header />
            <ChromeGate>
              <PositionsBar />
            </ChromeGate>
            <main className="flex-1 pb-[60px] md:pb-0">{children}</main>
            <Footer />
            <MobileBottomNav />
          </div>
          <ChromeGate>
            <MusicPlayer />
          </ChromeGate>
        </Providers>
        <GoogleAnalytics />
        <CloudflareAnalytics />
        <Analytics />
      </body>
    </html>
  );
}
