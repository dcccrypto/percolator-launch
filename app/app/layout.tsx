import "@/lib/polyfills";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { Space_Grotesk, JetBrains_Mono, Inter_Tight, Outfit } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { TickerBanner } from "@/components/layout/TickerBanner";
import { CursorGlow } from "@/components/ui/CursorGlow";
import { MusicPlayer } from "@/components/ui/MusicPlayer";
import { MainnetBetaBanner } from "@/components/layout/MainnetBetaBanner";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });
const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], weight: ["400", "500", "600", "700", "800", "900"], display: "swap" });
const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"], display: "swap" });

// PERC-695 (bug bounty — CSP static nonce): Force dynamic rendering so each request
// generates a fresh layout render with the new per-request nonce from middleware.
// Without this, Next.js may serve a cached layout with a stale nonce baked into
// data-nonce, causing a CSP mismatch with the freshly generated nonce in the header.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://percolatorlaunch.com"),
  title: "Percolator | Permissionless Perpetual Markets on Solana",
  description: "Launch and trade perpetual futures for any Solana token. Fully on-chain, permissionless, transparent.",
  keywords: ["Solana", "perpetual futures", "DeFi", "trading", "perps", "on-chain"],
  icons: {
    icon: '/icon.png',
    apple: '/icon.png',
  },
  openGraph: {
    url: "https://percolatorlaunch.com",
    title: "Percolator — Permissionless Perps on Solana",
    description: "Launch and trade perpetual futures for any Solana token.",
    type: "website",
    locale: "en_US",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Percolator — Permissionless Perps on Solana",
    description: "Launch and trade perpetual futures for any Solana token.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${interTight.variable} ${outfit.variable}`}>
      <head>
        <script
          nonce={nonce}
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
        <Providers>
          <CursorGlow />
          <div className="relative z-[1] flex min-h-screen flex-col">
            <TickerBanner />
            <MainnetBetaBanner />
            <Header />
            <main className="flex-1 pb-[60px] md:pb-0">{children}</main>
            <Footer />
            <MobileBottomNav />
          </div>
          <MusicPlayer />
        </Providers>
      </body>
    </html>
  );
}
