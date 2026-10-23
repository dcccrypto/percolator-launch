import { Connection, Transaction, type Commitment, type Signer } from "@solana/web3.js";
import { getNetwork, getRpcEndpoint } from "./config";
import { buildUpstreams, redactJson, sharedUpstreamPool, UpstreamRateLimitedError, type RpcNetwork, type UpstreamSpec } from "./rpc-upstreams";

/** The JSON-RPC code and calm text for "every upstream is rate-limiting us" (matched by lib/limits/user-message.ts as network-busy). */
export const RATE_LIMITED_RPC_ERROR = Object.freeze({ code: -32429, message: "Too many requests: the RPC is rate limited. Try again shortly." });

/** An HTTP 429 carrying a JSON-RPC rate-limit error per request item (batch-shaped when the request was a batch). */
export function rateLimitedResponse(body: unknown): Response {
  const item = (x: unknown) => ({ jsonrpc: "2.0", id: (x as { id?: unknown } | null)?.id ?? null, error: { ...RATE_LIMITED_RPC_ERROR } });
  const json = Array.isArray(body) ? body.map(item) : item(body);
  return new Response(JSON.stringify(json), { status: 429, headers: { "content-type": "application/json" } });
}

/**
 * Server-side Solana Connection for API routes.
 *
 * ROOT CAUSE this fixes: server routes used `new Connection(getRpcEndpoint())`,
 * which builds the URL from `HELIUS_DEVNET_API_KEY`. That key is exhausted
 * (HTTP 429 "max usage reached"), so every server-side devnet RPC read failed —
 * surfacing to users as "Could not verify mint authority due to RPC error"
 * (faucet) and "Keeper co-sign failed (500): Failed to build co-sign tx"
 * (market-create step 2).
 *
 * The working devnet endpoint is `DEVNET_RPC_URL` — the SAME full-URL override
 * the `/api/rpc` proxy uses (route.ts). It is Origin-restricted: it returns 401
 * "Unauthorized" without the `Origin: <RPC_UPSTREAM_ORIGIN>` header
 * (default `https://trade.padre.gg`). A raw `new Connection(url)` never sends
 * that header. This helper adds it — harmless for public/unrestricted endpoints —
 * and prefers the full-URL override, mirroring `/api/rpc` exactly, then falls
 * back to `getRpcEndpoint()` / public devnet.
 *
 * SERVER-ONLY: reads `process.env.DEVNET_RPC_URL` / `RPC_UPSTREAM_ORIGIN`, which
 * are undefined in the browser. Client code must keep using the `/api/rpc` proxy.
 */
/**
 * The `fetch` handed to web3.js when fallbacks exist: it ignores the URL web3.js built (the pool picks the upstream), returns the answering
 * upstream's real status, honours the caller's abort signal, and throws one generic error when nothing could answer.
 */
export function makeRotatingFetch(upstreams: readonly UpstreamSpec[], cluster: RpcNetwork): typeof fetch {
  return async (_input, init) => {
    // web3.js sends the JSON-RPC body as a string. Anything else is not ours to rotate.
    if (typeof init?.body !== "string") throw new Error("RPC request unavailable");
    const body = JSON.parse(init.body) as unknown;
    let r;
    try {
      r = await sharedUpstreamPool().postRaw(upstreams, body, cluster, init.signal ? { signal: init.signal } : {});
    } catch (e) {
      // AUD-RAPP #3563: every upstream refused for rate. Answer as an HTTP 429 (no upstream detail), so web3.js applies its own back-off
      // or, with `disableRetryOnRateLimit`, fails fast as asked, and callers see a rate limit rather than a generic failure.
      if (e instanceof UpstreamRateLimitedError) return rateLimitedResponse(body);
      throw e;
    }
    return new Response(JSON.stringify(redactJson(r.json, upstreams)), { status: r.status, headers: { "content-type": "application/json" } });
  };
}

