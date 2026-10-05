"use client";

/**
 * Devnet v2.1 (P2b tag 104): the permissionless ADL wind-down of the connected wallet's own
 * position, offered only where lib/v21/lock-episode.ts says it would close something now. The tag
 * takes no signer (anyone may call it for any portfolio); the wallet only pays the fee. Never
 * replaces the owner's own close (tag 44), which is always available.
 */
import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { findV17Portfolio } from "@/hooks/useTrade";
import { getPortfolioRawSnapshot, makePortfolioScanKey } from "@/lib/userAccountScan";
import { readPortfolioIdentity } from "@/lib/v18-wire";
import { sendTx } from "@/lib/tx";
import { pythCrankAccount } from "@/lib/limits/oracle-tail";
import { plainMessage } from "@/lib/limits/user-message";
import { buildAdlWindDownIx } from "@/lib/v21/sdk";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";

/** Generous: price refresh + the close at the mark. The real limit is sized from the simulation. */
const WIND_DOWN_CU_CAP = 600_000;

export function useAdlWindDown(slabAddress: string | null | undefined) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, config, wrapperConfigV17 } = useSlabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const windDown = useCallback(async (): Promise<string | null> => {
    if (!wallet.publicKey || !slabAddress || !programId || !config) return null;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const prog = new PublicKey(programId);
      const market = new PublicKey(slabAddress);
      const portfolio =
        getPortfolioRawSnapshot(makePortfolioScanKey(prog, slabAddress, wallet.publicKey))?.pubkey ??
        (await findV17Portfolio(connection, prog, market, wallet.publicKey));
      if (!portfolio) throw new Error("Could not find your portfolio on this market.");
      const info = await connection.getAccountInfo(portfolio, "confirmed");
      if (!info) throw new Error("Could not read your portfolio.");
      const id = readPortfolioIdentity(new Uint8Array(info.data));
      const oracle = pythCrankAccount(config, wrapperConfigV17?.oracleMode);
      const ix = buildAdlWindDownIx(
        prog,
        { caller: wallet.publicKey, market, portfolio, collateralMint: config.collateralMint },
        { nowSlot: 0n, assetIndex: 0, portfolioId: id.portfolioId, positionEpoch: id.positionEpoch },
        oracle ? [oracle] : [],
      );
      const sig = await sendTx({ connection, wallet, instructions: [ix], computeUnitsFromSim: { cap: WIND_DOWN_CU_CAP } });
      invalidatePortfolio();
      setDone(true);
      return sig;
    } catch (e) {
      setError(plainMessage(e, { surface: "close" }));
      return null;
    } finally {
      setBusy(false);
    }
  }, [wallet, connection, slabAddress, programId, config, wrapperConfigV17?.oracleMode]);

  return { windDown, busy, error, done };
}
