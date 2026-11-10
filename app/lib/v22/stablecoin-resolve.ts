/**
 * Server-side token-identity resolution for the stablecoin refusal (v2.2 only; see ./stablecoin-perps).
 *
 * Why: a registration that gives only a DEX pool (no mainnet_ca) has no token identity the address list can see, and a client-supplied
 * symbol proves nothing. So the server reads the MAINNET chain itself: the pool account (base / quote mints, via the SDK's own pool
 * parser, the one the keeper prices with) and the mints' on-chain metadata (Metaplex PDA, or the Token-2022 metadata extension), then
 * applies the verified address list and the exact-ticker symbol/name rule.
 *
 * Failure policy: a pool-only request whose pool cannot be resolved is REFUSED (never waved through); a metadata read that fails is
 * not (the address list already ran, the symbol layer is defence in depth).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { parseDexPool } from "@percolatorct/sdk";
import { MAINNET_RPC_URL, classifyOwner } from "@/lib/dex-pool-owner";
import { USD_PRICEABLE_QUOTE_MINTS } from "@/lib/dex-constants";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { isStablecoinMintAddress, stablecoinIdentityVerdict, type StablecoinTokenMeta } from "@/lib/v22/stablecoin-perps";

const METAPLEX_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const WSOL = "So11111111111111111111111111111111111111112";

export type StablecoinCheck =
  | { ok: true; suspect?: string }
  | { ok: false; kind: "stablecoin" }
  /** Pool-only request whose pool's tokens could not be read: `retryable` = the mainnet RPC failed (503), else the pool is missing / unsupported (400). */
  | { ok: false; kind: "unverifiable"; retryable: boolean };

type Conn = Pick<Connection, "getMultipleAccountsInfo">;

function readBorshString(b: Uint8Array, o: number): [string, number] | null {
  if (o + 4 > b.length) return null;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
  if (n > 1024 || o + 4 + n > b.length) return null;
  return [new TextDecoder().decode(b.slice(o + 4, o + 4 + n)).replace(/\0+$/, ""), o + 4 + n];
}

/** Name + symbol from a Metaplex metadata account (key u8, update authority 32, mint 32, then name, symbol borsh strings). */
export function parseMetaplexNameSymbol(data: Uint8Array): StablecoinTokenMeta | null {
  const n = readBorshString(data, 65);
  const s = n && readBorshString(data, n[1]);
  return n && s ? { name: n[0], symbol: s[0] } : null;
}

