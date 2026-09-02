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
 * Authentication (H1v2): two accepted paths —
 *   a) Wallet-signed STATELESS deployer proof — no server-stored nonce:
 *        1. Sign the UTF-8 message `keeper-register:<slabAddress>:<unix-minute>`
 *           (unix-minute = Math.floor(Date.now()/60000), computed client-side) with
 *           the deployer keypair → base64 signature.
 *        2. POST here with { ...body, deployer, signature }.
 *      The route independently reconstructs that message for a small window of
 *      minutes around its OWN clock (tolerates clock skew + wallet-sign latency,
 *      no round trip needed) and accepts if the ed25519 signature verifies for any
 *      candidate. It then reads the slab account on devnet and requires `deployer`
 *      to match its on-chain admin/marketauth field — cryptographic proof of the
 *      key PLUS proof that key actually administers this specific market.
 *
 *      H1v1 (superseded) used a nonce+claim flow mirroring PERC-8332
 *      (GET /api/markets/challenge → nonce, sign it, claim it here) backed by a
 *      process-local Map (lib/playground-nonce-store.ts). On Vercel that Map is
 *      per-lambda-instance: the GET that issued the nonce and the POST that claimed
 *      it could land on different instances with no shared memory, so a real launch
 *      would 400 "Missing required fields: deployer, nonce, signature" (client sent
 *      them; a stale deployed bundle predating the wiring fix, or the nonce simply
 *      not existing in this instance's Map) or 401 "invalid/expired nonce" — often
 *      enough to make registration effectively unreliable in production. The
 *      stateless message scheme above needs no shared state between requests, so it
 *      works correctly regardless of which instance handles the call. (The
 *      /api/markets nonce+challenge flow is unaffected by this change and keeps
 *      using lib/playground-nonce-store.ts — see that file's header for the same
 *      latent race, out of scope here.)
 *   b) Admin bypass: header `x-admin-secret` matching ADMIN_API_SECRET (the same
 *      shared secret already used by /api/oracle/set-price-cap) — for maintainer
 *      manual fixes (e.g. re-registering an orphaned market, as done for ANSEM).
 *      Timing-safe compare; unset/empty ADMIN_API_SECRET disables this path
 *      entirely (fails closed, matches the set-price-cap convention).
 *
 * CALLER ORDERING REQUIREMENT (confirmed by live end-to-end repro): `deployer` is
 * checked against the slab's LIVE on-chain admin/marketauth (see below), not a
 * point-in-time snapshot. percolator-stake's InitPool ROTATES marketauth from the
 * creator wallet to the stake-pool PDA — once that instruction lands, no wallet can
 * pass this check again for that slab (the PDA has no private key to sign with).
 * Callers MUST invoke this route BEFORE InitPool, while marketauth is still the
 * creator wallet — see hooks/useCreateMarket.ts, which now registers between Step 4
 * (Earn LP vault) and Step 5 (Stake InitPool) for exactly this reason. Calling it
 * after InitPool always 403s with "Deployer does not match slab admin", permanently.
 *
 * Body: {
 *   slabAddress:    string  — devnet market account
 *   mainnetCA:      string  — mainnet token CA (for keeper labelling)
 *   dexPoolAddress: string  — mainnet DEX pool address
 *   dexType:        string  — hint; DexScreener dexIds accepted ("meteora",
 *                             "raydium", …) — see lib/dex-type.ts
 *   symbol?:        string  — token symbol (e.g. "SOL")
 *   label?:         string  — human label (e.g. "SOL/USDC — Raydium CLMM")
 *   deployer?:      string  — required unless using the admin bypass; see above
 *   signature?:     string  — required unless using the admin bypass; base64
 *                             ed25519 signature over the stateless proof message;
 *                             see above
 * }
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN — read automatically by the @vercel/blob SDK (Vercel-managed).
 *   ADMIN_API_SECRET      — optional; enables the admin-bypass auth path (H1b).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAdminSecret } from "@/lib/admin-secret";
