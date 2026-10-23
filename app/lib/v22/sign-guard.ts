/**
 * v2.2 QA NB-2 (reopened, retest 5): instrumentation in front of EVERY wallet signature on the v2.2 build.
 *
 * One order in seven made Solflare show "Network mismatch" although the app has a single (devnet) connection. This
 * records, for every transaction handed to a wallet: where its blockhash was fetched (the path tag), how old it is,
 * what the transaction contains (program + instruction tag per instruction), and the chain the wallet was told.
 * Before the wallet opens it asserts:
 *   1. the connection the blockhash came from (else the app connection) is devnet, by genesis hash;
 *   2. the blockhash was fetched by this app from that connection. An untagged blockhash is checked on the devnet
 *      connection: unknown there = refused, known there = allowed but reported.
 * A failure refuses the signature, logs `[v22 sign-guard]` to the console and shows the debug line
 * (components/v22/SignGuardLine.tsx). Every request (also the ones the wallet declines) is kept in
 * `window.__v22SignLog`. Flag off: `guardSign` calls the wallet directly and nothing is recorded.
 *
 * QA instrumentation for the preview: remove (or put behind a debug switch) before any release.
 */
import { PublicKey, SystemInstruction, SystemProgram, type Connection, type Transaction } from "@solana/web3.js";
import { assertDevnetConnection, WrongClusterError } from "./devnet-guard";
import { isDevnetV22Enabled } from "./flag";
import { detectWalletError, isTransientError, UserFacingError } from "@/lib/errorMessages";
import { WALLET_BUSY_COPY, WALLET_REQUEST_CLOSED_COPY } from "@/lib/wallet-request-copy";

export const SIGN_CHAIN_DEVNET = "solana:devnet";
/** A blockhash older than this at the moment the wallet opens is reported (not refused). */
export const STALE_BLOCKHASH_MS = 30_000;
const ORIGIN_TTL_MS = 180_000;
const LOG_MAX = 50;

type GuardConnection = Pick<Connection, "getGenesisHash" | "isBlockhashValid"> & Partial<Pick<Connection, "getMultipleAccountsInfo">>;
interface Origin { path: string; ts: number; connection: GuardConnection | null; commitment: string | null; lastValidBlockHeight: number | null }

export type SignVerdict = "ok" | "stale-blockhash" | "untagged-blockhash" | "REFUSED-wrong-cluster" | "REFUSED-blockhash-not-on-devnet";
export interface SignLogEntry {
  at: string;
  /** Which wallet call: signTransaction / signAllTransactions[i/n] and the provider. */
  via: string;
  /** Where the blockhash was fetched (the builder path). */
  path: string;
  blockhash: string;
  blockhashAgeMs: number | null;
  /** NB-2 (round f): commitment the blockhash was fetched at, its lastValidBlockHeight, and whether `isBlockhashValid(confirmed)` on the app connection passed right before the wallet opened (null = not checked / RPC did not answer). */
  fetchCommitment: string | null;
  lastValidBlockHeight: number | null;
  validAtHandoff: boolean | null;
  /** program:tag per instruction, e.g. "cb,cb,cb,w:10". */
  shape: string;
  chain: string;
  verdict: SignVerdict;
  /**
   * RT5b: accounts of this transaction that do not exist on the devnet connection ("w:" writable, "r:" read-only), or
   * null when not checked. A PDA signer or an account the transaction creates is absent legitimately, so this is
   * recorded for diagnosis (it is in the debug line), never a reason to refuse.
   */
  absentOnDevnet: string[] | null;
  /**
   * NB-2 (2026-10-14): absent accounts that are OFF the ed25519 curve, i.e. program-derived addresses (the vault
   * authority, a matcher delegate, ...). A PDA signer is never an account on any cluster (the wrapper signs for it with
   * invoke_signed), so it is absent on devnet AND mainnet by design and says nothing about the cluster. Listed here, not
   * in `absentOnDevnet`, so a mainnet-only account is not buried among them.
   */
  absentPdas?: string[];
  /**
   * Create step 1 (2026-10-15): absent accounts that a System createAccount in this same transaction creates (the new
   * slab, a portfolio, ...). They cannot exist before the transaction lands, so they are not suspects either.
   */
  absentCreated?: string[];
  /** Another wallet request from this app was still open when this one was handed to the wallet. */
  overlapping?: boolean;
  /** What the wallet did with it. */
  wallet: "pending" | "signed" | "declined" | "not-asked";
  walletError?: string;
  /** RT5-2 round g: ms the wallet request was open, the raw error layers (name/code/message), and how the rejection was classified. */
  elapsedMs?: number;
  rawError?: string;
  classified?: string;
  /** NB-2 round i: how the request reached the wallet (standard + chain, legacy adapter, or why the chain was skipped) and ms since the previous request ended. */
  signer?: string;
  sinceLastMs?: number | null;
}

