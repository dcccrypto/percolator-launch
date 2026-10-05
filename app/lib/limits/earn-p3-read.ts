/**
 * One RPC round-trip for the P3 Earn context (market + registry + vault-LP state), decoded by
 * the pure decoders. Any read failure yields `bound: null` (the legacy shape is sent and a
 * bound vault then fails closed on-chain, never mispriced).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeLpVaultRegistryBound, decodeLpVaultRegistryDomain, decodeLpVaultRegistryShares, decodeMarketEngineView, decodeResolvedMarket, decodeTerminalBacking, decodeVaultLpState } from "./decode";
import { deriveLpVaultRegistryPda, deriveVaultLpState } from "./p3-ix";
import { harvestableFeeAtoms } from "./vault-tranche";
import type { EarnP3Context } from "./earn-ixs";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import { deriveVaultLpExt } from "@/lib/v21/sdk";

export async function readEarnP3Context(connection: Connection, programId: PublicKey, market: PublicKey): Promise<EarnP3Context> {
  const none: EarnP3Context = { bound: null, vaultLpState: PublicKey.default, lpPortfolio: null, harvestable: null, registryShares: null, mode: 0 };
  try {
    const registry = deriveLpVaultRegistryPda(programId, market);
    const vaultLpState = deriveVaultLpState(programId, market);
    // Devnet v2.1 only: also look for the P2b ext PDA (one more key in the SAME batched read).
    const extKey = isDevnetV21Enabled() ? deriveVaultLpExt(programId, market) : null;
    const [m, r, s, x] = await connection.getMultipleAccountsInfo(extKey ? [market, registry, vaultLpState, extKey] : [market, registry, vaultLpState], "confirmed");
    if (!m || !r || !r.owner.equals(programId)) return none;
    const md = new Uint8Array(m.data);
    const rd = new Uint8Array(r.data);
    const view = decodeMarketEngineView(md);
    const st = s && s.owner.equals(programId) ? decodeVaultLpState(new Uint8Array(s.data)) : null;
    const rm = decodeResolvedMarket(md);
    const dom = decodeLpVaultRegistryDomain(rd);
    const tb = dom !== null ? decodeTerminalBacking(md, dom) : null;
    return {
      terminalFlat: !!rm && rm.mode === 1 && rm.materializedPortfolioCount === 0n && rm.cTot === 0n,
      terminalResidual: tb ? tb.residual : null,
      bound: decodeLpVaultRegistryBound(rd),
      vaultLpState,
      lpPortfolio: st ? new PublicKey(st.lpPortfolio) : null,
      harvestable: view ? harvestableFeeAtoms(view) : null,
      registryShares: decodeLpVaultRegistryShares(rd),
      mode: view ? view.mode : 0,
      ...(extKey && x && x.owner.equals(programId) ? { vaultLpExt: extKey } : {}),
    };
  } catch {
    return none;
  }
}