import {
  buildKeeperRegisterProofMessage,
  type KeeperRegisterProofParams,
} from "@/lib/keeper-register-proof";
import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import * as Sentry from "@sentry/nextjs";
import { isV17Account, parseWrapperConfigV17, parseHeader, V17_HEADER_LEN } from "@percolatorct/sdk";
import type { RegisteredMarket } from "@/lib/playground-registered-markets";
import { upsertRegisteredMarket } from "@/lib/playground-registered-markets";
import { normalizeDexType, KEEPER_DEX_TYPES, type KeeperDexType } from "@/lib/dex-type";
import { getConfig, getAllProgramIds } from "@/lib/config";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { resolveTokenLogo } from "@/lib/token-logo";
import { sanitizeLogoUrl } from "@/lib/token-metadata-validators";
import { upsertRegisteredMarketRow, type RegistrationRow } from "@/lib/market-registration";
import { checkSymbol, checkName } from "@/lib/market-metadata-validation";

export const dynamic = "force-dynamic";

/** Timing-safe admin-bypass check (H1b) — same secret/header convention as
 *  /api/oracle/set-price-cap. Empty/unset ADMIN_API_SECRET always denies. */
function isAdminBypass(req: NextRequest): boolean {
  return checkAdminSecret(req, "register");
}

/** H1v2 stateless deployer proof — see "Authentication (H1v2)" in the file header
 *  for why this replaced the nonce+claim scheme. No server-stored state: the
 *  message is fully determined by (slabAddress, unix-minute), so any lambda
 *  instance can verify it without having "seen" an issuance step. */
const STATELESS_PROOF_PREFIX = "keeper-register";
/** Tolerance window: candidate minutes tried are [now - BACK, now + FWD]. Generous
 *  enough to absorb clock skew and wallet-approval latency without meaningfully
 *  weakening the check — a signature is still scoped to one specific slab and only
 *  useful if the signer also holds that slab's on-chain admin key (checked below). */
const STATELESS_PROOF_WINDOW_BACK_MIN = 5;
const STATELESS_PROOF_WINDOW_FWD_MIN = 1;

// #2505 / #2468: the proof now covers the parameters the route ACTS ON, not just
// the slab. Built by the shared module so the client and this verifier cannot
// drift — see lib/keeper-register-proof.ts for what is and is not fixed.
function statelessProofMessage(
  params: KeeperRegisterProofParams,
  unixMinute: number,
): Uint8Array {
  return buildKeeperRegisterProofMessage(params, unixMinute);
}

/** Verify `signatureBytes` is a valid ed25519 signature by `deployerPubkeyBytes` over
 *  `keeper-register:<slabAddress>:<unix-minute>` for some minute within the tolerance
 *  window of the server's own clock. Stateless — no nonce store, no shared memory
 *  needed between the "issuing" and "verifying" request (there is no issuing request). */
function verifyStatelessDeployerProof(
  params: KeeperRegisterProofParams,
  deployerPubkeyBytes: Uint8Array,
  signatureBytes: Uint8Array,
): boolean {
  const nowMinute = Math.floor(Date.now() / 60_000);
  for (let d = -STATELESS_PROOF_WINDOW_BACK_MIN; d <= STATELESS_PROOF_WINDOW_FWD_MIN; d++) {
    const msg = statelessProofMessage(params, nowMinute + d);
    try {
      if (nacl.sign.detached.verify(msg, signatureBytes, deployerPubkeyBytes)) return true;
    } catch {
      // Malformed input for this candidate — try the next one.
    }
  }
  return false;
}

/** Mainnet DEX program → keeper dexType. The AUTHORITATIVE classification:
 *  the keeper parses the pool with the layout this type names, so the binding
 *  must come from the pool account's owner program, not from a client string.
 *  (DexScreener reports "meteora" for both DLMM and DAMM pools and "raydium"
 *  for CLMM and CPMM — trusting it risks handing the keeper a pool whose byte
 *  layout doesn't match its parser.) Verified against the curated playground
 *  pools: SOL→CAMM (CLMM), JUP/TRUMP/PENGU→LBUZ (DLMM).
 *
 *  PumpSwap (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) re-enabled
 *  (percolator-sdk@3.1.0+): the parser's byte offsets, decimal handling, and
 *  SOL→USD conversion were all fixed and verified against live mainnet pools
 *  — see dex-type.ts's KEEPER_DEX_TYPES doc and the SDK CHANGELOG [3.1.0].
 */
const DEX_PROGRAM_TO_TYPE: Record<string, KeeperDexType> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm", // Raydium Concentrated Liquidity
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm", // Meteora DLMM
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap", // pump.fun AMM (PumpSwap)
};

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

/** Classify a mainnet pool by its owner program.
 *  Returns a dexType, "unsupported" (account exists under an unknown program),
 *  "missing" (no such account on mainnet), or "rpc-failed" (couldn't check —
 *  callers fall back to the client-supplied string). One getAccountInfo call. */