const origins = new Map<string, Origin>();
const log: SignLogEntry[] = [];
const listeners = new Set<() => void>();
let lastProblem: SignLogEntry | null = null;
/** When the previous wallet request ended (signed or declined): the next entry reports the gap (NB-2: "within ~60 s of the previous tx?"). */
let lastEndedAt: number | null = null;
/** Wallet requests handed to the wallet and not yet answered. */
let inFlight = 0;

/** Record where a blockhash came from. Call right after every `getLatestBlockhash` whose result is signed. */
export function noteBlockhash(
  blockhash: string, path: string, connection: GuardConnection | null = null, now: number = Date.now(),
  meta?: { commitment: string; lastValidBlockHeight: number },
): void {
  if (!isDevnetV22Enabled()) return;
  for (const [k, o] of origins) if (now - o.ts > ORIGIN_TTL_MS) origins.delete(k);
  origins.set(blockhash, { path, ts: now, connection, commitment: meta?.commitment ?? null, lastValidBlockHeight: meta?.lastValidBlockHeight ?? null });
}

const isOnCurve = (k: PublicKey): boolean => {
  try { return PublicKey.isOnCurve(k.toBytes()); } catch { return true; }
};

/**
 * NB-2: every account key (and program id) of the transaction that is in `forbidden` (base58). The app must never put an
 * address that only exists on mainnet (a market's `mainnet_ca`, its `dex_pool_address`, ...) into a devnet transaction.
 */
export function forbiddenKeysIn(tx: Pick<Transaction, "instructions">, forbidden: ReadonlySet<string>): string[] {
  const hit = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    if (forbidden.has(ix.programId.toBase58())) hit.add(ix.programId.toBase58());
    for (const k of ix.keys) if (forbidden.has(k.pubkey.toBase58())) hit.add(k.pubkey.toBase58());
  }
  return [...hit];
}

const KNOWN: Record<string, string> = {
  ComputeBudget111111111111111111111111111111: "cb",
  "11111111111111111111111111111111": "sys",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "tok",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "ata",
};

/** "cb,cb,cb,w:10": the wrapper's instructions carry their tag, so the line names what was built. */
export function txShape(tx: Pick<Transaction, "instructions">, wrapperProgramId?: string): string {
  // Instrumentation must never be the reason a signature fails: anything unexpected reads as "?".
  try {
    return (tx.instructions ?? [])
      .map((ix) => {
        const id = ix.programId.toBase58();
        if (KNOWN[id]) return KNOWN[id];
        const tag = ix.data.length > 0 ? ix.data[0] : -1;
        return `${id === wrapperProgramId ? "w" : id.slice(0, 4)}:${tag}`;
      })
      .join(",");
  } catch {
    return "?";
  }
}

