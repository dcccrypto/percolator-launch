"use client";

import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";

export default function CreatePage() {
  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-2">Launch a Market</h1>
      <p className="text-zinc-400 mb-8">
        Deploy a perpetual futures market for any Solana token. No permission needed.
      </p>
      <CreateMarketWizard />
    </div>
  );
}
