"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { MINT_SIZE, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveInsuranceLpMint, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, deriveLpShareMetadataPdaV22, parseLpShareMetadataRecordV22 } from "@/lib/v22/sdk";

export interface LpShareToken {
  /** The share mint's OWN decimals (immutable: a vault from an earlier build keeps 0). `null` = not read (yet) or no such mint. */
  decimals: number | null;
  /** `true` = a Metaplex record of ours (owner Metaplex, update authority = the registry PDA, mint = the share mint) names it; `null` = not read. */
  metadataPresent: boolean | null;
  name: string | null;
  symbol: string | null;
}

const NONE: LpShareToken = { decimals: null, metadataPresent: null, name: null, symbol: null };

/**
 * What the chain says about a market's LP / Earn share token: its decimals and whether it has its name. v2.2 only (flag off: no request, `NONE`).
 * One `getMultipleAccountsInfo` for the mint and the Metaplex record; cached per market for the page's lifetime once the mint was seen (a mint's
 * decimals never change; a record can appear later, so an absent record is re-read on the next mount).
 */
export function useLpShareToken(market: PublicKey | string | null, programId: PublicKey | string | null): LpShareToken {
  // The flag is a build-time constant (a test override at most), so this branch never changes between renders of one tree; flag off the
  // connection hook is not even referenced, which keeps every v2.1 surface (and its test doubles) exactly as they were.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const connection = isDevnetV22Enabled() ? useConnectionCompat().connection : null;
  const [tok, setTok] = useState<LpShareToken>(NONE);
  const marketStr = market ? market.toString() : null;
  const programStr = programId ? programId.toString() : null;
  useEffect(() => {
    if (!connection || !marketStr || !programStr) {
      setTok(NONE);
      return;
    }
    let live = true;
    (async () => {
      try {
        const p = new PublicKey(programStr), m = new PublicKey(marketStr);
        const [registry] = deriveLpVaultRegistry(p, m);
        const [mint] = deriveInsuranceLpMint(p, m);
        const [meta] = deriveLpShareMetadataPdaV22(mint);
        const [mi, ri] = await connection.getMultipleAccountsInfo([mint, meta]);
        if (!live) return;
        let decimals: number | null = null;
        if (mi && mi.owner.equals(TOKEN_PROGRAM_ID) && mi.data.length === MINT_SIZE) {
          try { decimals = unpackMint(mint, mi).decimals; } catch { decimals = null; }
        }
        let rec: ReturnType<typeof parseLpShareMetadataRecordV22> = null;
        if (ri && ri.owner.equals(METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22)) rec = parseLpShareMetadataRecordV22(ri.data);
        const ours = rec !== null && rec.updateAuthority.equals(registry) && rec.mint.equals(mint);
        setTok({ decimals, metadataPresent: mi ? ours : null, name: ours ? rec!.name : null, symbol: ours ? rec!.symbol : null });
      } catch {
        if (live) setTok(NONE);
      }
    })();
    return () => { live = false; };
  }, [connection, marketStr, programStr]);
  return tok;
}
