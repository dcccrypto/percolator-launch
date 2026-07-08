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
 * Authentication (H1): two accepted paths —
 *   a) Wallet-signed proof of slab ownership — the normal path, mirroring the
 *      PERC-8332 nonce+ed25519 flow already used by POST /api/markets:
 *        1. GET /api/markets/challenge?deployer=<pubkey> → { nonce }  (fresh nonce —
 *           nonces are single-use and shared with /api/markets, so a caller that
 *           already spent one registering with /api/markets needs a new one here)
 *        2. Sign the nonce bytes (UTF-8) with the deployer keypair → base64 signature
 *        3. POST here with { ...body, deployer, nonce, signature }
 *      The route verifies the ed25519 signature over the nonce, atomically claims
 *      the nonce, then reads the slab account on devnet and requires `deployer` to
 *      match its on-chain admin/marketauth field — cryptographic proof of the key
 *      PLUS proof that key actually administers this specific market.
 *   b) Admin bypass: header `x-admin-secret` matching ADMIN_API_SECRET (the same
 *      shared secret already used by /api/oracle/set-price-cap) — for maintainer
 *      manual fixes (e.g. re-registering an orphaned market, as done for ANSEM).
 *      Timing-safe compare; unset/empty ADMIN_API_SECRET disables this path
 *      entirely (fails closed, matches the set-price-cap convention).
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
 *   nonce?:         string  — required unless using the admin bypass; see above
 *   signature?:     string  — required unless using the admin bypass; see above
 * }
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN — read automatically by the @vercel/blob SDK (Vercel-managed).
 *   ADMIN_API_SECRET      — optional; enables the admin-bypass auth path (H1b).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import * as Sentry from "@sentry/nextjs";
import { isV17Account, parseWrapperConfigV17, parseHeader, V17_HEADER_LEN } from "@percolatorct/sdk";
import type { RegisteredMarket } from "@/lib/playground-registered-markets";
import { upsertRegisteredMarket } from "@/lib/playground-registered-markets";
import { normalizeDexType, KEEPER_DEX_TYPES, type KeeperDexType } from "@/lib/dex-type";
import { claimPlaygroundChallenge } from "@/lib/playground-nonce-store";
import { getConfig, getAllProgramIds } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Timing-safe admin-bypass check (H1b) — same secret/header convention as
 *  /api/oracle/set-price-cap. Empty/unset ADMIN_API_SECRET always denies. */
function isAdminBypass(req: NextRequest): boolean {
  const secret = (process.env.ADMIN_API_SECRET ?? "").trim();
  if (!secret) return false;
  const provided = req.headers.get("x-admin-secret") ?? "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mainnet DEX program → keeper dexType. The AUTHORITATIVE classification:
 *  the keeper parses the pool with the layout this type names, so the binding
 *  must come from the pool account's owner program, not from a client string.
 *  (DexScreener reports "meteora" for both DLMM and DAMM pools and "raydium"
 *  for CLMM and CPMM — trusting it risks handing the keeper a pool whose byte
 *  layout doesn't match its parser.) Verified against the curated playground
 *  pools: SOL→CAMM (CLMM), JUP/TRUMP/PENGU→LBUZ (DLMM).
 */
const DEX_PROGRAM_TO_TYPE: Record<string, KeeperDexType> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm", // Raydium Concentrated Liquidity
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm", // Meteora DLMM
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap", // PumpSwap AMM
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

  const { slabAddress, mainnetCA, dexPoolAddress, dexType, symbol, label, deployer, nonce, signature } = body as {
    slabAddress?: string;
    mainnetCA?: string;
    dexPoolAddress?: string;
    dexType?: string;
    symbol?: string;
    label?: string;
    deployer?: string;
    nonce?: string;
    signature?: string;
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

  // H1: authenticate the caller before any mainnet RPC or registry write — this
  // route used to be reachable by anyone with a slabAddress, letting a griefer
  // inject or repoint any market's pricing pool. Two accepted paths (see the
  // file header doc comment): admin bypass, or wallet-signed proof that the
  // caller actually administers this specific slab.
  if (!isAdminBypass(req)) {
    if (!deployer || !nonce || !signature) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: deployer, nonce, signature. " +
            "Call GET /api/markets/challenge?deployer=<pubkey> for a fresh nonce " +
            "(nonces are single-use — don't reuse one already spent on /api/markets), " +
            "sign it with the deployer keypair, and include the base64 signature.",
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

    // Verify the cryptographic proof BEFORE claiming the nonce (mirrors GH#2018 in
    // /api/markets — an invalid signature must never burn a victim's pending nonce).
    const nonceBytes = new Uint8Array(Buffer.from(nonce, "utf-8"));
    let sigValid = false;
    try {
      sigValid = nacl.sign.detached.verify(nonceBytes, signatureBytes, deployerPubkeyBytes);
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      Sentry.captureMessage("[playground/keeper-register] Deployer signature verification failed", {
        level: "warning",
        tags: { endpoint: "/api/playground/keeper-register", auth: "sig-fail" },
        extra: { deployer, slabAddress },
      });
      return NextResponse.json(
        { error: "Signature verification failed. Ensure you signed the nonce bytes with the deployer keypair." },
        { status: 401 },
      );
    }

    if (!claimPlaygroundChallenge(nonce, deployer)) {
      return NextResponse.json(
        { error: "Invalid, expired, or already-used nonce. Call GET /api/markets/challenge to get a fresh nonce." },
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

  try {
    await upsertRegisteredMarket(entry);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[playground/keeper-register] Blob write failed:", detail);
    return NextResponse.json(
      {
        ok: false,
        registered: false,
        error: "Failed to persist market registration to Blob store",
        detail,
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
