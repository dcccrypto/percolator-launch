import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import * as Sentry from "@sentry/nextjs";
import { getServiceClient } from "@/lib/supabase";
import { validateSlabParam } from "@/lib/route-validators";
import { detectRasterImage } from "@/lib/raster-image-bytes";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

// Rate limit: simple in-memory tracker (resets on cold start, good enough for Vercel)
const uploadTimestamps = new Map<string, number>();
const RATE_LIMIT_MS = 30_000; // 1 upload per 30s per slab

/**
 * POST /api/markets/[slab]/logo — Upload logo file to Supabase Storage.
 *
 * AUTHENTICATION (rewritten 2026-07-13 — was broken for every real user):
 * this route used to gate on `requireAuth()` (a server-only `x-api-key` vs
 * INDEXER_API_KEY header). The browser can't hold that key — it's meant for
 * the indexer service — so every upload from components/create/LogoUpload.tsx
 * 401'd unconditionally. Worse, `x-api-key` is one secret shared across every
 * caller of that key, so a leak would let anyone overwrite ANY market's logo;
 * it was never a *per-market* ownership check to begin with.
 *
 * Replaced with a per-market wallet-ownership proof, mirroring
 * app/api/playground/keeper-register/route.ts's H1v2 stateless deployer proof
 * (ed25519 signature over a message binding the signer to a unix-minute
 * window, verified independently by the server — no nonce, no shared state
 * between requests):
 *   1. Client signs `market-logo:<slabAddress>:<unix-minute>` and POSTs it
 *      as `deployer` + `signature` FORM FIELDS alongside the `logo` file
 *      (multipart/form-data, not JSON — this route always was, and the
 *      logo file itself has to travel the same way).
 *   2. The server reconstructs that message for a small window of minutes
 *      around its own clock and verifies the ed25519 signature.
 *
 * CRITICAL DIFFERENCE from keeper-register: keeper-register checks
 * `deployer == slab.marketauth`. That check is USELESS here, because logo
 * upload happens POST-launch — from LaunchSuccess.tsx right after a
 * completed launch, and from CreatorMarketRow.tsx on the creator dashboard —
 * and by then `marketauth` has already ROTATED away from the creator to the
 * stake-pool PDA (percolator-stake's StakeInitPool does this irreversibly;
 * see hooks/useCreatedMarkets.ts's header comment for the same discovery).
 * A PDA has no private key, so checking marketauth would make every
 * completed launch permanently unable to prove ownership.
 *
 * Instead this binds to the DURABLE creator marker: the market's LP
 * PORTFOLIO — the AMM counterparty account created by the wizard via
 * InitUser with the CREATOR's wallet as its mutable owner (offset 116), and
 * never rotated afterward (see lib/lpPortfolio.ts's isLpPortfolio doc and
 * hooks/useCreatedMarkets.ts). After the signature verifies for `deployer`,
 * this route runs a `getProgramAccounts` scan (magic@0 + market_group_id@16
 * == this slab + owner@116 == deployer) and accepts only if at least one
 * returned account is the market's actual LP (isLpPortfolio — trailing
 * PortfolioMatcherConfigV16.enabled == 1), not just any portfolio the wallet
 * happens to own on this market.
 *
 * Admin bypass: header `x-admin-secret` matching ADMIN_API_SECRET (same
 * convention as keeper-register / /api/oracle/set-price-cap), timing-safe,
 * fails closed when unset.
 */

/** Timing-safe admin-bypass check — same secret/header convention as
 *  /api/playground/keeper-register and /api/oracle/set-price-cap. Empty/unset
 *  ADMIN_API_SECRET always denies. */
