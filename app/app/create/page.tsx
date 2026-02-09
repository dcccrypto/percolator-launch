"use client";

import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";

export default function CreatePage() {
  return (
    <div className="terminal-grid min-h-[calc(100vh-48px)]">
      <div className="mx-auto max-w-3xl px-3 py-6 lg:px-4">
        <h1 className="mb-1 text-2xl font-bold text-white">Launch a Market</h1>
        <p className="mb-8 text-sm text-[#4a5068]">
          Deploy a perpetual futures market for any Solana token. No permission needed.
        </p>
        <CreateMarketWizard />
      </div>
    </div>
  );
}
