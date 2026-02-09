"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";
import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

export default function CreatePage() {
  const { connected } = useWallet();
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  return (
    <div ref={pageRef} className="mx-auto max-w-3xl px-4 py-10 opacity-0">
      <h1 className="text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
        launch a market
      </h1>
      <p className="mt-2 text-sm text-[#8B95B0]">
        takes about 60 seconds and some sol.
      </p>

      <div className="mt-4 rounded-[4px] border border-[#7B61FF]/20 bg-[#7B61FF]/[0.05] p-4">
        <p className="text-xs font-medium text-[#7B61FF] mb-2" style={{ fontFamily: "var(--font-space-grotesk)" }}>how it works</p>
        <div className="flex flex-col gap-1 text-xs text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
          <span><span className="text-[#00FFB2]">1.</span> paste any solana token address</span>
          <span><span className="text-[#00FFB2]">2.</span> set leverage &amp; fees</span>
          <span><span className="text-[#00FFB2]">3.</span> your market goes live instantly</span>
        </div>
      </div>

      <div className="mt-2 text-xs text-[#5a6382]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
        small: ~0.5 SOL &middot; medium: ~2 SOL &middot; large: ~7 SOL
      </div>

      {!connected && (
        <div className="mt-6 flex items-center gap-3 rounded-[4px] border border-[#FFB800]/20 bg-[#FFB800]/[0.05] p-4">
          <p className="flex-1 text-sm text-[#FFB800]">connect your wallet first.</p>
          <WalletMultiButton />
        </div>
      )}

      <div className="mt-8 rounded-[4px] border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-6 md:p-8">
        <CreateMarketWizard />
      </div>
    </div>
  );
}
