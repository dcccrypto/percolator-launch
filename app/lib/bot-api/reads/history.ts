/**
 * Account history from chain signatures. v2.2 has no lot-aware indexer (lib/v22/indexer.ts), so there are no fills yet:
 * this lists the transactions that touched the wallet's portfolio accounts (every deposit, trade, withdrawal, crank), newest
 * first, merged across portfolios by slot. Cursor = the last signature returned (`before`), the RPC's own cursor.
 * Per portfolio at most `limit` signatures are fetched, so a page costs 1 gPA + one getSignaturesForAddress per portfolio
 * (capped at MAX_PORTFOLIOS; `truncated` says when the cap cut the wallet's portfolio list).
 */
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { ApiError, customCodeOf, onchainErrorName } from "../errors";
import { OWNER_PORTFOLIO_MAGIC, OWNER_PORTFOLIO_OWNER_OFF } from "@/lib/owner-portfolio";
import { rpc, wrapperPrograms, type ReadConnection } from "./common";

export const DEFAULT_HISTORY_LIMIT = 25;
export const MAX_HISTORY_LIMIT = 100;
export const MAX_PORTFOLIOS = 10;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) throw new ApiError("bad_request", `limit must be an integer 1-${MAX_HISTORY_LIMIT}`);
  const n = Number(raw);
  if (n < 1 || n > MAX_HISTORY_LIMIT) throw new ApiError("bad_request", `limit must be an integer 1-${MAX_HISTORY_LIMIT}`);
  return n;
}

export function parseBefore(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!SIG.test(raw)) throw new ApiError("bad_signature", "before must be a transaction signature");
  return raw;
}

export interface HistoryItem {
  signature: string;
  slot: number;
  blockTime: number | null;
  portfolios: string[];
  ok: boolean;
  err: { code: number | null; name: string | null; raw: unknown } | null;
  memo: string | null;
  confirmationStatus: string | null;
}

/** Pure merge: newest first, one row per signature (a transaction can touch several of the wallet's portfolios). */
export function mergeSignatures(perPortfolio: Array<{ portfolio: string; sigs: ConfirmedSignatureInfo[] }>, limit: number): { items: HistoryItem[]; more: boolean } {
  const bySig = new Map<string, HistoryItem>();
  for (const { portfolio, sigs } of perPortfolio) {
    for (const s of sigs) {
      const hit = bySig.get(s.signature);
      if (hit) {
        if (!hit.portfolios.includes(portfolio)) hit.portfolios.push(portfolio);
        continue;
      }
      const code = s.err ? customCodeOf(s.err) : null;
      bySig.set(s.signature, {
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ?? null,
        portfolios: [portfolio],
        ok: s.err === null,
        err: s.err === null ? null : { code, name: code === null ? null : onchainErrorName(code), raw: s.err },
        memo: s.memo ?? null,
        confirmationStatus: s.confirmationStatus ?? null,
      });
    }
  }
  const all = [...bySig.values()].sort((a, b) => b.slot - a.slot || (a.signature < b.signature ? -1 : 1));
  return { items: all.slice(0, limit), more: all.length > limit || perPortfolio.some((p) => p.sigs.length >= limit) };
}

export async function historyView(connection: ReadConnection, meta: { rpcCalls: number }, wallet: PublicKey, limit: number, before: string | undefined) {
  const accounts: PublicKey[] = [];
  let slot = Number.POSITIVE_INFINITY;
  for (const programId of wrapperPrograms()) {
    const res = await rpc(meta, () =>
      connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        withContext: true,
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { memcmp: { offset: 0, bytes: OWNER_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: OWNER_PORTFOLIO_OWNER_OFF, bytes: wallet.toBase58() } },
        ],
      }),
    );
    slot = Math.min(slot, res.context.slot);
    for (const r of res.value) accounts.push(r.pubkey);
  }
  if (!Number.isFinite(slot)) slot = await rpc(meta, () => connection.getSlot("confirmed"));
  accounts.sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
  const used = accounts.slice(0, MAX_PORTFOLIOS);
  const perPortfolio = await Promise.all(
    used.map(async (pk) => ({
      portfolio: pk.toBase58(),
      sigs: await rpc(meta, () => connection.getSignaturesForAddress(pk, { limit, ...(before ? { before } : {}) }, "confirmed")),
    })),
  );
  const { items, more } = mergeSignatures(perPortfolio, limit);
  return {
    source: "chain-signatures" as const,
    note: "Transactions that touched this wallet's portfolio accounts, newest first. v2.2 has no lot-aware indexer yet, so there are no decoded fills; they come with the indexer. Page with before=<last signature>.",
    slot,
    wallet: wallet.toBase58(),
    portfolios: used.map((p) => p.toBase58()),
    truncated: accounts.length > used.length,
    limit,
    items,
    nextBefore: more && items.length > 0 ? items[items.length - 1].signature : null,
  };
}
