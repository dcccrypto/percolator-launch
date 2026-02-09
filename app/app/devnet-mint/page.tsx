"use client";

import dynamic from "next/dynamic";

const DevnetMintContent = dynamic(() => import("./devnet-mint-content"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center bg-[#06080d] text-[#8B95B0]">
      Loading Devnet Token Factory…
    </div>
  ),
});

export default function DevnetMintPage() {
  return <DevnetMintContent />;
}
