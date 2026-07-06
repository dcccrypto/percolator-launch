import "@/lib/polyfills";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist_Mono } from "next/font/google";
import { Space_Grotesk, JetBrains_Mono, Outfit } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { TickerBanner } from "@/components/layout/TickerBanner";
import { CursorGlow } from "@/components/ui/CursorGlow";
import { MusicPlayer } from "@/components/ui/MusicPlayer";
import { MainnetBetaBanner } from "@/components/layout/MainnetBetaBanner";
import { ChromeGate } from "@/components/layout/ChromeGate";
import { JsonLd } from "@/components/seo/JsonLd";
import { organizationSchema, websiteSchema } from "@/lib/structured-data";
import { Analytics } from "@vercel/analytics/next";
import { GoogleAnalytics } from "@/components/analytics/GoogleAnalytics";
import { CloudflareAnalytics } from "@/components/analytics/CloudflareAnalytics";

// Geist (sans) and Inter Tight removed — neither --font-geist-sans nor
// --font-inter-tight is referenced in globals.css or any component style.
// Remaining 4 families are all actively consumed:
//   JetBrains Mono  → --font-sans, --font-mono, --font-heading + inline styles
//   Geist Mono      → fallback in --font-sans / --font-mono / --font-heading
//   Outfit          → primary in --font-display (headings, OG image wordmark)
//   Space Grotesk   → fallback in --font-display
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });
const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });

// PERC-695 (bug bounty — CSP static nonce): Force dynamic rendering so each request
// generates a fresh layout render with the new per-request nonce from middleware.
// Without this, Next.js may serve a cached layout with a stale nonce baked into
// data-nonce, causing a CSP mismatch with the freshly generated nonce in the header.
export const dynamic = "force-dynamic";

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
    title: "Percolator — Permissionless Perps on Solana",
    description: "Launch and trade perpetual futures for any Solana token.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@PercolatorTrade",
    title: "Percolator — Permissionless Perps on Solana",
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth" className={`${geistMono.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${outfit.variable}`}>
      <head>
        {/* suppressHydrationWarning: browsers blank the nonce content attribute after
            parsing (nonce hiding), so React's hydration diff always sees nonce="" vs
            the server value and logs a mismatch error on every load. The nonce itself
            still applies — only the noisy warning is suppressed. */}
        <script
          nonce={nonce}
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
      </head>
        <body suppressHydrationWarning className="min-h-screen antialiased" data-nonce={nonce}>
        <JsonLd data={[organizationSchema(), websiteSchema()]} />
        <Providers>
          <CursorGlow />
          <div className="relative z-[1] flex min-h-screen flex-col">
            <ChromeGate>
              <TickerBanner />
              <MainnetBetaBanner />
            </ChromeGate>
            <Header />
            <main className="flex-1 pb-[60px] md:pb-0">{children}</main>
            <Footer />
            <MobileBottomNav />
          </div>
          <ChromeGate>
            <MusicPlayer />
          </ChromeGate>
        </Providers>
        <GoogleAnalytics nonce={nonce} />
        <CloudflareAnalytics nonce={nonce} />
        <Analytics />
      </body>
    </html>
  );
}