export function getServerConnection(
  commitment: Commitment = "confirmed",
  opts: { disableRetryOnRateLimit?: boolean } = {},
): Connection {
  const net = getNetwork();
  const override = (
    net === "mainnet" ? process.env.MAINNET_RPC_URL : process.env.DEVNET_RPC_URL
  )?.trim();
  const url = override && /^https?:\/\//.test(override) ? override : getRpcEndpoint();
  const origin =
    (process.env.RPC_UPSTREAM_ORIGIN ?? "").trim() ||
    (net === "devnet" ? "https://trade.padre.gg" : "");
  // Ordered fallback (lib/rpc-upstreams.ts): when the primary is dead (quota, 429, 5xx, network) the next upstream answers. Only when a
  // fallback is configured (devnet: the public RPC unless DEVNET_RPC_FALLBACK_URLS says otherwise); otherwise the plain Connection.
  const cluster = net === "mainnet" ? "mainnet" : "devnet";
  const upstreams = buildUpstreams(cluster, { url, headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) } });
  const rotating = upstreams.length > 1 ? makeRotatingFetch(upstreams, cluster) : undefined;
  return new Connection(url, {
    commitment,
    ...(rotating ? { fetch: rotating } : {}),
    // Opt-in per call (default unchanged): web3.js otherwise retries HTTP 429 with backoff, which a
    // latency-sensitive probe must not do.
    ...(opts.disableRetryOnRateLimit ? { disableRetryOnRateLimit: true } : {}),
    ...(origin ? { httpHeaders: { Origin: origin } } : {}),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isBlockhashMiss(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes("blockhashnotfound") || m.includes("blockhash not found");
}


/**
 * Raised when an already-broadcast transaction is known to have failed
 * on-chain. This is a definite failure: callers may safely release any claim
 * reservation associated with the transaction.
 */
export class ServerSignatureExecutionError extends Error {
  readonly signature: string;
  readonly transactionError: unknown;

  constructor(signature: string, transactionError: unknown) {
    super(`Transaction failed: ${JSON.stringify(transactionError)}`);
    this.name = "ServerSignatureExecutionError";
    this.signature = signature;
    this.transactionError = transactionError;
  }
}

/**
 * Raised when an already-broadcast transaction still has no definitive status
 * after bounded polling plus the final history-aware re-check.
 *
 * This is an UNKNOWN outcome, not proof that the transaction failed. Callers
 * must not release a mint/claim reservation in response to this error.
 */
export class ServerSignatureTimeoutError extends Error {
  readonly signature: string;
  readonly timeoutMs: number;

  constructor(signature: string, timeoutMs: number) {
    super(`Transaction ${signature} not confirmed within ${timeoutMs}ms`);
    this.name = "ServerSignatureTimeoutError";
    this.signature = signature;
    this.timeoutMs = timeoutMs;
  }
}

const STATUS_REQUEST_TIMEOUT_MS = 5_000;
const FINAL_STATUS_TIMEOUT_MS = 2_000;

/**
 * Bound a single signature-status RPC request. Solana web3.js does not provide
 * a request timeout for getSignatureStatus(), so a stalled upstream must not
 * be allowed to hold the route open indefinitely.
 */
async function getSignatureStatusWithTimeout(
  connection: Connection,
  sig: string,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection.getSignatureStatus(sig, {
        searchTransactionHistory: true,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Confirm an already-broadcast server transaction by polling its signature.
 *
 * Unlike blockheight-bound confirmTransaction(), this resolves the original
 * signature independently of the blockhash lifetime. On a load-balanced RPC,
 * a landed transaction can be slow to become visible to the node handling
 * confirmation.
 *
 * This helper never re-sends the transaction.
 */
export async function confirmServerSignature(
  connection: Connection,
  sig: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(1500);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let status;
    try {
      const response = await getSignatureStatusWithTimeout(
        connection,
        sig,
        Math.min(STATUS_REQUEST_TIMEOUT_MS, remainingMs),
      );
      if (!response) continue;
      status = response.value;
    } catch {
      continue;
    }

    if (!status) continue;
    if (status.err) {
      throw new ServerSignatureExecutionError(sig, status.err);
    }
    if (
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
    ) {
      return sig;
    }
  }

  // Final history-aware re-check. It has its own short timeout so the check
  // cannot leave the route pending indefinitely after the main deadline.
  const finalStatus = await getSignatureStatusWithTimeout(
    connection,
    sig,
    FINAL_STATUS_TIMEOUT_MS,
  ).catch(() => null);

  const status = finalStatus?.value ?? null;

  if (status?.err) {
    throw new ServerSignatureExecutionError(sig, status.err);
  }

  if (
    status &&
    (status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized")
  ) {
    return sig;
  }

  throw new ServerSignatureTimeoutError(sig, timeoutMs);
}

/**
 * Robust server-side send+confirm for a legacy Transaction on a load-balanced
 * devnet RPC (the padre endpoint). Web3.js `sendAndConfirmTransaction` throws
 * "BlockhashNotFound" (a node behind the LB hasn't propagated the just-fetched
 * blockhash) and "block height exceeded" (slow confirm) even when the tx lands —
 * which surfaced to users as a 500 "Internal server error" on the create-market
 * pre-fund / sim-USDC-claim step.
 *
 * Mitigations: (1) fetch a FINALIZED blockhash (seen by every LB node) so the
 * send/preflight can't miss it; (2) `skipPreflight` by default — these are
 * server-signed, trusted txs, and the send-node preflight is the main
 * BlockhashNotFound source; (3) confirm by POLLING the signature status (not
 * blockhash-tied `confirmTransaction`), so a slow-but-landed tx is reported as
 * success instead of a false failure; (4) retry ONLY on a pre-wire send-time
 * blockhash miss — never re-send after the tx is on the wire, to avoid a
 * double-mint. Throws only when the tx genuinely did not confirm.
 */
export async function sendAndConfirmServerTx(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  opts: { maxSendAttempts?: number; timeoutMs?: number; skipPreflight?: boolean } = {},
): Promise<string> {
  const maxSendAttempts = opts.maxSendAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const skipPreflight = opts.skipPreflight ?? true;

  let sig: string | undefined;
  for (let attempt = 0; attempt < maxSendAttempts && !sig; attempt++) {
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = tx.feePayer ?? signers[0].publicKey;
    tx.signatures = [];
    tx.sign(...signers);
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 5 });
    } catch (e) {
      if (isBlockhashMiss(e) && attempt < maxSendAttempts - 1) {
        await sleep(1200);
        continue;
      }
      throw e;
    }
  }
  if (!sig) throw new Error("sendAndConfirmServerTx: transaction was never broadcast");

  return confirmServerSignature(connection, sig, { timeoutMs });
}
