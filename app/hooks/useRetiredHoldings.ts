"use client";

/**
 * useRetiredHoldings — funds the blocklist would otherwise make invisible.
 *
 * 2026-07-31 audit finding: every portfolio surface derives its market
 * universe from /api/markets, which filters blocklisted slabs — so a user
 * with deposits in a RETIRED market sees "no positions" and a total that
 * silently excludes their money (the CATE depositors' ~$990). Retirement is
 * supposed to hide markets from DISCOVERY, not hide people's own funds from
 * them.
 *
 * This hook bypasses market discovery entirely: ONE getProgramAccounts scan
 * for every v17 portfolio the connected wallet owns (magic @0 + mutable
 * owner @116), across ALL markets, then keeps only the ones whose market is
 * blocklisted and still holds value (capital > 0 or an active leg). The
 * result feeds a dedicated "retired markets" section — it never mixes into
 * the normal (filtered) portfolio flows.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { isBlockedSlab } from "@/lib/blocklist";
import { isLpPortfolio } from "@/lib/userAccountScan";

/** v17 portfolio magic + offsets — same constants useTrade/useClosePosition pin. */
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF = 16;
const V17_PF_OWNER_OFF = 116;

export interface RetiredHolding {
  /** The retired market's slab address. */
  slabAddress: string;
  /** Deposited collateral still in the portfolio (native units, 6dp sim-USDC). */
  capital: bigint;
  /** Net open position size in base q units (0n = flat). */
  positionSizeQ: bigint;
}

export function useRetiredHoldings(): { holdings: RetiredHolding[]; loading: boolean } {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const [holdings, setHoldings] = useState<RetiredHolding[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setHoldings([]);
    if (!publicKey) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const programId = new PublicKey(getConfig().programId);
        const accounts = await connection.getProgramAccounts(programId, {
          filters: [
            { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
            { memcmp: { offset: V17_PF_OWNER_OFF, bytes: publicKey.toBase58() } },
          ],
        });
        const found: RetiredHolding[] = [];
        for (const { account } of accounts) {
          const data = Buffer.from(account.data);
          // A creator's own LP portfolio is the MARKET's liquidity, not a
          // personal deposit — the LP redemption flow (earn page) owns that.
          if (isLpPortfolio(data)) continue;
          const slabAddress = new PublicKey(
            data.subarray(V17_PF_MARKET_OFF, V17_PF_MARKET_OFF + 32),
          ).toBase58();
          if (!isBlockedSlab(slabAddress)) continue;
          try {
            const pf = parsePortfolioV17(new Uint8Array(data));
            const leg = pf.legs.find((l) => l.active);
            const positionSizeQ = leg ? BigInt(leg.basisPosQ) : 0n;
            if (pf.capital > 0n || positionSizeQ !== 0n) {
              found.push({ slabAddress, capital: pf.capital, positionSizeQ });
            }
          } catch {
            /* unparseable portfolio — skip rather than crash the section */
          }
        }
        if (!cancelled) setHoldings(found);
      } catch {
        // Scan failed (RPC hiccup): show nothing rather than an error — the
        // section is additive; the rest of the portfolio page is unaffected.
        if (!cancelled) setHoldings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey]);

  return { holdings, loading };
}