function isAdminBypass(req: NextRequest): boolean {
  const secret = (process.env.ADMIN_API_SECRET ?? "").trim();
  if (!secret) return false;
  const provided = req.headers.get("x-admin-secret") ?? "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stateless deployer proof — see the file header for why this mirrors
 *  keeper-register's H1v2 scheme instead of a nonce+claim flow. No
 *  server-stored state: the message is fully determined by (slabAddress,
 *  unix-minute), so any lambda instance can verify it. */
const STATELESS_PROOF_PREFIX = "market-logo";
/** Tolerance window: candidate minutes tried are [now - BACK, now + FWD]. */
const STATELESS_PROOF_WINDOW_BACK_MIN = 5;
const STATELESS_PROOF_WINDOW_FWD_MIN = 1;

function statelessProofMessage(slabAddress: string, unixMinute: number): Uint8Array {
  return new TextEncoder().encode(`${STATELESS_PROOF_PREFIX}:${slabAddress}:${unixMinute}`);
}

/** Verify `signatureBytes` is a valid ed25519 signature by `deployerPubkeyBytes`
 *  over `market-logo:<slabAddress>:<unix-minute>` for some minute within the
 *  tolerance window of the server's own clock. */
function verifyStatelessDeployerProof(
  slabAddress: string,
  deployerPubkeyBytes: Uint8Array,
  signatureBytes: Uint8Array,
): boolean {
  const nowMinute = Math.floor(Date.now() / 60_000);
  for (let d = -STATELESS_PROOF_WINDOW_BACK_MIN; d <= STATELESS_PROOF_WINDOW_FWD_MIN; d++) {
    const msg = statelessProofMessage(slabAddress, nowMinute + d);
    try {
      if (nacl.sign.detached.verify(msg, signatureBytes, deployerPubkeyBytes)) return true;
    } catch {
      // Malformed input for this candidate — try the next one.
    }
  }
  return false;
}

/** v17 portfolio account magic (PERCV16\0), base64 for the memcmp filter. */
const V17_PORTFOLIO_MAGIC_B64 = Buffer.from([
  0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50,
]).toString("base64");
/** market_group_id — the slab a portfolio belongs to. */
const V17_PF_MARKET_OFF = 16;
/** Mutable owner (SDK PF_OWNER_OFF) — NOT provenance@80. */
const V17_PF_OWNER_OFF = 116;

/**
 * True iff `deployer` owns the market's LP portfolio on `slabAddress` — the
 * durable creator marker (see file header). Scans the wrapper program for
 * portfolios matching (magic + this slab + this owner) and accepts if any of
 * the (0–2) results is the market's actual LP (isLpPortfolio).
 */
async function verifyMarketOwnership(slabAddress: string, deployer: string): Promise<boolean> {
  const cfg = getConfig();
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const accounts = await connection.getProgramAccounts(new PublicKey(cfg.programId), {
    filters: [
      { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_B64, encoding: "base64" } },
      { memcmp: { offset: V17_PF_MARKET_OFF, bytes: slabAddress } },
      { memcmp: { offset: V17_PF_OWNER_OFF, bytes: deployer } },
    ],
  });
  return accounts.some(({ account }) => isLpPortfolio(account.data));
}

// GET /api/markets/[slab]/logo
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;

  // Validate slab parameter format
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = new PublicKey(validation.slab).toBase58();

  let supabase: ReturnType<typeof getServiceClient> | null = null;
  try {
    supabase = getServiceClient();
  } catch {
    // Supabase unavailable — return null logo gracefully
    return NextResponse.json({ logo_url: null });
  }

  try {
    const { data, error } = await supabase
      .from("markets")
      .select("logo_url")
      .eq("slab_address", validSlab)
      .single();

    if (error) {
      return NextResponse.json({ logo_url: null }, { status: 404 });
    }

    return NextResponse.json({ logo_url: data.logo_url });
  } catch {
    return NextResponse.json({ logo_url: null });
  }
}

