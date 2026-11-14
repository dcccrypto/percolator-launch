/**
 * Shared pieces of the /api/v1 read endpoints: parameter validation, the RPC guard (an upstream failure is always the
 * fixed `rpc_unavailable`, never the upstream's text), cache headers, program scope.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { ApiError } from "../errors";
import { getMarketDiscoveryProgramIds } from "@/lib/config";
import { isKnownProgram } from "@/lib/programAllowlist";

/** Market reads are shared by everyone for a second; account reads are per wallet and never cached. */
export const MARKET_CACHE = { "Cache-Control": "public, max-age=1" } as const;
export const ACCOUNT_CACHE = { "Cache-Control": "no-store" } as const;

/** Solana's target slot time, for slots -> seconds. */
export const SLOT_MS = 400;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 public key from user input: 32-44 base58 chars that round-trip through PublicKey. */
export function parsePubkey(raw: unknown, name: string): PublicKey {
  if (typeof raw !== "string" || !B58.test(raw)) throw new ApiError("bad_request", `${name} must be a base58 public key`);
  let pk: PublicKey;
  try {
    pk = new PublicKey(raw);
  } catch {
    throw new ApiError("bad_request", `${name} must be a base58 public key`);
  }
  if (pk.toBase58() !== raw) throw new ApiError("bad_request", `${name} must be a base58 public key`);
  return pk;
}

/** Counts the call and turns any failure into `rpc_unavailable` (the cause is logged server-side only, short). */
export async function rpc<T>(meta: { rpcCalls: number }, fn: () => Promise<T>): Promise<T> {
  meta.rpcCalls += 1;
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.error(JSON.stringify({ svc: "bot-api", event: "rpc_failed", err: e instanceof Error ? e.message.slice(0, 120) : "unknown" }));
    throw new ApiError("rpc_unavailable");
  }
}

/** The wrapper program(s) the API reads: the build's discovery programs that are on the allowlist. */
export function wrapperPrograms(): PublicKey[] {
  const out: PublicKey[] = [];
  for (const id of getMarketDiscoveryProgramIds()) {
    if (!isKnownProgram(id)) continue;
    try {
      out.push(new PublicKey(id));
    } catch {
      /* skip a malformed id */
    }
  }
  return out;
}

export const observedAt = (now: number = Date.now()): string => new Date(now).toISOString();

export type ReadConnection = Pick<Connection, "getAccountInfoAndContext" | "getMultipleAccountsInfoAndContext" | "getProgramAccounts" | "getSignaturesForAddress" | "getSlot">;

/** Query parameter as a string, or undefined when absent; repeated parameters are refused. */
export function queryParam(url: URL, name: string): string | undefined {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) throw new ApiError("bad_request", `${name} must be given once`);
  return all[0];
}
