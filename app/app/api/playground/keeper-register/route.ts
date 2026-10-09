/**
 * POST /api/playground/keeper-register
 *
 * Register a newly-created playground market so the oracle keeper starts pricing it.
 *
 * The keeper (dcccrypto/percolator-oracle-keeper feat/cross-cluster-keeper) runs on a
 * NAT'd Mac mini — it can only make OUTBOUND calls, so this Vercel app can't POST to it
 * directly. Instead this route persists the registration to a Vercel Blob JSON store
 * (see lib/playground-registered-markets.ts); the keeper polls
 * GET /api/playground/registered-markets outbound on its own interval and adds any
 * market it doesn't already know about. v17 has no on-chain feed_id, so this payload
 * is the only place the market↔pool binding is recorded.
 *
 * This route:
 *   1. AUTHENTICATES the caller — see "Authentication (H1)" below. Previously this
 *      route was unauthenticated (only a devnet env gate), so anyone could inject
 *      or repoint any market's pricing pool.
 *   2. Validates the request (devnet-only, pubkey shapes).
 *   3. Resolves the dexType AUTHORITATIVELY by classifying the pool account's
 *      mainnet owner program (CLMM/DLMM/PumpSwap program ids) — the client
 *      string is only a fallback when mainnet RPC is unreachable. This also
 *      verifies the pool actually exists on mainnet before the keeper is
 *      pointed at it.
 *   4. Upserts { slabAddress, marketAddress, poolAddress, dexType, symbol, label,
 *      mainnetCA, collateral, registeredAt } into the blob, keyed by slabAddress.
 *      The registry is capped at MAX_REGISTERED_MARKETS entries (oldest evicted
 *      first) — see lib/playground-registered-markets.ts.
 *   5. Returns { ok: true, registered: true, ... } on success, or a 502 with a clear
 *      message if the Blob write fails (never throws uncaught — market creation
 *      itself already landed on-chain regardless of this route's outcome).
 *
 * Authentication (UX WP-7, 2026-09-30; security review FIX-FIRST applied the same day,
 * re-review required before merge): two paths —
 *   a) Creation-transaction proof: `proofTx` is the signature of the market's M1 transaction.
 *      That transaction carries ONE SPL Memo `percolator:keeper-register:v2:<sha256(canonical
 *      params)>` signed by the creator (lib/keeper-register-memo.ts). The route accepts only if
 *      the tx succeeded, it has exactly one registration memo and that memo matches THIS request
 *      exactly (slab, pool, CA, dex type, symbol, label AND a digest of the full markets-row
 *      payload), and the same tx contains the WRAPPER's InitMarket for this slab whose admin is
 *      the memo's signer. The slab must be a wrapper-owned v18 market account.
 *      The proof is public (a landed tx), so ANYONE can replay it, but only to submit the exact
 *      registration the creator signed, and what it may write is limited: it never overwrites a
 *      creator-registered row, never re-activates a retired one, and never changes a row's pool
 *      or CA (lib/market-registration.ts, mode "proof"). This REPLACES the H1v2 signed-message
 *      proof; there is no other user path (the P3 junior-owner path was removed, review M-2).
 *   b) Admin bypass: header `x-admin-secret` matching ADMIN_API_SECRET (maintainer fixes; the
 *      only path that may change or re-activate an existing row).
 *
 * Enrollment guard (review M-7, lib/keeper-enrollment-guard.ts), proof path only: the market must
 * be FINISHED (marketauth rotated to the stake-pool PDA, insurance and LP collateral in, asset 0
 * AUTH_MARK with our keeper as oracle authority; else 409 / 403), and a new enrollment is refused
 * once the creator (KEEPER_MAX_ACTIVE_PER_CREATOR, default 10) or the deployment
 * (KEEPER_MAX_ACTIVE_MARKETS, default 50) is at its ceiling. Every enrolled market costs the
 * keeper SOL on every push.
 *
 * Body: {
 *   slabAddress:    string  — devnet market account
 *   mainnetCA:      string  — mainnet token CA (for keeper labelling)
 *   dexPoolAddress: string  — mainnet DEX pool address
 *   dexType:        string  — hint; DexScreener dexIds accepted ("meteora",
 *                             "raydium", …) — see lib/dex-type.ts
 *   symbol?:        string  — token symbol (e.g. "SOL")
 *   label?:         string  — human label (e.g. "SOL/USDC — Raydium CLMM")
 *   proofTx?:       string  — required unless using the admin bypass: the market's
 *                             creation-tx signature (base58, 64 bytes; see Authentication)
 *   payload?:       object  — the markets-row fields (bound by the memo's payload digest)
 * }
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN — read automatically by the @vercel/blob SDK (Vercel-managed).
 *   ADMIN_API_SECRET      — optional; enables the admin-bypass auth path (H1b).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAdminSecret } from "@/lib/admin-secret";
import {
  isKeeperDexTypeOrEmpty,
  isTxSignature,
  keeperMemoParams,
  validateRegistrationPayload,
  verifyKeeperRegisterProofTx,
} from "@/lib/keeper-register-memo";
import { UNSUPPORTED_POOL_COPY } from "@/lib/wizard-copy";
import { NON_USD_QUOTE_REASON } from "@/lib/dex-constants";
import { belowLiquidityFloorReason } from "@/lib/pool-liquidity";
import { isV18MarketHeader } from "@/lib/limits/decode";
import { PublicKey } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import type { RegisteredMarket } from "@/lib/playground-registered-markets";
import { upsertRegisteredMarket } from "@/lib/playground-registered-markets";
import { KEEPER_DEX_TYPES, type KeeperDexType } from "@/lib/dex-type";
import { classifyPoolsByOwner, type PoolClass } from "@/lib/dex-pool-owner";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { resolveTokenLogo } from "@/lib/token-logo";
import { sanitizeLogoUrl } from "@/lib/token-metadata-validators";
import { upsertRegisteredMarketRow } from "@/lib/market-registration";
import { checkSymbol, checkName } from "@/lib/market-metadata-validation";
import { checkKeeperReadiness, enrollmentCapsFromEnv, GLOBAL_CAP_COPY, readinessStatus } from "@/lib/keeper-enrollment-guard";
import { getPlaygroundKeeperSigner } from "@/lib/playground-keeper-signer";
import { getClientIp } from "@/lib/get-client-ip";
import { checkKeeperRegisterRateLimit } from "@/lib/keeper-register-rate-limit";

export const dynamic = "force-dynamic";

/**
 * In-request grace for "the creation tx / the finished market is not visible to this RPC node yet":
 * `tries` extra reads, `delayMs` apart (default 3 x 800 ms, well inside the function budget). The
 * client launches the registration the moment its last transaction confirms, often against a
 * different RPC node than the one this route reads, so the first read can be a slot or two behind.
 */