export const signLog = (): readonly SignLogEntry[] => log;
export const lastSignProblem = (): SignLogEntry | null => lastProblem;
export function subscribeSignGuard(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function dismissSignProblem(): void {
  lastProblem = null;
  listeners.forEach((f) => f());
}
/** Test seam. */
export function __resetSignGuardForTest(): void {
  origins.clear();
  log.length = 0;
  lastProblem = null;
  lastEndedAt = null;
  inFlight = 0;
}

export function formatSignEntry(e: SignLogEntry): string {
  const age = e.blockhashAgeMs === null ? "unknown" : `${(e.blockhashAgeMs / 1000).toFixed(1)}s`;
  const absent = e.absentOnDevnet === null ? "accounts not checked" : e.absentOnDevnet.length === 0 ? "all accounts on devnet" : `not on devnet: ${e.absentOnDevnet.join(" ")}`;
  const pdas = e.absentPdas && e.absentPdas.length > 0 ? ` (+${e.absentPdas.length} program-derived address${e.absentPdas.length === 1 ? "" : "es"} with no account by design)` : "";
  const created = e.absentCreated && e.absentCreated.length > 0 ? ` (+${e.absentCreated.length} new account${e.absentCreated.length === 1 ? "" : "s"} this tx creates)` : "";
  return `${e.verdict} | wallet ${e.wallet} | built by ${e.path} | ${e.via} | tx ${e.shape} | blockhash ${e.blockhash.slice(0, 8)} age ${age} fetched@${e.fetchCommitment ?? "?"} lvbh ${e.lastValidBlockHeight ?? "?"} valid@handoff ${e.validAtHandoff ?? "?"} | chain ${e.chain}${e.signer ? ` | signer ${e.signer}` : ""}${e.sinceLastMs != null ? ` | ${(e.sinceLastMs / 1000).toFixed(1)}s since the previous request` : ""}${e.overlapping ? " | another wallet request from this app was still open" : ""} | ${absent}${pdas}${created} | ${e.at}${e.classified ? ` | open ${((e.elapsedMs ?? 0) / 1000).toFixed(1)}s | raw ${e.rawError} | => ${e.classified}` : ""}`;
}

function record(e: SignLogEntry): void {
  log.push(e);
  if (log.length > LOG_MAX) log.shift();
  if (typeof window !== "undefined") (window as unknown as { __v22SignLog?: SignLogEntry[] }).__v22SignLog = log;
}
function flag(e: SignLogEntry): void {
  lastProblem = e;
  console.error(`[v22 sign-guard] ${formatSignEntry(e)}`);
  listeners.forEach((f) => f());
}

export class SignGuardError extends WrongClusterError {
  constructor(public readonly entry: SignLogEntry) {
    super(); // keeps the name "WrongClusterError": the message resolver maps it by name
  }
}

/** v2.2 QA RT5-2: the line for a wallet request that ended without a signature and without the user declining. */
export { WALLET_REQUEST_CLOSED_COPY };
/**
 * A wallet popup that expired or was closed rejects with wallet-specific text (or none), which used to fall through
 * to "Something went wrong and nothing was sent.". Nothing was signed, so nothing was sent.
 */
export class WalletRequestClosedError extends Error {
  // Not a subclass of UserFacingError: this module is loaded by lib/tx.ts everywhere, and must not need
  // lib/errorMessages at class-definition time. `userFacingMessage` recognises it by name.
  constructor(cause: unknown) {
    super(WALLET_REQUEST_CLOSED_COPY);
    this.name = "WalletRequestClosedError";
    (this as { cause?: unknown }).cause = cause;
  }
}
/**
 * Create step 1 (QA 2026-10-15, Solflare 2.40.1): Solflare opens ONE confirm window at a time. A request that arrives
 * while its window is registered as open is never shown: the background focuses the existing window
 * (`showPopup` -> `focus()`), that resolves at once, and the request is refused as `{code: 4001, message: "Cancelled"}`
 * in ~0.1 s. A person declining or closing the window takes longer and reads "Transaction cancelled". Not a decline:
 * nothing was shown, and asking again changes nothing until that window is finished or closed.
 */
export { WALLET_BUSY_COPY };
export class WalletBusyError extends Error {
  // Recognised by name in lib/errorMessages (same reason as WalletRequestClosedError below).
  constructor(cause: unknown) {
    super(WALLET_BUSY_COPY);
    this.name = "WalletBusyError";
    (this as { cause?: unknown }).cause = cause;
  }
}
/** A refusal faster than this, with the bare "Cancelled" text, was never shown to the person. */
export const WALLET_BUSY_MAX_MS = 1_500;
export function isWalletBusyRejection(err: unknown, elapsedMs: number): boolean {
  if (!(elapsedMs < WALLET_BUSY_MAX_MS)) return false;
  return errorLayers(err).some((o) => o.code === 4001 && typeof o.message === "string" && o.message.trim() === "Cancelled");
}

/** A declined prompt, a locked wallet and the app's own explained errors keep their meaning; the rest is "closed". */
export function asWalletRequestError(err: unknown): unknown {
  // 4001 = declined (EIP-1193 style), 0x6985 = denied on a Ledger: the same two codes lib/privy-batch-sign.ts checks.
  // wallet-adapter keeps the wallet's own object on `.error` of its WalletError, so look through the layers.
  if (errorLayers(err).some((o) => o.code === 4001 || o.statusCode === 0x6985)) return err;
  if (typeof UserFacingError === "function" && err instanceof UserFacingError) return err;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String((err as { message?: unknown } | null)?.message ?? err);
  // Text the send loop already acts on (an expired blockhash, a rate limit) keeps its retry.
  if (detectWalletError(msg) !== null || isTransientError(msg)) return err;
  return new WalletRequestClosedError(err);
}

/**
 * v2.2 QA RT5-2 (retest 6): a wallet popup that EXPIRES is rejected by some wallets with the same text as a decline
 * (Solflare: JsonRpcError "Transaction cancelled" after ~70 s, popup shows "Transaction expired"). The text cannot
 * tell the two apart, so the time can: a decline-class rejection that arrives this long after the request was opened
 * is read as an expiry. Solflare's popup lives ~70 s; 55 s leaves margin for clock/scheduling skew while a person
 * who actively declines almost never waits that long (and if they do, "nothing was sent, try again" is still true).
 */
export const WALLET_EXPIRY_MIN_MS = 45_000;

/**
 * RT5-2 round f: Solflare's "Transaction expired" is the TRANSACTION expiring, not a fixed 70 s on the popup: the
 * blockhash was fetched before the simulation and the wait for the user, so the popup can die well under 55 s after it
 * opened. So a decline-class rejection is an expiry when ANY of: the wallet request was open >= WALLET_EXPIRY_MIN_MS; the
 * blockhash (as fetched through a tagged path) is now older than BLOCKHASH_EXPIRY_MS; or the RPC says the blockhash is no
 * longer valid. The RPC call has the guard's 4 s limit and proves nothing on failure.
 */
export const BLOCKHASH_EXPIRY_MS = 45_000;
async function expiredWhileOpen<T>(p: GuardSignParams<T>, first: SignLogEntry, openedAt: number, now: () => number, timeoutMs: number): Promise<"open-time" | "blockhash-age" | "rpc-invalid" | null> {
  const t = now();
  if (t - openedAt >= WALLET_EXPIRY_MIN_MS) return "open-time";
  if (first.blockhashAgeMs !== null && first.blockhashAgeMs + (t - openedAt) >= BLOCKHASH_EXPIRY_MS) return "blockhash-age";
  if (!first.blockhash) return null;
  const valid = await within(
    Promise.resolve().then(() => p.connection.isBlockhashValid(first.blockhash, { commitment: "confirmed" })).then((r) => r.value),
    timeoutMs,
  ).then((v) => (v === "timeout" ? null : v), () => null);
  return valid === false ? "rpc-invalid" : null;
}

/** The shapes a wallet error can take: wallet-adapter wraps the wallet's `{code,message}` object as `.error` of a WalletError. */
function errorLayers(err: unknown): Array<{ name?: unknown; code?: unknown; statusCode?: unknown; message?: unknown }> {
  const out: Array<{ name?: unknown; code?: unknown; statusCode?: unknown; message?: unknown }> = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && typeof cur === "object" && cur !== null; i++) {
    out.push(cur as never);
    const o = cur as { error?: unknown; cause?: unknown };
    cur = o.error ?? o.cause;
  }
  return out;
}
/** For the debug line: name/code/message of the outer error and its inner `.error`. */
function describeError(err: unknown): string {
  return errorLayers(err).map((o) => `${String(o.name ?? "?")}/${String(o.code ?? o.statusCode ?? "-")}/${String(o.message ?? "").slice(0, 60)}`).join(" > ") || String(err).slice(0, 80);
}

