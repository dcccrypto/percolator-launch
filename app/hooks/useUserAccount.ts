"use client";

import { useMemo } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { AccountKind, type Account } from "@percolator/core";

export interface UserAccountInfo {
  idx: number;
  account: Account;
}

export function useUserAccount(): UserAccountInfo | null {
  const { publicKey } = useWalletCompat();
  const { accounts } = useSlabState();

  return useMemo(() => {
    if (!publicKey) return null;
    const pkStr = publicKey.toBase58();
    const found = accounts.find(
      ({ account }) => account.kind === AccountKind.User && account.owner.toBase58() === pkStr
    );
    return found ? { idx: found.idx, account: found.account } : null;
  }, [publicKey, accounts]);
}