function proofWaitFromEnv(): { tries: number; delayMs: number } {
  const n = (v: string | undefined, d: number): number => {
    const x = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : d;
  };
  return { tries: Math.min(n(process.env.KEEPER_REGISTER_PROOF_TRIES, 3), 6), delayMs: Math.min(n(process.env.KEEPER_REGISTER_PROOF_POLL_MS, 800), 2_000) };
}

/** Timing-safe admin-bypass check (H1b) — same secret/header convention as
 *  /api/oracle/set-price-cap. Empty/unset ADMIN_API_SECRET always denies. */
function isAdminBypass(req: NextRequest): boolean {
  return checkAdminSecret(req, "register");
}

async function classifyPoolByOwner(
  poolAddress: string,
): Promise<PoolClass | "rpc-failed"> {
  const r = await classifyPoolsByOwner([poolAddress]);
  if (!r) return "rpc-failed";
  return r[poolAddress] ?? "missing";
}

const NETWORK = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();

// Alias-tolerant: the wizard passes DexScreener dexIds ("meteora", "raydium")
// which normalizeDexType maps into the keeper vocabulary. Rejecting raw ids
// here silently orphaned every Meteora/Raydium-pool market (no keeper price,
// no name, invisible on /markets) because the wizard treats registration
// failures as non-fatal.

