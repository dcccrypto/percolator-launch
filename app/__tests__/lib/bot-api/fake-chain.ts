/** A fake read-only Connection over recorded devnet accounts, and the fixtures the read tests share. Test-only. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, type AccountInfo, type ConfirmedSignatureInfo } from "@solana/web3.js";

const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "../../fixtures", name), "utf8"));
const b64 = (s: string) => Buffer.from(s, "base64");

/** Real devnet GATO market (wrapper 5NGgnU2j), funding managed but flat (no open interest). */
const gato = fx("v22-trade-build/gato-market.json") as { slab: string; owner: string; data: string };
export const WRAPPER = new PublicKey(gato.owner);
export const GATO = new PublicKey(gato.slab);
export const GATO_DATA = b64(gato.data);

/** Real devnet SOL market + its vault LP portfolio + matcher context, with the deployed matcher's golden prices. */
const sol = fx("v22-spread-size-aware-sol.json");
export const SOL = new PublicKey(sol.market);
export const SOL_DATA = b64(sol.marketB64);
export const LP = new PublicKey(sol.lp);
export const LP_DATA = b64(sol.lpB64);
export const CTX = new PublicKey(sol.ctx);
export const CTX_DATA = b64(sol.ctxB64);
export const SOL_SLOT: number = sol.slot;
export const SOL_ORACLE = sol.oracle as { priceE6: string; slot: string; lpPositionQ: string; inventoryCapQ: string; liquidityNotionalE6: string };
export const GOLDEN = sol.golden as Array<{ side: "buy" | "sell"; reducing: boolean; usd: number; sizeQ: string; execPriceE6?: string; execSize?: string; err?: string }>;

const multi = fx("v22-market-multi-asset-2xhs.json");
export const MULTI = new PublicKey(multi.market);
export const MULTI_DATA = b64(multi.dataBase64);
const v21 = fx("Azagguvr.market.json");
export const V21 = new PublicKey(v21.market);
export const V21_DATA = b64(v21.dataBase64);

export const pk = (n: number): PublicKey => new PublicKey(new Uint8Array(32).fill(n));

export interface FakeOpts {
  slot?: number;
  accounts?: Array<[PublicKey, Buffer, PublicKey?]>;
  /** getProgramAccounts answers: called with the config; return [] for none. */
  gpa?: (programId: PublicKey, cfg: { filters?: unknown[]; dataSlice?: unknown; withContext?: boolean }) => Array<{ pubkey: PublicKey; account: { data: Buffer } }>;
  sigs?: Record<string, ConfirmedSignatureInfo[]>;
}

/** A Connection stand-in. `fail` makes every call reject with text that must never reach a response. */
export function fakeConnection(o: FakeOpts = {}) {
  const state = { slot: o.slot ?? 1000, fail: false, calls: [] as string[], gpaCfgs: [] as Array<{ filters?: unknown[]; dataSlice?: unknown; withContext?: boolean }>, sigCalls: [] as Array<{ pk: string; opts: { limit?: number; before?: string } }> };
  const accounts = new Map<string, { data: Buffer; owner: PublicKey }>();
  for (const [k, d, owner] of o.accounts ?? []) accounts.set(k.toBase58(), { data: d, owner: owner ?? WRAPPER });
  const info = (k: PublicKey): AccountInfo<Buffer> | null => {
    const a = accounts.get(k.toBase58());
    return a ? { data: a.data, owner: a.owner, lamports: 1, executable: false } : null;
  };
  const guard = (name: string) => {
    state.calls.push(name);
    if (state.fail) throw new Error("429 Too Many Requests from https://secret-rpc.example/?api-key=abc123");
  };
  const conn = {
    async getSlot() {
      guard("getSlot");
      return state.slot;
    },
    async getAccountInfoAndContext(k: PublicKey) {
      guard("getAccountInfoAndContext");
      return { context: { slot: state.slot }, value: info(k) };
    },
    async getMultipleAccountsInfoAndContext(ks: PublicKey[]) {
      guard("getMultipleAccountsInfoAndContext");
      return { context: { slot: state.slot }, value: ks.map(info) };
    },
    async getProgramAccounts(programId: PublicKey, cfg: { filters?: unknown[]; dataSlice?: unknown; withContext?: boolean } = {}) {
      guard("getProgramAccounts");
      state.gpaCfgs.push(cfg);
      const value = o.gpa ? o.gpa(programId, cfg) : [];
      return cfg.withContext ? { context: { slot: state.slot }, value } : value;
    },
    async getSignaturesForAddress(k: PublicKey, opts: { limit?: number; before?: string } = {}) {
      guard("getSignaturesForAddress");
      state.sigCalls.push({ pk: k.toBase58(), opts });
      let list = o.sigs?.[k.toBase58()] ?? [];
      if (opts.before) {
        const i = list.findIndex((s) => s.signature === opts.before);
        list = i >= 0 ? list.slice(i + 1) : list.filter((s) => s.slot < (o.sigs ? Number.MAX_SAFE_INTEGER : 0));
      }
      return list.slice(0, opts.limit ?? 1000);
    },
  };
  return { conn, state };
}
