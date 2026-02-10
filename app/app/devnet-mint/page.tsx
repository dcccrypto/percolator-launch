"use client";

import dynamic from "next/dynamic";

const DevnetMintContent = dynamic(() => import("./devnet-mint-content"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--text-secondary)]">
      Loading Devnet Token Factory…
    </div>
  ),
});

export default function DevnetMintPage() {
  return <DevnetMintContent />;
}