/** Decline-class rejection (not a locked wallet): the kind a Solflare expiry is reported as. */
function isDeclineClass(err: unknown): boolean {
  for (const o of errorLayers(err)) {
    if (o.code === 4001 || o.statusCode === 0x6985) return true;
    const msg = `${typeof o.name === "string" ? o.name : ""} ${typeof o.message === "string" ? o.message : ""}`;
    if (detectWalletError(msg) === "rejected") return true;
  }
  return typeof err !== "object" && detectWalletError(String(err)) === "rejected";
}

/** Explicit opt-in for the yellow "sign debug:" line: `?signdebug=1` (kept in localStorage `v22.signdebug`), `?signdebug=0` clears it. */
export const SIGN_DEBUG_KEY = "v22.signdebug";
export function isSignDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("signdebug");
    if (q === "1") window.localStorage.setItem(SIGN_DEBUG_KEY, "1");
    else if (q === "0") window.localStorage.removeItem(SIGN_DEBUG_KEY);
    return window.localStorage.getItem(SIGN_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export interface GuardSignParams<T> {
  txs: Transaction[];
  /** "adapter signTransaction", "privy signAllTransactions", … */
  via: string;
  /** The app's connection (devnet-proven by genesis hash here). */
  connection: GuardConnection;
  /** The chain the wallet is told ("none" when the wallet API takes no chain). */
  chain: string;
  wrapperProgramId?: string;
  sign: () => Promise<T>;
  /** NB-2 diagnostics: see `chainSignerNote` (lib/v22/standard-sign.ts). */
  signerNote?: string;
  now?: () => number;
  rpcTimeoutMs?: number;
}

/** A guard RPC that does not answer in this time proves nothing and never holds up a signature. */
export const GUARD_RPC_TIMEOUT_MS = 4_000;
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Accounts a System createAccount / createAccountWithSeed in this transaction creates (base58). */
export function accountsCreatedIn(tx: Pick<Transaction, "instructions">): Set<string> {
  const out = new Set<string>();
  for (const ix of tx.instructions ?? []) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;
    try {
      const kind = SystemInstruction.decodeInstructionType(ix);
      if ((kind === "Create" || kind === "CreateWithSeed") && ix.keys[1]) out.add(ix.keys[1].pubkey.toBase58());
    } catch {
      // not a System instruction this can decode: nothing created
    }
  }
  return out;
}