async function classifyPoolByOwner(
  poolAddress: string,
): Promise<KeeperDexType | "unsupported" | "missing" | "rpc-failed"> {
  try {
    const conn = new Connection(MAINNET_RPC_URL, "confirmed");
    const info = await Promise.race([
      conn.getAccountInfo(new PublicKey(poolAddress)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mainnet RPC timeout")), 8_000)),
    ]);
    if (!info) return "missing";
    return DEX_PROGRAM_TO_TYPE[info.owner.toBase58()] ?? "unsupported";
  } catch {
    return "rpc-failed";
  }
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

  const { slabAddress, mainnetCA, dexPoolAddress, dexType, symbol, label, deployer, signature, payload } = body as {
    slabAddress?: string;
    mainnetCA?: string;
    dexPoolAddress?: string;
    dexType?: string;
    symbol?: string;
    label?: string;
    deployer?: string;
    signature?: string;
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

  // H1: authenticate the caller before any mainnet RPC or registry write — this
  // route used to be reachable by anyone with a slabAddress, letting a griefer
  // inject or repoint any market's pricing pool. Two accepted paths (see the
  // file header doc comment): admin bypass, or wallet-signed proof that the
  // caller actually administers this specific slab.
  // Kick the logo lookup off NOW, before the two RPC round-trips below (slab
  // ownership + pool classification), so it overlaps them instead of adding its
  // own latency. It used to run just before the DB write, where its two
  // sequential 5s-timeout fetches could add up to 10s to a launch — and this
  // route is awaited between M3a and M4, so that delay was on the critical path.
  // Deliberately not awaited here; see the bounded await at the write.
  const logoPromise: Promise<string | null> = mainnetCA
    ? resolveTokenLogo(mainnetCA).catch(() => null)
    : Promise.resolve(null);

  // The slab's on-chain admin/marketauth, captured by the ownership check below
  // so the registration write can record who actually administers this market.
  let slabAdmin: string | null = null;

  if (!isAdminBypass(req)) {
    if (!deployer || !signature) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: deployer, signature. " +
            'Sign the message "keeper-register:<slabAddress>:<unix-minute>" (UTF-8, ' +
            "unix-minute = Math.floor(Date.now()/60000)) with the deployer keypair and " +
            "include the base64 signature. No separate challenge call needed.",
        },
        { status: 400 },
      );
    }

    let deployerPubkeyBytes: Uint8Array;
    try {
      deployerPubkeyBytes = new PublicKey(deployer).toBytes();
    } catch {
      return NextResponse.json({ error: "Invalid deployer: must be a valid Solana public key" }, { status: 400 });
    }

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = Buffer.from(signature, "base64");
      if (signatureBytes.length !== 64) throw new Error("Signature must be 64 bytes");
    } catch {
      return NextResponse.json(
        { error: "Invalid signature: must be a base64-encoded 64-byte ed25519 signature" },
        { status: 400 },
      );
    }

    // H1v2: stateless deployer proof — no nonce to claim, so no server-stored state to
    // race across serverless lambda instances (see file header for why this replaced
    // the nonce+claim scheme).
    // #2505 / #2468: verify against the parameters this request ACTS ON, not the
    // slab alone. A signature is now valid for exactly one (slab, pool, CA, type,
    // symbol, label) tuple, so a captured one can no longer authorise the same
    // slab against a substituted pool.
    const sigValid = verifyStatelessDeployerProof(
      { slabAddress, dexPoolAddress, mainnetCA: mainnetCA ?? "", dexType: dexType ?? "", symbol, label },
      deployerPubkeyBytes,
      signatureBytes,
    );
    if (!sigValid) {
      Sentry.captureMessage("[playground/keeper-register] Deployer signature verification failed", {
        level: "warning",
        tags: { endpoint: "/api/playground/keeper-register", auth: "sig-fail" },
        extra: { deployer, slabAddress },
      });
      return NextResponse.json(
        {
          error:
            "Signature verification failed. The proof must cover the registration " +
            "parameters, not just the slab — build it with " +
            "buildKeeperRegisterProofMessage() from lib/keeper-register-proof and sign " +
            "with the deployer keypair within the last few minutes.",
        },
        { status: 401 },
      );
    }

    // Cryptographic proof of the deployer key alone isn't enough — verify that key
    // actually administers THIS slab (on-chain admin/marketauth), so a valid
    // signature from an unrelated wallet can't repoint someone else's market.
    try {
      const cfg = getConfig();
      const connection = new Connection(cfg.rpcUrl, "confirmed");
      const slabPubkey = new PublicKey(slabAddress);
      const accountInfo = await connection.getAccountInfo(slabPubkey);
      if (!accountInfo) {
        return NextResponse.json({ error: "Slab account does not exist on-chain" }, { status: 400 });
      }
      if (!getAllProgramIds().includes(accountInfo.owner.toBase58())) {
        return NextResponse.json({ error: "Slab account not owned by a known percolator program" }, { status: 400 });
      }
      const dataBytes = new Uint8Array(accountInfo.data);
      // isV17Account-first, parseHeader fallback — mirrors the same pattern used by
      // POST /api/markets (R2-S8) and hooks/useCreateMarket.ts for admin resolution.
      const admin = isV17Account(dataBytes)
        ? parseWrapperConfigV17(dataBytes, V17_HEADER_LEN).marketauth
        : parseHeader(accountInfo.data).admin;
      if (admin.toBase58() !== deployer) {
        return NextResponse.json({ error: "Deployer does not match slab admin" }, { status: 403 });
      }
      slabAdmin = admin.toBase58();
    } catch (err) {
      console.error(
        "[playground/keeper-register] Slab ownership check failed:",
        err instanceof Error ? err.message : String(err),
      );
      return NextResponse.json({ error: "Failed to verify slab ownership on-chain" }, { status: 400 });
    }
  }

  // Resolve the dexType. Authoritative: classify the pool by its mainnet owner
  // program. Fallback (mainnet RPC unreachable): normalize the client string —
  // alias-tolerant, since the wizard passes DexScreener dexIds ("meteora",
  // "raydium") that previously 400'd here and silently orphaned the market
  // (wizard treats registration as non-fatal → market live on-chain, but no
  // keeper price, no name, invisible on /markets).
  let normalizedDexType: KeeperDexType;
  const classified = await classifyPoolByOwner(dexPoolAddress);
  if (classified === "missing") {
    return NextResponse.json(
      { error: `dexPoolAddress ${dexPoolAddress} does not exist on mainnet` },
      { status: 400 },
    );
  }
  if (classified === "unsupported") {
    return NextResponse.json(
      { error: `dexPoolAddress is owned by an unsupported DEX program — the keeper can only price ${KEEPER_DEX_TYPES.join(", ")} pools` },
      { status: 400 },
    );
  }
  if (classified === "rpc-failed") {
    const fromString = normalizeDexType(dexType);
    if (!fromString) {
      return NextResponse.json(
        { error: `Could not verify the pool on mainnet, and dexType "${dexType ?? ""}" does not map to any of: ${KEEPER_DEX_TYPES.join(", ")}` },
        { status: 502 },
      );
    }
    normalizedDexType = fromString;
  } else {
    normalizedDexType = classified;
  }

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
  // Everything above has already verified the caller against the slab's live
  // on-chain marketauth, so this write is authenticated. See
  // lib/market-registration.ts for why an 'auto' row may be overwritten.
  // `deployer` must be the wallet that ADMINISTERS the market. On the signed
  // path that is the verified deployer (already proven equal to the on-chain
  // marketauth); on the admin-bypass path nobody signed, so fall back to the
  // marketauth read from chain rather than writing something that merely looks
  // plausible. Every pre-existing row has the sim-USDC MINT in this column —
  // that is the mistake this avoids repeating.
  const registeredDeployer = deployer ?? slabAdmin;
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
  // creator chose. Identity fields stay pinned to values this route has already
  // verified, so a crafted payload cannot repoint the row.
  const p = (payload ?? {}) as Record<string, unknown>;
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
  });
  if (!dbResult.ok) {
    // Surface the underlying cause. This is a devnet playground and the launch
    // UI is the only place this failure is ever seen — a bare "Failed to
    // register market" left a real production failure with no diagnosable
    // signal anywhere.
    console.error(
      "[playground/keeper-register] markets row write failed:",
      dbResult.error,
      dbResult.detail ?? "(no detail)",
    );
    return NextResponse.json(
      {
        ok: false,
        registered: false,
        error: dbResult.detail ? `${dbResult.error}: ${dbResult.detail}` : dbResult.error,
      },
      { status: dbResult.status },
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
