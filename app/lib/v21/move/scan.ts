/**
 * Read-only chain scan for the Move flow: the wallet's whole footprint on each v1 market and on its
 * v2.1 successor, as a MoveInput. RPC failures THROW (never read as "nothing here": a transient
 * 429 must not tell a user their funds are gone). Reuses the app's own decoders and scanners.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import {
  deriveInsuranceLpMint,
  deriveLpRedemption,
  deriveLpVaultRegistry,
  parseLpRedemption,
  parseLpVaultRegistry,
  parsePortfolioV17,
} from "@percolatorct/sdk";
import { pickOwnerPortfolio, scanOwnerPortfolios } from "@/lib/owner-portfolio";
import { decodeMarketEngineView, decodePortfolioLegs, decodeResolvedMarket } from "@/lib/limits/decode";
import { MARKET_MODE_RESOLVED } from "@/lib/limits/constants";
import { releasedPnlFace } from "@/lib/convert-released-pnl";
import { isCreatorFeeClaimAuthority, readCreatorFeeClaimable } from "@/lib/v17-creator-fee";
import { deriveCloseOnlyState } from "../lock-episode";
import type { ProgramIdSet } from "@/lib/program-ids";
import { type MoveInput, type V1MarketSnapshot } from "./plan";
import { successorFor, type SuccessorEntry } from "./successors";

export interface V1MarketRef {
  slab: string;
  symbol: string;
  mint: string | null;
  collateralDecimals: number;
}

export async function readPortfolio(connection: Connection, programId: PublicKey, market: PublicKey, wallet: PublicKey) {
  const found = pickOwnerPortfolio(await scanOwnerPortfolios(connection, programId, market, wallet), wallet);
  if (!found) return null;
  const pf = parsePortfolioV17(found.data);
  return { pf, legs: decodePortfolioLegs(found.data).length };
}

async function readEarn(connection: Connection, programId: PublicKey, market: PublicKey, wallet: PublicKey) {
  const [lpMint] = deriveInsuranceLpMint(programId, market);
  const [registry] = deriveLpVaultRegistry(programId, market);
  const [redemption] = deriveLpRedemption(programId, registry, wallet);
  const ata = getAssociatedTokenAddressSync(lpMint, wallet, true);
  const [ataInfo, redInfo, regInfo] = await connection.getMultipleAccountsInfo([ata, redemption, registry], "confirmed");
  if (!regInfo || !regInfo.owner.equals(programId)) return null;
  const shares = ataInfo ? unpackAccount(ata, ataInfo, ataInfo.owner).amount : 0n;
  let pending: { shares: bigint; unlockSlot: bigint } | null = null;
  if (redInfo && redInfo.owner.equals(programId) && redInfo.data.length > 0) {
    const r = parseLpRedemption(new Uint8Array(redInfo.data));
    const cooldown = BigInt(parseLpVaultRegistry(new Uint8Array(regInfo.data)).redemptionCooldownSlots);
    pending = { shares: BigInt(r.shares), unlockSlot: BigInt(r.requestSlot) + cooldown };
  }
  if (!ataInfo && !pending) return null; // never held Earn here
  return { shares, pending, requestsPaused: false };
}

export interface ScanArgs {
  connection: Connection;
  wallet: PublicKey;
  v1: ProgramIdSet;
  v21: ProgramIdSet | null;
  markets: readonly V1MarketRef[];
  successors: readonly SuccessorEntry[];
}

export async function scanMoveInput(a: ScanArgs): Promise<MoveInput> {
  const nowSlot = BigInt(await a.connection.getSlot("confirmed"));
  const v1 = new PublicKey(a.v1.wrapper);
  const v21 = a.v21 ? new PublicKey(a.v21.wrapper) : null;
  const markets: V1MarketSnapshot[] = [];
  for (const ref of a.markets) {
    const market = new PublicKey(ref.slab);
    const info = await a.connection.getAccountInfo(market, "confirmed");
    if (!info || !info.owner.equals(v1)) continue; // not a v1 market: never plan against it
    const raw = new Uint8Array(info.data);
    const resolved = decodeResolvedMarket(raw)?.mode === MARKET_MODE_RESOLVED;
    const engine = decodeMarketEngineView(raw);
    const closeOnly = deriveCloseOnlyState({ raw, engine, nowSlot, collateralDecimals: ref.collateralDecimals }).closeOnly;
    const p = await readPortfolio(a.connection, v1, market, a.wallet);
    const earn = await readEarn(a.connection, v1, market, a.wallet);
    const claim = readCreatorFeeClaimable(raw);
    const creatorFeeAtoms = claim && isCreatorFeeClaimAuthority(claim, a.wallet) ? claim.atoms : 0n;
    const succ = successorFor(a.successors, ref.mint, ref.symbol);
    let v21Snap = { marketCapital: 0n, earnShares: 0n };
    if (v21 && succ?.v21Slab) {
      const sm = new PublicKey(succ.v21Slab);
      const sp = await readPortfolio(a.connection, v21, sm, a.wallet);
      const se = succ.v21Earn ? await readEarn(a.connection, v21, sm, a.wallet) : null;
      v21Snap = { marketCapital: sp ? BigInt(sp.pf.capital) : 0n, earnShares: se ? se.shares + (se.pending?.shares ?? 0n) : 0n };
    }
    markets.push({
      ...ref,
      resolved,
      portfolio: p
        ? { capital: BigInt(p.pf.capital), releasedPnl: releasedPnlFace(p.pf.pnl, p.pf.reservedPnl), openLegs: p.legs, closeOnly }
        : null,
      earn,
      creatorFeeAtoms,
      v21: v21Snap,
    });
  }
  return {
    nowSlot,
    markets,
    successors: a.successors,
    v21Live: v21 !== null,
    successorOf: (m) => {
      const s = successorFor(a.successors, m.mint, m.symbol);
      return s;
    },
  };
}
