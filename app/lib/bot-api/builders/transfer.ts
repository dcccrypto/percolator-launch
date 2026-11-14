/**
 * Deposits and withdrawals for the bot API, unsigned.
 *
 * Deposit: the same legs as the app's createAndDeposit (hooks/useFirstTrade.ts, lib/first-trade.ts): an existing trading
 * account gets one Deposit with its live identity; a wallet without one gets ONE atomic tx [CreateAccount, InitPortfolio,
 * Deposit(predicted id, sequence 0)]. The new portfolio account must sign its own creation, so the CALLER generates that
 * keypair and sends its public key as `newPortfolio`; the server never holds or makes a key.
 * Withdraw: the app's WithdrawCollateral (hooks/useWithdraw.ts:388-402) with the same refusals up front: no withdrawal
 * while a position is open (the engine forbids it), never more than the account's capital. Converting released PnL
 * first (lib/convert-released-pnl.ts) is not covered in v1: an amount above capital is refused.
 * Every returned tx is simulated on its exact bytes (./common.ts finalizeTx).
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  ACCOUNTS_WITHDRAW_COLLATERAL,
  WELL_KNOWN,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  encodeWithdrawCollateral,
  getAta,
  parseWrapperConfigV17,
  V17_HEADER_LEN,
} from "@percolatorct/sdk";
import { ApiError } from "@/lib/bot-api/errors";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { getMaintenanceConfig } from "@/lib/maintenance";
import { isWrapperAccount, parsePortfolio, portfolioAccountLen } from "@/lib/v22/layout";
import { marketAssetSlots } from "@/lib/v22/trade-refresh";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";
import { fetchPortfolioIdentity } from "@/lib/v18-wire";
import { buildFirstTradeInitIxs, buildFirstDepositIx, readNextPortfolioId, predictPortfolioId } from "@/lib/first-trade";
import { simulateForGate, getPriorityFee } from "@/lib/tx";
import { signedComputeUnitLimit } from "@/lib/compute-budget";
import { finalizeTx, noTradingAccount, onlyKeys, pubkeyField, uintStringField, wrapTx, simulationError, MAX_U64, type ReturnedTx } from "./common";

export interface TransferResponse {
  transactions: ReturnedTx[];
  blockhash: string;
  lastValidBlockHeight: number;
  resubmitAfter: false;
  summary: Record<string, unknown>;
}

type Meta = { rpcCalls: number; sims: number };

interface MarketCtx {
  programId: PublicKey;
  raw: Uint8Array;
  mint: PublicKey;
  userAta: PublicKey;
  vaultPda: PublicKey;
  vaultTokenAta: PublicKey;
}

async function readMarket(connection: Connection, market: PublicKey, owner: PublicKey, meta: Meta): Promise<MarketCtx> {
  if (getMaintenanceConfig().blockWrites) throw new ApiError("maintenance", getMaintenanceConfig().message);
  meta.rpcCalls++;
  const info = await connection.getAccountInfo(market, "confirmed");
  if (!info) throw new ApiError("market_not_found");
  try {
    assertKnownProgram(info.owner);
  } catch {
    throw new ApiError("market_not_found", "no Percolator market at this address (the account is not owned by a Percolator wrapper)");
  }
  const raw = new Uint8Array(info.data);
  if (!isWrapperAccount(raw)) throw new ApiError("market_unsupported", "not a v2.2 market account");
  const slots = marketAssetSlots(raw);
  if (slots === null || slots > 1) throw new ApiError("market_unsupported", "multi-asset markets are not supported by this endpoint yet");
  let mint: PublicKey;
  try {
    mint = parseWrapperConfigV17(raw, V17_HEADER_LEN).collateralMint;
  } catch {
    throw new ApiError("market_unreadable");
  }
  const [vaultPda] = deriveVaultAuthority(info.owner, market);
  const [userAta, vaultTokenAta] = await Promise.all([getAta(owner, mint), getAta(vaultPda, mint, true)]);
  return { programId: info.owner, raw, mint, userAta, vaultPda, vaultTokenAta };
}

/** Sizes the compute limit from a gate simulation of the instructions, then wraps and proves the exact bytes. */
async function sizeAndFinalize(connection: Connection, owner: PublicKey, ixs: TransactionInstruction[], purpose: string, cuCap: number, meta: Meta) {
  meta.rpcCalls++;
  meta.sims++;
  const g = await simulateForGate(connection, owner, ixs);
  if (g.rpcFailed) throw new ApiError("rpc_unavailable", "simulation RPC failed, try again");
  if (g.err) throw simulationError(g.err, g.logs, (i) => g.simulated[i]?.programId.toBase58());
  meta.rpcCalls += 2;
  const [{ blockhash, lastValidBlockHeight }, priorityFee] = await Promise.all([connection.getLatestBlockhash("confirmed"), getPriorityFee(connection)]);
  const limit = signedComputeUnitLimit(g.consumed, { cap: cuCap });
  const tx = wrapTx(ixs, limit, priorityFee, owner, blockhash);
  return { returned: await finalizeTx(connection, tx, purpose, meta), blockhash, lastValidBlockHeight };
}