/** Every account key of the transaction that the devnet connection does not have. null = could not check. */
async function absentAccounts(tx: Transaction, connection: GuardConnection, timeoutMs: number): Promise<{ suspect: string[]; pdas: string[]; created: string[] } | null> {
  try {
    if (typeof connection.getMultipleAccountsInfo !== "function") return null;
    const writable = new Map<string, boolean>();
    const keys = new Map<string, import("@solana/web3.js").PublicKey>();
    for (const ix of tx.instructions ?? []) {
      for (const k of ix.keys) {
        const id = k.pubkey.toBase58();
        keys.set(id, k.pubkey);
        writable.set(id, (writable.get(id) ?? false) || k.isWritable);
      }
    }
    const list = [...keys.values()];
    if (list.length === 0) return { suspect: [], pdas: [], created: [] };
    const infos = await within(connection.getMultipleAccountsInfo(list), timeoutMs);
    if (infos === "timeout") return null;
    const created = accountsCreatedIn(tx);
    const absent = list.filter((_, n) => infos[n] === null);
    const isCreated = (k: PublicKey) => created.has(k.toBase58());
    const label = (k: PublicKey) => `${writable.get(k.toBase58()) ? "w" : "r"}:${k.toBase58()}`;
    return {
      suspect: absent.filter((k) => !isCreated(k) && isOnCurve(k)).map(label),
      pdas: absent.filter((k) => !isCreated(k) && !isOnCurve(k)).map(label),
      created: absent.filter(isCreated).map(label),
    };
  } catch {
    return null;
  }
}