// POST /api/markets/[slab]/logo — Upload logo file to Supabase Storage
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;

  // Validate slab address
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }
  const validSlab = new PublicKey(validation.slab).toBase58();

  // multipart/form-data — the logo file AND the wallet ownership proof
  // (`deployer`, `signature`) all travel as form fields on the same request.
  const formData = await req.formData();
  const deployer = formData.get("deployer");
  const signature = formData.get("signature");

  // AUTH: per-market wallet ownership proof (or admin bypass) — see file
  // header for why this replaced the broken shared-key `requireAuth` gate.
  if (!isAdminBypass(req)) {
    if (typeof deployer !== "string" || typeof signature !== "string" || !deployer || !signature) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: deployer, signature. " +
            `Sign the message "market-logo:${validSlab}:<unix-minute>" (UTF-8, ` +
            "unix-minute = Math.floor(Date.now()/60000)) with the market creator's " +
            "wallet and include the base64 signature as form fields alongside 'logo'.",
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

    const sigValid = verifyStatelessDeployerProof(validSlab, deployerPubkeyBytes, signatureBytes);
    if (!sigValid) {
      Sentry.captureMessage("[markets/logo] Deployer signature verification failed", {
        level: "warning",
        tags: { endpoint: "/api/markets/[slab]/logo", auth: "sig-fail" },
        extra: { deployer, slabAddress: validSlab },
      });
      return NextResponse.json(
        {
          error:
            'Signature verification failed. Ensure you signed "market-logo:<slabAddress>:<unix-minute>" ' +
            "with the market creator's wallet within the last few minutes.",
        },
        { status: 401 },
      );
    }

    // Cryptographic proof of the deployer key alone isn't enough — verify that
    // key actually owns THIS market's LP portfolio (the durable creator
    // marker; marketauth can't be used here — see file header for why).
    try {
      const owns = await verifyMarketOwnership(validSlab, deployer);
      if (!owns) {
        return NextResponse.json({ error: "Signer is not the creator of this market" }, { status: 403 });
      }
    } catch (err) {
      console.error(
        "[markets/logo] Market ownership check failed:",
        err instanceof Error ? err.message : String(err),
      );
      return NextResponse.json({ error: "Failed to verify market ownership" }, { status: 400 });
    }
  }

  // Rate limit
  const lastUpload = uploadTimestamps.get(validSlab) ?? 0;
  if (Date.now() - lastUpload < RATE_LIMIT_MS) {
    return NextResponse.json({ error: "Rate limited. Try again in 30s." }, { status: 429 });
  }

  const file = formData.get("logo") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided. Use 'logo' field." }, { status: 400 });
  }

  // Reject declared non-raster types early (SVG, etc.); real format verified by magic bytes below.
  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/jpg", ""];
  if (file.type && !allowedTypes.includes(file.type)) {
    return NextResponse.json(
      { error: `Invalid file type. Allowed: PNG, JPEG, WebP, GIF` },
      { status: 400 }
    );
  }

  // Max 2MB
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large. Max 2MB." }, { status: 400 });
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return NextResponse.json({ error: "Storage backend unavailable" }, { status: 503 });
  }

  // Check market exists
  const { data: market, error: marketError } = await supabase
    .from("markets")
    .select("slab_address")
    .eq("slab_address", validSlab)
    .single();

  if (marketError || !market) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const detected = detectRasterImage(buffer);
    if (!detected) {
      return NextResponse.json(
        { error: "Invalid image file. Upload a valid PNG, JPEG, WebP, or GIF (contents do not match)." },
        { status: 400 }
      );
    }

    const filePath = `market-logos/${validSlab}.${detected.ext}`;

    const { error: uploadError } = await supabase.storage
      .from("logos")
      .upload(filePath, buffer, { contentType: detected.contentType, upsert: true });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("logos").getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    const { error: updateError } = await supabase
      .from("markets")
      .update({ logo_url: publicUrl })
      .eq("slab_address", validSlab);

    if (updateError) {
      console.error("DB update error:", updateError);
      return NextResponse.json({ error: "Failed to save logo URL. Please try again." }, { status: 500 });
    }

    uploadTimestamps.set(validSlab, Date.now());

    return NextResponse.json({ logo_url: publicUrl }, { status: 200 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Failed to process upload" }, { status: 500 });
  }
}
