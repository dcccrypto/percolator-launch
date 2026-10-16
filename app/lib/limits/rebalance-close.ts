/**
 * F-3 / R1: close a position with the owner-signed unilateral exit (RebalanceReduce,
 * tag 44) while the asset is ADL reduce-only. Mirrors the #519 harness sequence
 * (`f3_owner_exits`): refresh the holder's portfolio with a permissionless crank, then tag 44
 * signed by the owner — both in ONE user transaction (the P0b self-heal still applies).
 * Tag 44's capacity is min(eff, oi_long, oi_short), so a close can be PARTIAL: the result is
 * measured (lib/limits/fill-check.ts), never assumed.
 */
import { errorText } from "@/lib/error-text";
import { tradeCuCap } from "@/lib/compute-budget";
import { PublicKey, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";
import { computeBudgetPrefix, parseCustomInstructionError } from "@/lib/self-heal";
import { adlExitCandidates, chooseAdlExit, resetPendingSides, type AdlExitDeps, type AdlExitRoute } from "./adl-exit-plan";
import { COPY } from "./copy";
import { sendTx } from "@/lib/tx";
import { fetchPortfolioIdentity } from "@/lib/v18-wire";
import { buildRebalanceCloseIxs } from "./rebalance-ixs";
import { measureFill } from "./fill-check";
import { decodeMarketEngineView, signedPositionForAsset } from "./decode";
import { extractErrorCode } from "@/lib/errorMessages";
import type { FillResult } from "./fill-result";

export { buildRebalanceCloseIxs };
type SendTxWallet = Parameters<typeof sendTx>[0]["wallet"];

export interface RebalanceCloseParams {
  connection: Connection;
  wallet: SendTxWallet;
  programId: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  portfolio: PublicKey;
  /** Signed position before the close (base q). */
  beforeQ: bigint;
  reduceQ: bigint;
  marketId: bigint;
  pythCrankAccount: PublicKey | null;
  assetIndex?: number;
}

/** Custom(18) EngineInvalidLeg: tag 44 on a leg that no longer exists. */
export const ENGINE_INVALID_LEG = 18;

const REBALANCE_CU = 600_000;

/** Real-connection deps for chooseAdlExit: simulate with the portfolio's post-state read back. */
export function connectionAdlExitDeps(connection: Connection, payer: PublicKey, portfolio: PublicKey, assetIndex: number, marketId: bigint): AdlExitDeps {
  return {
    simulate: async (ixs) => {
      const prefix = computeBudgetPrefix(REBALANCE_CU);
      const tx = new Transaction();
      for (const ix of [...prefix, ...ixs]) tx.add(ix);
      tx.feePayer = payer;
      tx.recentBlockhash = PublicKey.default.toBase58();
      const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: [portfolio.toBase58()] },
      });
      const c = parseCustomInstructionError(sim.value.err);
      const failingIx = c ? ixs[c.index - prefix.length] ?? null : null;
      const acc = sim.value.accounts?.[0];
      const portfolioAfter = acc && Array.isArray(acc.data) ? new Uint8Array(Buffer.from(acc.data[0], "base64")) : null;
      return { err: sim.value.err, failingIx, portfolioAfter };
    },
    isFlat: (d) => signedPositionForAsset(d, assetIndex, marketId) === 0n,
  };
}

export async function closeViaRebalanceReduce(
  p: RebalanceCloseParams,
  depsOverride?: AdlExitDeps,
): Promise<{ signature: string | null; fill: FillResult; route: AdlExitRoute }> {
  const id = await fetchPortfolioIdentity(p.connection, p.portfolio);
  const plain = buildRebalanceCloseIxs({ ...p, portfolioId: id.portfolioId, positionEpoch: id.positionEpoch });
  const tag44 = plain[plain.length - 1];
  const crank = plain[0];
  // B10: only when a side is ResetPending can the plain exit be trapped (18/22 at the 44).
  const info = await p.connection.getAccountInfo(p.market, "confirmed").catch(() => null);
  const view = info ? decodeMarketEngineView(new Uint8Array(info.data), p.assetIndex ?? 0) : null;
  const sides = view ? resetPendingSides(view.modeLong, view.modeShort) : [];
  let instructions = plain;
  let route: AdlExitRoute = "tag44";
  if (sides.length > 0 && tag44 && crank) {
    const deps = depsOverride ?? connectionAdlExitDeps(p.connection, p.owner, p.portfolio, p.assetIndex ?? 0, p.marketId);
    const r = await chooseAdlExit({
      programId: p.programId,
      plain,
      tag44,
      candidates: adlExitCandidates({ programId: p.programId, market: p.market, assetIndex: p.assetIndex ?? 0, crank, tag44, finalizeSides: sides }),
      deps,
    }).catch(() => ({ choice: null, trapped: false }));
    if (r.choice) {
      instructions = r.choice.instructions;
      route = r.choice.route;
    } else if (r.trapped) {
      throw new Error(COPY.adlExitTrapped);
    }
  }
  let signature: string;
  try {
    signature = await sendTx({
      connection: p.connection,
      wallet: p.wallet,
      instructions,
      // [crank, (45...), 44]: sized from simulation, capped at one leg's 400k.
      computeUnitsFromSim: { cap: tradeCuCap(1) },
      selfHeal: { programId: p.programId, market: p.market },
    });
  } catch (e) {
    // Race seen in the #519 scenario: another holder's unilateral close ADLs the matching
    // opposite OI and flattens THIS position before our tx lands => Custom(18). If a fresh read
    // shows the leg is gone, the position IS closed: report that, not an error.
    const msg = errorText(e);
    if (extractErrorCode(msg) === ENGINE_INVALID_LEG) {
      const info = await p.connection.getAccountInfo(p.portfolio, "confirmed").catch(() => null);
      const now = info ? signedPositionForAsset(new Uint8Array(info.data), p.assetIndex ?? 0, p.marketId) : null;
      if (now === 0n) return { signature: null, fill: { kind: "full", filledQ: -p.beforeQ }, route };
    }
    throw e;
  }
  const requested = p.beforeQ > 0n ? -p.reduceQ : p.reduceQ;
  const fill = await measureFill(p.connection, p.portfolio, signature, p.beforeQ, requested, p.marketId, p.assetIndex ?? 0);
  return { signature, fill, route };
}