/** sim-USDC — the single collateral mint shared by every playground market. */
const PLAYGROUND_COLLATERAL_MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

export async function POST(req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { slabAddress, mainnetCA, dexPoolAddress, dexType, symbol, label, proofTx, deployer, payload } = body as {
    slabAddress?: string;
    mainnetCA?: string;
    dexPoolAddress?: string;
    dexType?: string;
    symbol?: string;
    label?: string;
    proofTx?: string;
    /** Admin bypass only: the market's deployer to record (maintainer re-registration). Not auth. */
    deployer?: string;
    /** Full markets-row payload from the wizard's buildMarketRegistrationPayload.
     *  Absent on the retry path, which re-registers an already-listed market. */
    payload?: Record<string, unknown> | null;
  };

  if (!slabAddress) return NextResponse.json({ error: "slabAddress required" }, { status: 400 });
  if (!dexPoolAddress) return NextResponse.json({ error: "dexPoolAddress required" }, { status: 400 });

  // Validate addresses
  try { new PublicKey(slabAddress); } catch {
    return NextResponse.json({ error: "Invalid slabAddress" }, { status: 400 });
  }
  try { new PublicKey(dexPoolAddress); } catch {
    return NextResponse.json({ error: "Invalid dexPoolAddress" }, { status: 400 });
  }
  if (mainnetCA) {
    try { new PublicKey(mainnetCA); } catch {
      return NextResponse.json({ error: "Invalid mainnetCA" }, { status: 400 });
    }
  }

  // SEC: validate all caller-supplied metadata BEFORE it can reach the markets
  // DB row (upsertRegisteredMarketRow) or the Blob registry
  // (upsertRegisteredMarket). `symbol`/`label` (body) and `payload.symbol`/
  // `payload.name` are attacker-controllable and are rendered as the market's
  // identity across the UI; without this, deceptive names (homoglyph / RTL /
  // zero-width), control characters, or overlong values could impersonate a
  // real market. This mirrors the guards the removed POST /api/markets path
  // enforced (see lib/market-metadata-validation). Server-derived fallbacks
  // ("UNKNOWN", the derived label, `Market <slab>`) are safe and unvalidated;
  // the retry path sends nulls here and is unaffected.
  {
    const payloadMeta = (payload ?? {}) as Record<string, unknown>;
    const metaFields: Array<[unknown, "symbol" | "name"]> = [
      [symbol, "symbol"],
      [payloadMeta.symbol, "symbol"],
      [label, "name"],
      [payloadMeta.name, "name"],
    ];
    for (const [raw, kind] of metaFields) {
      if (typeof raw === "string" && raw.length > 0) {
        const res = kind === "symbol" ? checkSymbol(raw) : checkName(raw);
        if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      }
    }
  }

  // Review Info I-1: only the keeper's own dex vocabulary is hashed / recorded.
  if (!isKeeperDexTypeOrEmpty(dexType)) {
    return NextResponse.json({ error: "Invalid dexType" }, { status: 400 });
  }
  // Review M-1: every payload field the row takes is shape-checked (and, on the proof path,
  // bound by the memo's payload digest below).
  const payloadCheck = validateRegistrationPayload(payload ?? null);
  if (!payloadCheck.ok) return NextResponse.json({ error: payloadCheck.error }, { status: 400 });
  const boundPayload = payloadCheck.payload;

  // H1: authenticate the caller before any mainnet RPC, third-party lookup or registry write.
  // The market's creator, proven by the creation tx (the proof path only).
  let slabAdmin: string | null = null;
  const admin = isAdminBypass(req);

  if (!admin) {
    // UX WP-7 (SECURITY REVIEW REQUIRED before merge): the creator proves the registration with
    // the transaction that CREATED the market. Its M1 carries an SPL Memo, signed by the creator,
    // binding exactly these parameters (lib/keeper-register-memo.ts). This REPLACES the H1v2
    // signed-message proof (no signMessage prompt, no replay window, no parallel user auth path;
    // the admin bypass above stays the maintainer path).
    if (proofTx === undefined || proofTx === null || proofTx === "") {
      return NextResponse.json({ error: "Missing required field: proofTx (the market-creation transaction signature)" }, { status: 400 });
    }
    // Review L-2: a malformed signature never costs an RPC call.
    if (!isTxSignature(proofTx)) {
      return NextResponse.json({ error: "Invalid proofTx: expected a transaction signature" }, { status: 400 });
    }
    // Per-IP bound: each proof-path request costs several RPC reads, and the route is reachable by
    // anyone holding a public creation tx. A launch's own loop needs about 15 requests in its first
    // minute, so the ceiling leaves room for several markets behind one NAT.
    const rl = await checkKeeperRegisterRateLimit(getClientIp(req));
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Try again in a moment." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      );
    }
    try {
      const wrapper = getConfig().programId as string;
      const connection = getServerConnection("confirmed");
      const memoParams = await keeperMemoParams({ slabAddress, dexPoolAddress, mainnetCA, dexType, symbol, label, payload: boundPayload });

      // The slab is read and its owner / header checked ONCE. Only the checks that can be RPC lag
      // are repeated below, and each repeats only its own read: the proof stage re-runs getTransaction,
      // the readiness stage re-reads the slab bytes. A caller with a real public slab and a made-up
      // signature costs one slab read plus the bounded getTransaction retries, not full passes.
      const accountInfo = await connection.getAccountInfo(new PublicKey(slabAddress));
      if (!accountInfo) {
        return NextResponse.json({ error: "Slab account does not exist on-chain" }, { status: 400 });
      }
      // Review L-1: the slab must be a market account of THIS wrapper (owner + v18 market header).
      if (accountInfo.owner.toBase58() !== wrapper || !isV18MarketHeader(new Uint8Array(accountInfo.data))) {
        return NextResponse.json({ error: "Slab account is not a market of this deployment's program" }, { status: 400 });
      }
      const { tries, delayMs } = proofWaitFromEnv();
      const pause = () => new Promise((r) => setTimeout(r, delayMs));

      /** Stage 1. `transient` = "proof transaction not found": this RPC node has not seen it yet. */
      const proofPass = async (): Promise<{ response: NextResponse; transient: boolean; log?: () => void } | null> => {
        const tx = await connection.getTransaction(proofTx, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
        const verdict = await verifyKeeperRegisterProofTx(tx, memoParams, wrapper);
        if (!verdict.ok) {
          // Not landed yet reads as "not found": retried here, then by the client with backoff.
          const notFound = verdict.reason === "proof transaction not found";
          const reason = verdict.reason;
          return {
            log: () =>
              Sentry.captureMessage("[playground/keeper-register] creation-tx proof refused", {
                level: "warning",
                tags: { endpoint: "/api/playground/keeper-register", auth: "memo-fail" },
                extra: { slabAddress, reason },
              }),
            response: NextResponse.json({ error: `Registration proof refused: ${verdict.reason}` }, { status: notFound ? 409 : 403 }),
            transient: notFound,
          };
        }
        slabAdmin = verdict.creator;
        return null;
      };
      let proofOutcome = await proofPass();
      for (let i = 0; proofOutcome?.transient && i < tries; i++) {
        await pause();
        proofOutcome = await proofPass();
      }
      if (proofOutcome) {
        proofOutcome.log?.();
        return proofOutcome.response;
      }

      // Review M-7: only a FINISHED market priced by our keeper is enrolled. The launch registers
      // after its last step lands, so a not-yet-finished market is "try again" (409), never a final
      // refusal; the 409 family can be RPC lag, so the slab is re-read a few times before answering.
      let slabBytes = new Uint8Array(accountInfo.data);
      let readiness = checkKeeperReadiness(
        slabBytes,
        new PublicKey(slabAddress),
        (getConfig() as { vaultProgramId?: string }).vaultProgramId,
        getPlaygroundKeeperSigner()?.publicKey(),
      );
      for (let i = 0; !readiness.ok && readinessStatus(readiness.reason) === 409 && i < tries; i++) {
        await pause();
        const again = await connection.getAccountInfo(new PublicKey(slabAddress));
        if (!again) break;
        slabBytes = new Uint8Array(again.data);
        readiness = checkKeeperReadiness(
          slabBytes,
          new PublicKey(slabAddress),
          (getConfig() as { vaultProgramId?: string }).vaultProgramId,
          getPlaygroundKeeperSigner()?.publicKey(),
        );
      }
      if (!readiness.ok) {
        Sentry.captureMessage("[playground/keeper-register] market not ready for the keeper", {
          level: "warning",
          tags: { endpoint: "/api/playground/keeper-register", auth: "not-ready" },
          extra: { slabAddress, reason: readiness.reason },
        });
        return NextResponse.json(
          { error: `Market is not ready for the live price: ${readiness.reason}` },
          { status: readinessStatus(readiness.reason) },
        );
      }
    } catch (err) {
      console.error("[playground/keeper-register] proof check failed:", err instanceof Error ? err.message : String(err));
      return NextResponse.json({ error: "Failed to verify the market-creation proof on-chain" }, { status: 503 });
    }
  }

  // Kick the logo lookup off only AFTER auth (review L-2: a refused request never reaches a
  // third party), overlapping the pool classification below. Not awaited here; see the bounded
  // await at the write.
  const logoPromise: Promise<string | null> = mainnetCA
    ? resolveTokenLogo(mainnetCA).catch(() => null)
    : Promise.resolve(null);

  // Resolve the dexType from the pool's mainnet owner program ONLY. The client
  // dexType string is a hint and is ignored: it cannot tell Meteora DLMM from
  // DAMM (E2E B21). An unreachable RPC is a retryable 503, never a guess.
  const classified = await classifyPoolByOwner(dexPoolAddress);
  if (classified === "missing") {
    return NextResponse.json(
      { error: `dexPoolAddress ${dexPoolAddress} does not exist on mainnet` },
      { status: 400 },
    );
  }
  if (classified === "unsupported") {
    return NextResponse.json(
      {
        error: UNSUPPORTED_POOL_COPY,
      },
      { status: 400 },
    );
  }
  if (classified === "non-usd-quote") {
    // The pool is quoted in a token the keeper cannot turn into USD (2026-10-02: SI quoted in
    // MM was priced ~450x too high). Refused here, server-side, so a hand-built POST cannot
    // bypass the wizard's pool picker. Checked from the same account bytes as the owner.
    return NextResponse.json({ error: NON_USD_QUOTE_REASON }, { status: 400 });
  }
  if (classified === "below-liquidity-floor") {
    // The keeper refuses to price a pool under its liquidity floor (2026-10-02: BOME on
    // GmoZsr3G..., depth $1.64), so a market registered on it could never be priced. Refused
    // before any write; a hand-built POST cannot bypass the wizard.
    return NextResponse.json({ error: belowLiquidityFloorReason() }, { status: 400 });
  }
  if (classified === "rpc-failed") {
    // E2E B21: never register a pool whose owner we could not verify. The
    // DexScreener string cannot tell DLMM from DAMM ("meteora" for both), and a
    // wrongly-typed pool leaves the market with no price. Retryable.
    return NextResponse.json(
      { error: "Could not verify the pool on mainnet right now. Try again in a moment." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  const normalizedDexType: KeeperDexType = classified;

  // Raydium CLMM is withheld from new markets. THIS is the real gate: the
  // client-side filter (SUPPORTED_DEX_IDS / BLOCKED_DEX_IDS) only shapes the
  // wizard's pool list and can be bypassed by POSTing here directly, whereas
  // `normalizedDexType` above is derived from the pool's on-chain owner
  // program and cannot be spoofed.
  //
  // Why: the keeper cannot yet publish a correct USD price for a Raydium CLMM
  // pool paired against SOL. Raydium orders its mints by PUBKEY and prices
  // "mint1 per mint0", so WSOL lands on either side depending on the other
  // token's address — one side needs a multiply by SOL/USD, the other an
  // invert. Registering such a market publishes a price that is ~80x wrong
  // half the time, which does not just mis-draw the chart: it permanently
  // mis-sizes the LP trade caps written once at market creation (the
  // 2026-07-29 Meteora/WSOL incident had exactly this shape). Lift this once
  // price-reader.ts handles both orientations.
  if (normalizedDexType === "raydium-clmm") {
    return NextResponse.json(
      {
        error:
          "Raydium pools are not supported for new markets yet — the price feed cannot " +
          "yet publish a reliable USD price for Raydium pools paired against SOL. " +
          "Launch against a Pump.fun or Meteora pool instead.",
      },
      { status: 400 },
    );
  }

  const resolvedLabel = label ?? (symbol ? `${symbol}/USDC — ${normalizedDexType}` : `${slabAddress.slice(0, 8)}… — ${normalizedDexType}`);

  const entry: RegisteredMarket = {
    slabAddress,
    marketAddress: slabAddress,
    poolAddress: dexPoolAddress,
    dexType: normalizedDexType,
    symbol: symbol ?? null,
    label: resolvedLabel,
    mainnetCA: mainnetCA ?? null,
    collateral: PLAYGROUND_COLLATERAL_MINT,
    registeredAt: Date.now(),
  };

  // ── The registration write (markets row) ─────────────────────────────────
  // This is the store that matters: the keeper reads keeper_status='active'
  // from here. The blob write below is retained only until the keeper cutover
  // is proven, then removed (rollout step 4). Runs FIRST so a DB failure fails
  // the registration outright rather than leaving the blob ahead of the row.
  //
  // What each auth path may write is decided in lib/market-registration.ts:
  // the PROOF path (a public, replayable creation tx) may create a row or
  // replace the indexer's 'auto' guess, but never overwrites a creator-
  // registered row, never re-activates a retired one, and never changes a
  // row's pool / CA. Only the admin path may.
  //
  // `deployer` must be the wallet that ADMINISTERS the market: on the proof
  // path the creator the creation tx proves; on the admin path the deployer the
  // maintainer names.
  const registeredDeployer = slabAdmin ?? (admin ? deployer ?? null : null);
  if (!registeredDeployer) {
    return NextResponse.json(
      { ok: false, registered: false, error: "Cannot determine the market's deployer" },
      { status: 400 },
    );
  }

  // Prefer the wizard's payload: it is the single source of truth for the
  // DERIVED fields (floored max_leverage, oracle_authority's crank-wallet rule,
  // initial_price_e6, lp_collateral). Falling back to literals here would give
  // every market the column defaults — 10x and 10bps — regardless of what the
  // creator chose. On the proof path every one of these fields is covered by the
  // memo's payload digest (a replay cannot change them), and they are all
  // shape-checked (validateRegistrationPayload). The pool / CA / slab come from
  // the verified request, never from the payload.
  const p = boundPayload ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // Resolve the logo HERE, at registration.
  //
  // The indexer's metadata pass is guarded by .eq("metadata_source","auto"), so
  // the moment registration marks a row 'manual' the indexer can never fill in
  // logo_url again. Registration therefore has to supply it, or every properly
  // registered market would show a blank icon while the abandoned placeholder
  // rows kept theirs. Best-effort: a missing logo must never fail a launch.
  // Bounded await: by now the lookup has had the whole auth + classification
  // window to finish, so it is normally already resolved. A slow logo API must
  // never hold up a launch — past the deadline the market registers without one
  // (the success screen offers a manual upload).
  //
  // sanitizeLogoUrl, not the raw value: this string is rendered as an image src,
  // and the removed POST /api/markets path sanitized it before writing.
  const LOGO_DEADLINE_MS = 1_500;
  let resolvedLogo: string | null = null;
  try {
    const raw = await Promise.race([
      logoPromise,
      new Promise<null>((r) => setTimeout(() => r(null), LOGO_DEADLINE_MS)),
    ]);
    resolvedLogo = sanitizeLogoUrl(raw);
  } catch {
    resolvedLogo = null;
  }

  const dbResult = await upsertRegisteredMarketRow(getServiceClient(), {
    slab_address: slabAddress,
    mint_address: str(p.mint_address) ?? PLAYGROUND_COLLATERAL_MINT,
    symbol: str(p.symbol) ?? symbol ?? "UNKNOWN",
    name: str(p.name) ?? label ?? symbol ?? `Market ${slabAddress.slice(0, 8)}`,
    decimals: num(p.decimals) ?? 6,
    deployer: registeredDeployer,
    dex_pool_address: dexPoolAddress,
    mainnet_ca: mainnetCA ?? null,
    oracle_mode: str(p.oracle_mode) ?? "admin",
    network: getServerNetwork(),
    oracle_authority: str(p.oracle_authority),
    initial_price_e6: str(p.initial_price_e6),
    lp_collateral: str(p.lp_collateral),
    max_leverage: num(p.max_leverage),
    trading_fee_bps: num(p.trading_fee_bps),
    logo_url: resolvedLogo,
  }, admin ? "admin" : "proof", admin ? undefined : enrollmentCapsFromEnv());
  if (!dbResult.ok) {
    // Log the underlying cause server-side: a bare "Failed to register market"
    // with no log line left a real production failure undiagnosable.
    console.error(
      "[playground/keeper-register] markets row write failed:",
      dbResult.error,
      dbResult.detail ?? "(no detail)",
    );
    // The deployment's live-price ceiling is full: EVERY launch is now refused until it is raised.
    // 2026-10-05 20:14 UTC this was a silent 403 and 25+ markets went unpriced for a day.
    if (dbResult.status === 429 && dbResult.error === GLOBAL_CAP_COPY) {
      Sentry.captureMessage("[playground/keeper-register] keeper enrollment ceiling is full: new markets cannot be priced", {
        level: "error",
        tags: { endpoint: "/api/playground/keeper-register", auth: "cap-full" },
        extra: { slabAddress, deployer: registeredDeployer },
      });
      return NextResponse.json(
        { ok: false, registered: false, error: dbResult.error, ...(dbResult.code ? { code: dbResult.code } : {}) },
        { status: 429, headers: { "Retry-After": "300" } },
      );
    }
    // Review M-1: the database's own error text stays in the server log (the proof path is
    // reachable by anyone who has the public creation tx).
    return NextResponse.json(
      { ok: false, registered: false, error: dbResult.error, ...(dbResult.code ? { code: dbResult.code } : {}) },
      { status: dbResult.status },
    );
  }
  // A maintainer retired this (creator-registered) market: the proof path cannot re-enroll it,
  // and the blob is not re-written for it either. Final (not retryable).
  if (dbResult.action === "unchanged" && !dbResult.keeperActive) {
    return NextResponse.json(
      { ok: false, registered: false, error: "This market's live price was turned off by a maintainer." },
      { status: 403 },
    );
  }

  try {
    await upsertRegisteredMarket(entry);
  } catch (err) {
    // SEC: log the raw upstream error server-side only. Echoing it to the
    // caller (the previous `detail` field) leaked internal infra text — the
    // @vercel/blob error strings can name store IDs / paths and are an
    // info-leak smell. The generic `error` message is all the client needs.
    console.error(
      "[playground/keeper-register] Blob write failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      {
        ok: false,
        registered: false,
        error: "Failed to persist market registration to Blob store",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    // Kept alongside `ok` for backward compatibility with the existing
    // hooks/useCreateMarket.ts caller (registered/message drive its UI copy).
    registered: true,
    message: "Registered — the keeper will pick this up on its next poll (~30s)",
    slabAddress,
    dexPoolAddress,
    dexType: normalizedDexType,
    label: resolvedLabel,
  });
}
