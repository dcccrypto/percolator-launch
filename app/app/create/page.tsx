"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";
import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";
import { GlassCard } from "@/components/ui/GlassCard";

export default function CreatePage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.fromTo(
      containerRef.current.children,
      { opacity: 0, y: 30 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.12, ease: "power3.out" }
    );
  }, []);

  return (
    <div className="relative">
      {/* Background orb */}
      <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 h-[500px] w-[600px] rounded-full bg-[#7B61FF]/[0.03] blur-[150px]" />

      <div ref={containerRef} className="relative mx-auto max-w-3xl px-4 py-10">
        <div>
          <h1 className="text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            Launch a Market
          </h1>
          <p className="mt-2 text-[#8B95B0]">
            Deploy a perpetual futures market for any Solana token. No permission needed.
          </p>
        </div>
        <div className="mt-8">
          <GlassCard padding="lg" hover={false} glow>
            <CreateMarketWizard />
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