async function tokenBalance(connection: Connection, ata: PublicKey, meta: Meta): Promise<bigint | null> {
  meta.rpcCalls++;
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info || info.data.length < 72) return null;
  // SPL token account amount: u64 LE at offset 64. DataView, not Buffer BigInt (browser-buffer-bigint-guard).
  const d = new Uint8Array(info.data);
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true);
}

/** Rent-exempt minimum of a 0-byte system account: the owner may not be left holding less than this (unless it empties to 0). */
export const SYSTEM_MIN_BALANCE = 890_880;
/**
 * SOL the owner needs to create a trading account: the portfolio account's rent, the two signatures (owner + the new account,
 * 5,000 lamports each), the priority fee on the compute limit, and the minimum the owner's own account must keep.
 */
export function firstDepositLamports(rentLamports: number, priorityMicroLamports: number, computeUnits: number): number {
  return rentLamports + 2 * 5_000 + Math.ceil((priorityMicroLamports * computeUnits) / 1_000_000) + SYSTEM_MIN_BALANCE;
}

const DEPOSIT_FIELDS = ["owner", "market", "amount", "portfolio", "newPortfolio", "expiresAfter"] as const;

export async function buildDeposit(connection: Connection, b: Record<string, unknown>, meta: Meta): Promise<TransferResponse> {
  onlyKeys(b, DEPOSIT_FIELDS);
  const owner = pubkeyField(b, "owner", true);
  const market = pubkeyField(b, "market", true);
  const amount = uintStringField(b, "amount", { required: true, max: MAX_U64, positive: true })!;
  const given = pubkeyField(b, "portfolio", false);
  const fresh = pubkeyField(b, "newPortfolio", false);
  if (given && fresh) throw new ApiError("bad_request", "give portfolio or newPortfolio, not both");
  try {
    const m = await readMarket(connection, market, owner, meta);
    const bal = await tokenBalance(connection, m.userAta, meta);
    if (bal === null || bal < amount) {
      throw new ApiError("insufficient_funds", `wallet holds ${bal ?? 0n} collateral atoms, deposit asks for ${amount}`, { details: { balance: (bal ?? 0n).toString(), mint: m.mint.toBase58() } });
    }
    const legs = (portfolio: PublicKey) => ({ programId: m.programId, owner, market, portfolio, userAta: m.userAta, vaultTokenAta: m.vaultTokenAta, depositAtoms: amount });

    meta.rpcCalls++;
    const existing = given ?? (await findOwnerPortfolio(connection, m.programId, market, owner));
    if (existing) {
      meta.rpcCalls++;
      const pinfo = await connection.getAccountInfo(existing, "confirmed");
      let ok = false;
      try {
        const pf = pinfo && pinfo.owner.equals(m.programId) ? parsePortfolio(new Uint8Array(pinfo.data)) : null;
        ok = !!pf && pf.owner.equals(owner) && pf.marketGroupId.equals(market);
      } catch {
        ok = false;
      }
      if (!ok) throw new ApiError("bad_portfolio");
      if (fresh) throw new ApiError("bad_request", "the wallet already has a trading account on this market; drop newPortfolio");
      meta.rpcCalls++;
      const id = await fetchPortfolioIdentity(connection, existing);
      const ixs = [buildFirstDepositIx(legs(existing), { portfolioId: id.portfolioId, sequence: id.matcherSequence })];
      const r = await sizeAndFinalize(connection, owner, ixs, "deposit", 400_000, meta);
      return { transactions: [r.returned], blockhash: r.blockhash, lastValidBlockHeight: r.lastValidBlockHeight, resubmitAfter: false, summary: { market: market.toBase58(), portfolio: existing.toBase58(), amount: amount.toString(), created: false } };
    }

    if (!fresh) {
      throw noTradingAccount();
    }
    meta.rpcCalls += 2;
    if (await connection.getAccountInfo(fresh, "confirmed")) throw new ApiError("bad_request", "newPortfolio already exists; use a fresh keypair");
    const next = readNextPortfolioId(m.raw);
    if (next === null) throw new ApiError("market_unreadable");
    const rent = await connection.getMinimumBalanceForRentExemption(portfolioAccountLen());
    // The owner pays the new account's rent (and the fees) in SOL. Without enough, the simulation fails inside the System program.
    const priorityFee = await getPriorityFee(connection);
    const needLamports = firstDepositLamports(rent, priorityFee, 600_000);
    meta.rpcCalls++;
    const haveLamports = await connection.getBalance(owner, "confirmed");
    if (haveLamports < needLamports) {
      throw new ApiError(
        "insufficient_funds",
        `creating the trading account needs about ${needLamports} lamports of SOL (${rent} account rent + fees + the ${SYSTEM_MIN_BALANCE} the wallet must keep); the wallet has ${haveLamports}. Fund it with devnet SOL and retry`,
        { details: { needLamports, haveLamports, rentLamports: rent } },
      );
    }
    const ixs = [
      ...buildFirstTradeInitIxs({ programId: m.programId, owner, market, portfolio: fresh }, rent),
      buildFirstDepositIx(legs(fresh), { portfolioId: predictPortfolioId(next), sequence: 0n }),
    ];
    const r = await sizeAndFinalize(connection, owner, ixs, "create-and-deposit", 600_000, meta);
    return {
      transactions: [r.returned],
      blockhash: r.blockhash,
      lastValidBlockHeight: r.lastValidBlockHeight,
      resubmitAfter: false,
      summary: { market: market.toBase58(), portfolio: fresh.toBase58(), amount: amount.toString(), created: true, rentLamports: rent, predictedPortfolioId: predictPortfolioId(next).toString() },
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("rpc_unavailable");
  }
}

const WITHDRAW_FIELDS = ["owner", "market", "amount", "portfolio", "expiresAfter"] as const;

export async function buildWithdraw(connection: Connection, b: Record<string, unknown>, meta: Meta): Promise<TransferResponse> {
  onlyKeys(b, WITHDRAW_FIELDS);
  const owner = pubkeyField(b, "owner", true);
  const market = pubkeyField(b, "market", true);
  const amount = uintStringField(b, "amount", { required: true, max: MAX_U64, positive: true })!;
  const given = pubkeyField(b, "portfolio", false);
  try {
    const m = await readMarket(connection, market, owner, meta);
    meta.rpcCalls++;
    const portfolio = given ?? (await findOwnerPortfolio(connection, m.programId, market, owner));
    if (!portfolio) throw noTradingAccount();
    meta.rpcCalls++;
    const pinfo = await connection.getAccountInfo(portfolio, "confirmed");
    let pf: ReturnType<typeof parsePortfolio> | null = null;
    try {
      pf = pinfo && pinfo.owner.equals(m.programId) ? parsePortfolio(new Uint8Array(pinfo.data)) : null;
    } catch {
      pf = null;
    }
    if (!pf || !pf.owner.equals(owner) || !pf.marketGroupId.equals(market)) throw new ApiError("bad_portfolio");
    if (pf.legs.some((l) => l.active)) {
      throw new ApiError("insufficient_funds", "no withdrawal while a position is open on this account (the engine forbids it); close it first", { details: { reason: "position_open" } });
    }
    if (amount > pf.capital) {
      throw new ApiError("insufficient_funds", `amount ${amount} is above the account's capital ${pf.capital}`, { details: { capital: pf.capital.toString() } });
    }
    meta.rpcCalls++;
    const id = await fetchPortfolioIdentity(connection, portfolio);
    const ixs: TransactionInstruction[] = [
      // The destination ATA may not exist yet (a wallet that deposited from elsewhere); idempotent create is a no-op otherwise.
      createAssociatedTokenAccountIdempotentInstruction(owner, m.userAta, owner, m.mint),
      buildIx({
        programId: m.programId,
        keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [owner, market, portfolio, m.userAta, m.vaultTokenAta, m.vaultPda, WELL_KNOWN.tokenProgram]),
        data: encodeWithdrawCollateral({ portfolioId: id.portfolioId, expectedSequence: id.matcherSequence, amount: amount.toString() }),
      }),
    ];
    const r = await sizeAndFinalize(connection, owner, ixs, "withdraw", 400_000, meta);
    return { transactions: [r.returned], blockhash: r.blockhash, lastValidBlockHeight: r.lastValidBlockHeight, resubmitAfter: false, summary: { market: market.toBase58(), portfolio: portfolio.toBase58(), amount: amount.toString(), capitalBefore: pf.capital.toString() } };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("rpc_unavailable");
  }
}
