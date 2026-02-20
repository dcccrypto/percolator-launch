import "@/lib/polyfills";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { Space_Grotesk, JetBrains_Mono, Inter_Tight, Outfit } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { TickerBanner } from "@/components/layout/TickerBanner";
import { CursorGlow } from "@/components/ui/CursorGlow";
import { MusicPlayer } from "@/components/ui/MusicPlayer";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], weight: ["400", "500", "600", "700", "800", "900"] });
const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"] });

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
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
        <body suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${interTight.variable} ${outfit.variable} min-h-screen bg-[#050508] text-[#eeeef0] antialiased`} data-nonce={nonce}>
        <Providers>
          <CursorGlow />
          <div className="relative z-[1] flex min-h-screen flex-col">
            <TickerBanner />
            <Header />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
          <MusicPlayer />
        </Providers>
      </body>
    </html>
  );
}
