"use client";

/**
 * Installs the ONE app-level loader of market lot exponents (lib/v22/lot-registry.ts) with the app's connection. The
 * price store asks it for any slab it is asked to price while the exponent is unknown, so no page has to set it
 * (review N1). Renders nothing; does nothing with the v2.2 flag off.
 */
import { useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { lotExpOfStrict, setLotExpLoader } from "@/lib/v22/lot-registry";

export function LotExpLoaderBridge(): null {
  const { connection } = useConnectionCompat();
  useEffect(() => {
    if (!isDevnetV22Enabled()) return;
    setLotExpLoader(async (slab) => {
      const info = await connection.getAccountInfo(new PublicKey(slab), "confirmed");
      return info?.data ? lotExpOfStrict(new Uint8Array(info.data)) : null;
    });
    return () => setLotExpLoader(null);
  }, [connection]);
  return null;
}