/** Assert, log, then let the wallet sign. See the file header. */
export async function guardSign<T>(p: GuardSignParams<T>): Promise<T> {
  if (!isDevnetV22Enabled()) return p.sign();
  const now = p.now ?? Date.now;
  const timeoutMs = p.rpcTimeoutMs ?? GUARD_RPC_TIMEOUT_MS;
  const entries: SignLogEntry[] = [];
  let refused: SignLogEntry | null = null;
  for (let i = 0; i < p.txs.length; i++) {
    const tx = p.txs[i];
    const blockhash = tx.recentBlockhash ?? "";
    const origin = origins.get(blockhash) ?? null;
    const e: SignLogEntry = {
      at: new Date(now()).toISOString(),
      via: p.txs.length > 1 ? `${p.via}[${i + 1}/${p.txs.length}]` : p.via,
      path: origin?.path ?? "UNTAGGED (blockhash not fetched through a tagged path)",
      blockhash,
      blockhashAgeMs: origin ? now() - origin.ts : null,
      fetchCommitment: origin?.commitment ?? null,
      lastValidBlockHeight: origin?.lastValidBlockHeight ?? null,
      validAtHandoff: null,
      shape: txShape(tx, p.wrapperProgramId),
      chain: p.chain,
      verdict: "ok",
      absentOnDevnet: null,
      wallet: "pending",
      ...(p.signerNote ? { signer: p.signerNote } : {}),
      sinceLastMs: lastEndedAt === null ? null : Math.max(0, now() - lastEndedAt),
    };
    const [absent, valid] = await Promise.all([
      absentAccounts(tx, p.connection, timeoutMs),
      blockhash
        ? within(Promise.resolve().then(() => p.connection.isBlockhashValid(blockhash, { commitment: "confirmed" })).then((r) => r.value), timeoutMs).then((v) => (v === "timeout" ? null : v), () => null)
        : Promise.resolve(null),
    ]);
    e.absentOnDevnet = absent === null ? null : absent.suspect;
    if (absent && absent.pdas.length > 0) e.absentPdas = absent.pdas;
    if (absent && absent.created.length > 0) e.absentCreated = absent.created;
    e.validAtHandoff = valid;
    try {
      await within(assertDevnetConnection(origin?.connection ?? p.connection), timeoutMs);
      if (origin?.connection && origin.connection !== p.connection) await within(assertDevnetConnection(p.connection), timeoutMs);
    } catch {
      e.verdict = "REFUSED-wrong-cluster";
    }
    if (e.verdict === "ok" && !origin) {
      // Not fetched through a tagged path: prove it on the devnet connection. An RPC failure proves nothing.
      const known = await within(
        Promise.resolve().then(() => p.connection.isBlockhashValid(blockhash, { commitment: "processed" })).then((r) => r.value),
        timeoutMs,
      ).then((v) => (v === "timeout" ? null : v), () => null);
      e.verdict = known === false ? "REFUSED-blockhash-not-on-devnet" : "untagged-blockhash";
    } else if (e.verdict === "ok" && ((e.blockhashAgeMs !== null && e.blockhashAgeMs > STALE_BLOCKHASH_MS) || e.validAtHandoff === false)) {
      e.verdict = "stale-blockhash";
    }
    if (e.verdict.startsWith("REFUSED")) {
      e.wallet = "not-asked";
      refused ??= e;
    }
    entries.push(e);
  }
  if (refused) {
    for (const e of entries) {
      if (e.wallet === "pending") e.wallet = "not-asked";
      record(e);
    }
    flag(refused);
    throw new SignGuardError(refused);
  }
  for (const e of entries) {
    record(e);
    console.info(`[v22 sign] ${formatSignEntry(e)}`);
    if (e.verdict !== "ok") flag(e);
  }
  const openedAt = now();
  if (inFlight > 0) for (const e of entries) e.overlapping = true;
  inFlight += 1;
  try {
    const out = await p.sign();
    for (const e of entries) e.wallet = "signed";
    lastEndedAt = now();
    return out;
  } catch (err) {
    lastEndedAt = now();
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    for (const e of entries) {
      e.wallet = "declined";
      e.walletError = msg.slice(0, 160);
    }
    const elapsed = now() - openedAt;
    const busy = isWalletBusyRejection(err, elapsed);
    const decline = !busy && isDeclineClass(err);
    const branch = decline ? await expiredWhileOpen(p, entries[0], openedAt, now, timeoutMs) : null;
    const thrown = busy ? new WalletBusyError(err) : branch ? new WalletRequestClosedError(err) : asWalletRequestError(err);
    const classified = busy
      ? "wallet busy (refused unshown: one of its own request windows is already open)"
      : branch ? `timeout copy (expired: ${branch})` : decline ? "cancelled (decline-class, not expired)" : thrown instanceof WalletRequestClosedError ? "timeout copy (non-decline wallet error)" : "passed through unchanged";
    for (const e of entries) { e.elapsedMs = elapsed; e.rawError = describeError(err); e.classified = classified; }
    // A declined request is how a wallet-side "Network mismatch" reaches us: show which path built that transaction.
    flag(entries[0]);
    throw thrown;
  } finally {
    inFlight -= 1;
  }
}
