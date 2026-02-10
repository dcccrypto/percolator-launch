"use client";
import { explorerTxUrl } from "@/lib/config";

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
  const { config: mktConfig, refresh } = useSlabState();
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
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#71717a]">Create Account & Deposit</h3>
        <p className="mb-3 text-xs text-[#71717a]">Enter your initial deposit to create an account and start trading.</p>
        <div className="mb-3">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={`Initial deposit (${symbol})`}
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.05] px-3 py-2 text-sm text-[#e4e4e7] placeholder-[#52525b] focus:border-[#00FFB2]/40 focus:outline-none focus:ring-1 focus:ring-[#00FFB2]/20"
          />
        </div>
        <button
          onClick={async () => {
            try {
              const decimals = tokenMeta?.decimals ?? 6;
              const depositAmt = parseHumanAmount(amount || "0", decimals);
              // feePayment = deposit amount — account starts with real capital
              // Minimum 10,000 base units to survive crank GC
              const fee = depositAmt > 0n ? depositAmt : 10_000n;
              const sig = await initUser(fee);
              setLastSig(sig ?? null);
              setAmount("");
              // Force refresh slab data so useUserAccount picks up the new account
              setTimeout(() => refresh(), 1000);
            } catch {}
          }}
          disabled={initLoading || !amount}
          className="w-full rounded-lg bg-[#00FFB2] py-2.5 text-sm font-medium text-[#06080d] hover:bg-[#00FFB2]/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {initLoading ? "Creating..." : "Create Account & Deposit"}
        </button>
        <p className="mt-2 text-[10px] text-[#52525b]">Your deposit becomes your trading collateral. Accounts with no capital are recycled.</p>
        {initError && <p className="mt-2 text-xs text-[#FF4466]">{initError}</p>}
        {lastSig && <p className="mt-2 text-xs text-[#52525b]">Tx: <a href={`${explorerTxUrl(lastSig)}`} target="_blank" rel="noopener noreferrer" className="text-[#00FFB2] hover:underline">{lastSig.slice(0, 12)}...</a></p>}
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
      // Force refresh slab data after deposit/withdraw
      setTimeout(() => refresh(), 1000);
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
          className="w-full rounded-lg border border-white/[0.06] bg-white/[0.05] px-3 py-2 text-sm text-[#e4e4e7] placeholder-[#52525b] focus:border-[#00FFB2]/40 focus:outline-none focus:ring-1 focus:ring-[#00FFB2]/20"
        />
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading || !amount}
        className="w-full rounded-lg bg-[#00FFB2] py-2.5 text-sm font-medium text-[#06080d] hover:bg-[#00FFB2]/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Sending..." : mode === "deposit" ? "Deposit" : "Withdraw"}
      </button>

      {error && <p className="mt-2 text-xs text-[#FF4466]">{error}</p>}
      {lastSig && <p className="mt-2 text-xs text-[#52525b]">Tx: <a href={`${explorerTxUrl(lastSig)}`} target="_blank" rel="noopener noreferrer" className="text-[#00FFB2] hover:underline">{lastSig.slice(0, 12)}...</a></p>}
    </div>
  );
};
