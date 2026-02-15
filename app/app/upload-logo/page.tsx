"use client";

import { FC, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { LogoUpload } from "@/components/market/LogoUpload";
import { MarketLogo } from "@/components/market/MarketLogo";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { getSupabase } from "@/lib/supabase";

const cardClass = "border border-[var(--border)] bg-[var(--panel-bg)] p-5 transition-all";
const btnPrimary = "border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 px-6 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] press disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50";

interface Market {
  slab_address: string;
  mint_address: string;
  symbol: string;
  name: string;
  logo_url?: string | null;
}

function UploadLogoPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const slabParam = searchParams.get("slab");

  const [slabAddress, setSlabAddress] = useState(slabParam || "");
  const [market, setMarket] = useState<Market | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Load market data if slab is provided
  useEffect(() => {
    if (!slabAddress) return;
    
    const loadMarket = async () => {
      setLoading(true);
      setError(null);
      try {
        const supabase = getSupabase();
        const { data, error: fetchError } = await supabase
          .from("markets")
          .select("slab_address, mint_address, symbol, name, logo_url")
          .eq("slab_address", slabAddress)
          .single();

        if (fetchError) {
          setError("Market not found. Make sure the market has been registered.");
          setMarket(null);
        } else {
          setMarket(data);
        }
      } catch (err) {
        setError("Failed to load market data.");
        setMarket(null);
      } finally {
        setLoading(false);
      }
    };

    loadMarket();
  }, [slabAddress]);

  const handleSuccess = (logoUrl: string) => {
    setSuccess(true);
    if (market) {
      setMarket({ ...market, logo_url: logoUrl });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (slabAddress) {
      router.push(`?slab=${slabAddress}`);
    }
  };

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-2xl px-4 py-10">
        <ScrollReveal>
          <div className="mb-8 text-center">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // customize
            </div>
            <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              <span className="font-normal text-white/50">Upload </span>Market Logo
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              Add a logo to your market for better visibility on the trade page and markets list.
            </p>
          </div>
        </ScrollReveal>

        <div className="max-w-xl mx-auto space-y-6">
          {/* Step 1: Enter Slab Address */}
          <ScrollReveal delay={0.1}>
            <div className={cardClass}>
              <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
                Step 1 · Market Address
              </h2>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-secondary)]">
                    Slab Address (Market)
                  </label>
                  <input
                    type="text"
                    value={slabAddress}
                    onChange={(e) => setSlabAddress(e.target.value.trim())}
                    placeholder="Enter market slab address..."
                    className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[12px] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none transition-colors font-mono"
                  />
                  <p className="mt-1 text-[10px] text-[var(--text-dim)]">
                    The on-chain slab address of your deployed market.
                  </p>
                </div>
                <button
                  type="submit"
                  className={btnPrimary}
                  disabled={!slabAddress || loading}
                >
                  {loading ? "Loading..." : "Load Market"}
                </button>
              </form>

              {error && (
                <p className="mt-3 text-xs text-[var(--short)]">{error}</p>
              )}
            </div>
          </ScrollReveal>

          {/* Step 2: Upload Logo */}
          {market && (
            <ScrollReveal delay={0.2}>
              <div className={cardClass}>
                <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
                  Step 2 · Upload Logo
                </h2>

                {/* Market Info */}
                <div className="mb-6 p-3 border border-[var(--border)] bg-[var(--bg-elevated)]">
                  <div className="flex items-center gap-3">
                    <MarketLogo
                      logoUrl={market.logo_url}
                      symbol={market.symbol}
                      size="md"
                    />
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {market.symbol}/USD
                      </p>
                      <p className="text-[10px] text-[var(--text-dim)] font-mono">
                        {market.name}
                      </p>
                      <p className="text-[10px] text-[var(--text-dim)] font-mono">
                        {market.mint_address.slice(0, 8)}...{market.mint_address.slice(-8)}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Logo Upload */}
                <LogoUpload
                  slabAddress={market.slab_address}
                  currentLogoUrl={market.logo_url}
                  onSuccess={handleSuccess}
                  size="lg"
                />

                {success && (
                  <div className="mt-4 p-3 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06]">
                    <p className="text-xs text-[var(--accent)]">
                      ✓ Logo uploaded successfully! It will now appear on your market.
                    </p>
                  </div>
                )}
              </div>
            </ScrollReveal>
          )}

          {/* Success Actions */}
          {success && market && (
            <ScrollReveal delay={0.3}>
              <div className={cardClass}>
                <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
                  Next Steps
                </h2>
                <div className="space-y-2">
                  <Link
                    href={`/trade/${market.slab_address}`}
                    className={`${btnPrimary} block text-center`}
                  >
                    View Market →
                  </Link>
                  <Link
                    href="/markets"
                    className="block text-center text-xs text-[var(--text-muted)] hover:text-[var(--accent)] underline"
                  >
                    Browse all markets
                  </Link>
                  <button
                    onClick={() => {
                      setMarket(null);
                      setSlabAddress("");
                      setSuccess(false);
                      setError(null);
                    }}
                    className="w-full text-xs text-[var(--text-dim)] hover:text-[var(--text-muted)] underline"
                  >
                    Upload logo for another market
                  </button>
                </div>
              </div>
            </ScrollReveal>
          )}

          {/* Help Text */}
          <ScrollReveal delay={0.4}>
            <div className="text-center space-y-2">
              <p className="text-[11px] text-[var(--text-dim)]">
                Don't have a market yet?{" "}
                <Link href="/create" className="text-[var(--accent)] hover:underline">
                  Create one here →
                </Link>
              </p>
              <p className="text-[11px] text-[var(--text-dim)]">
                Or mint a test token on{" "}
                <Link href="/devnet-mint" className="text-[var(--accent)] hover:underline">
                  devnet →
                </Link>
              </p>
            </div>
          </ScrollReveal>
        </div>
      </div>
    </div>
  );
}

export default function UploadLogoPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
    </div>}>
      <UploadLogoPageInner />
    </Suspense>
  );
}
