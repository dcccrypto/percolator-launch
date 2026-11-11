/**
 * Server-side token-identity resolution for the stablecoin refusal (v2.2 only; see ./stablecoin-perps).
 *
 * Why: a registration that gives only a DEX pool (no mainnet_ca) has no token identity the address list can see, and a client-supplied
 * symbol proves nothing. So the server reads the MAINNET chain itself: the pool account (base / quote mints, via the SDK's own pool
 * parser, the one the keeper prices with) and the mints' on-chain metadata (Metaplex PDA, or the Token-2022 metadata extension), then
 * applies the verified address list and the exact-ticker symbol/name rule.
 *
 * Failure policy (fail closed): a request with neither a pool nor a mainnet_ca has no token identity to check and is REFUSED; a request
 * with a pool that cannot be resolved is REFUSED (never waved through, mainnet_ca or not); a given mainnet_ca must equal the pool's base
 * mint; and an RPC failure while reading the token metadata is REFUSED as retryable (a mint whose metadata account simply does not exist
 * is fine: the address list and the client symbol already ran).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { parseDexPool } from "@percolatorct/sdk";
import { MAINNET_RPC_URL, classifyOwner } from "@/lib/dex-pool-owner";
import { USD_PRICEABLE_QUOTE_MINTS } from "@/lib/dex-constants";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { isStablecoinMintAddress, stablecoinIdentityVerdict, type StablecoinTokenMeta } from "@/lib/v22/stablecoin-perps";

const METAPLEX_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SPL_TOKEN_PROGRAMS: ReadonlySet<string> = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const WSOL = "So11111111111111111111111111111111111111112";

export type StablecoinCheck =
  | { ok: true; suspect?: string }
  | { ok: false; kind: "stablecoin" }
  /** A pool AND a mainnet_ca were given and the pool's base mint is not that mint: the stated identity is not what the pool prices. */
  | { ok: false; kind: "mismatch" }
  /** Request with a pool whose tokens could not be read: `retryable` = the mainnet RPC failed (503), else the pool is missing / unsupported (400). */
  | { ok: false; kind: "unverifiable"; retryable: boolean }
  /** Neither a pool nor a mainnet_ca was given: there is no token identity to check, so the registration is refused. */
  | { ok: false; kind: "no-identity" };

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

/** Thrown when a given mint account does not exist on mainnet or is not an SPL Token / Token-2022 mint. */
class NotAMintError extends Error {}

/** On-chain name/symbol per mint (base58). A mint whose metadata is absent / unreadable is simply left out. Throws on RPC failure, and NotAMintError when a mint account is missing or not owned by SPL Token / Token-2022. */
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
    // Metaplex first; when that account is absent OR does not parse, fall back to the Token-2022 metadata extension on the mint.
    const mpl = infos[2 * i + 1];
    const t22 = infos[2 * i];
    if (!t22 || !SPL_TOKEN_PROGRAMS.has(t22.owner.toBase58())) throw new NotAMintError(m);
    const meta = (mpl ? parseMetaplexNameSymbol(new Uint8Array(mpl.data)) : null) ?? (t22 ? parseToken2022NameSymbol(new Uint8Array(t22.data)) : null);
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

  // No pool and no mainnet_ca: nothing here says which token the market prices, so it cannot be cleared. (The slab itself holds only the
  // devnet collateral mint, never the mainnet underlying, so there is nothing on-chain to resolve it from either.)
  if (!input.mainnetCa && !input.pool) return { ok: false, kind: "no-identity" };

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
      // The stated token identity must be the token the pool prices.
      if (input.mainnetCa && input.mainnetCa !== base) return { ok: false, kind: "mismatch" };
    } else {
      // A supplied pool that cannot be resolved is refused, even when a mainnet_ca came with it: the pool is what gets priced.
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
    } catch (e) {
      // A given mainnet_ca that is not an SPL Token / Token-2022 mint (missing account, wallet, program, random key) is no token identity: refused, not retryable.
      if (e instanceof NotAMintError) return { ok: false, kind: "unverifiable", retryable: false };
      // Fail closed: the metadata RPC read failed, so the token's on-chain symbol / name is unknown. Refuse, retryable.
      return { ok: false, kind: "unverifiable", retryable: true };
    }
  }
  return { ok: true };
}

/**
 * The registered pool vs the pool the slab pins on-chain (legacy config layout: `dexPool`, set by SetDexPool). `pinned` null = the slab pins
 * none (never set, or a layout with no such field, e.g. the v17+ wrapper config), so there is nothing to contradict.
 */
export function slabPinnedPoolMismatch(registeredPool: string | null | undefined, pinnedPool: string | null | undefined): boolean {
  if (!registeredPool || !pinnedPool) return false;
  return registeredPool !== pinnedPool;
}