/** Name + symbol from a Token-2022 mint's TokenMetadata extension (TLV type 19: update authority 32, mint 32, name, symbol, ...). */
export function parseToken2022NameSymbol(data: Uint8Array): StablecoinTokenMeta | null {
  if (data.length <= 166) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 166;
  while (o + 4 <= data.length) {
    const type = dv.getUint16(o, true);
    const len = dv.getUint16(o + 2, true);
    if (type === 19) {
      const n = readBorshString(data, o + 4 + 64);
      const s = n && readBorshString(data, n[1]);
      return n && s ? { name: n[0], symbol: s[0] } : null;
    }
    o += 4 + len;
  }
  return null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("mainnet RPC timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** On-chain name/symbol per mint (base58). A mint whose metadata is absent / unreadable is simply left out. Throws on RPC failure. */
async function readMintMetas(mints: string[], conn: Conn, timeoutMs: number): Promise<Record<string, StablecoinTokenMeta>> {
  const keys: PublicKey[] = [];
  for (const m of mints) {
    const mint = new PublicKey(m);
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX_METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METAPLEX_METADATA_PROGRAM);
    keys.push(mint, pda);
  }
  const infos = await withTimeout(conn.getMultipleAccountsInfo(keys), timeoutMs);
  const out: Record<string, StablecoinTokenMeta> = {};
  mints.forEach((m, i) => {
    const meta = infos[2 * i + 1] ? parseMetaplexNameSymbol(new Uint8Array(infos[2 * i + 1]!.data)) : infos[2 * i] ? parseToken2022NameSymbol(new Uint8Array(infos[2 * i]!.data)) : null;
    if (meta) out[m] = meta;
  });
  return out;
}

export interface StablecoinCheckInput {
  /** Canonical mainnet_ca / mainnetCA when the caller gave one. */
  mainnetCa?: string | null;
  /** Canonical DEX pool address when the caller gave one. */
  pool?: string | null;
  /** Client-supplied symbol / name: refuse-only (can add a refusal, never lift one). */
  symbol?: unknown;
  name?: unknown;
  conn?: Conn;
  timeoutMs?: number;
}

/**
 * The full server-side stablecoin refusal. v2.2 only (flag off: always ok). Order: client symbol/name (refuse-only) -> address list on
 * mainnet_ca -> (pool given) read the pool, address list on its mints -> on-chain symbol/name of the underlying mint(s).
 */
export async function checkStablecoinUnderlying(input: StablecoinCheckInput): Promise<StablecoinCheck> {
  if (!isDevnetV22Enabled()) return { ok: true };
  const clientMeta: StablecoinTokenMeta = { symbol: typeof input.symbol === "string" ? input.symbol : null, name: typeof input.name === "string" ? input.name : null };
  if (stablecoinIdentityVerdict(clientMeta) === "block") return { ok: false, kind: "stablecoin" };
  if (isStablecoinMintAddress(input.mainnetCa)) return { ok: false, kind: "stablecoin" };

  const timeoutMs = input.timeoutMs ?? 8_000;
  const conn: Conn = input.conn ?? new Connection(MAINNET_RPC_URL, "confirmed");
  const underlying = new Set<string>();
  if (input.mainnetCa) underlying.add(input.mainnetCa);

  if (input.pool) {
    let base: string | null = null;
    let quote: string | null = null;
    let rpcFailed = false;
    const poolKey = new PublicKey(input.pool);
    try {
      const [info] = await withTimeout(conn.getMultipleAccountsInfo([poolKey]), timeoutMs);
      const type = info ? classifyOwner(info.owner.toBase58()) : "unsupported";
      if (info && type !== "unsupported") {
        try {
          const p = parseDexPool(type, poolKey, new Uint8Array(info.data));
          base = p.baseMint.toBase58();
          quote = p.quoteMint.toBase58();
        } catch {
          // not a pool of its owner's type: unresolved (below)
        }
      }
    } catch {
      rpcFailed = true;
    }
    if (base && quote) {
      const quoteIsPriceable = USD_PRICEABLE_QUOTE_MINTS.has(quote);
      // The pool's quote side is expected to be WSOL / USDC / USDT (the keeper's price units); it is only a problem when the BASE is
      // a stable, or when a stable sits on the quote side outside that expected set.
      if (isStablecoinMintAddress(base) || (isStablecoinMintAddress(quote) && !quoteIsPriceable)) return { ok: false, kind: "stablecoin" };
      if (base !== WSOL) underlying.add(base);
    } else if (!input.mainnetCa) {
      // Pool-only and unresolved: the token identity is unknown, so it is not registered.
      return { ok: false, kind: "unverifiable", retryable: rpcFailed };
    }
  }

  if (underlying.size > 0) {
    try {
      const metas = await readMintMetas([...underlying], conn, timeoutMs);
      let suspect: string | undefined;
      for (const [mint, meta] of Object.entries(metas)) {
        const v = stablecoinIdentityVerdict(meta);
        if (v === "block") return { ok: false, kind: "stablecoin" };
        if (v === "suspect") suspect = `${mint} ${meta.symbol ?? ""} / ${meta.name ?? ""}`;
      }
      return suspect ? { ok: true, suspect } : { ok: true };
    } catch {
      return { ok: true }; // metadata unreadable: the address list already ran (defence in depth only)
    }
  }
  return { ok: true };
}
