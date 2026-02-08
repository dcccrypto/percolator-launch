"use client";

import { FC, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useDeposit } from "@/hooks/useDeposit";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useInitUser } from "@/hooks/useInitUser";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { parseHumanAmount } from "@/lib/parseAmount";
import { formatTokenAmount } from "@/lib/format";

export const DepositWithdrawCard: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected } = useWallet();
  const userAccount = useUserAccount();
  const { deposit, loading: depositLoading, error: depositError } = useDeposit(slabAddress);
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useWithdraw(slabAddress);
  const { initUser, loading: initLoading, error: initError } = useInitUser(slabAddress);
  const { config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [lastSig, setLastSig] = useState<string | null>(null);

  if (!connected) {
    return (
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#71717a]">Deposit / Withdraw</h3>
        <p className="text-sm text-[#52525b]">Connect wallet</p>
      </div>
    );
  }

  if (!userAccount) {
    return (
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#71717a]">Create Account</h3>
        <p className="mb-3 text-xs text-[#71717a]">Create an account to start trading.</p>
        <button
          onClick={async () => { try { const sig = await initUser(); setLastSig(sig ?? null); } catch {} }}
          disabled={initLoading}
          className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {initLoading ? "Creating..." : "Create Account"}
        </button>
        {initError && <p className="mt-2 text-xs text-red-400">{initError}</p>}
        {lastSig && <p className="mt-2 text-xs text-[#52525b]">Tx: {lastSig.slice(0, 12)}...</p>}
      </div>
    );
  }

  const capital = userAccount.account.capital;
  const loading = mode === "deposit" ? depositLoading : withdrawLoading;
  const error = mode === "deposit" ? depositError : withdrawError;

  async function handleSubmit() {
    if (!amount || !userAccount) return;
    try {
      const decimals = tokenMeta?.decimals ?? 6;
      const amtNative = parseHumanAmount(amount, decimals);
      if (amtNative <= 0n) return;
      let sig: string | undefined;
      if (mode === "deposit") {
        sig = await deposit({ userIdx: userAccount.idx, amount: amtNative });
      } else {
        sig = await withdraw({ userIdx: userAccount.idx, amount: amtNative });
      }
      setLastSig(sig ?? null);
      setAmount("");
    } catch {}
  }

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-[#71717a]">Deposit / Withdraw</h3>
      <p className="mb-3 text-lg font-bold text-[#e4e4e7]">{formatTokenAmount(capital)} <span className="text-sm font-normal text-[#71717a]">{symbol}</span></p>

      <div className="mb-3 flex gap-1.5">
        <button onClick={() => setMode("deposit")} className={`flex-1 rounded-lg py-1.5 text-xs font-medium ${mode === "deposit" ? "bg-emerald-600 text-white" : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"}`}>Deposit</button>
        <button onClick={() => setMode("withdraw")} className={`flex-1 rounded-lg py-1.5 text-xs font-medium ${mode === "withdraw" ? "bg-amber-600 text-white" : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"}`}>Withdraw</button>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder={`Amount (${symbol})`}
          className="w-full rounded-lg border border-[#1e1e2e] bg-[#1a1a28] px-3 py-2 text-sm text-[#e4e4e7] placeholder-[#52525b] focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading || !amount}
        className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Sending..." : mode === "deposit" ? "Deposit" : "Withdraw"}
      </button>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {lastSig && <p className="mt-2 text-xs text-[#52525b]">Tx: <a href={`https://explorer.solana.com/tx/${lastSig}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{lastSig.slice(0, 12)}...</a></p>}
    </div>
  );
};
