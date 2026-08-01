/**
 * POST /api/playground/keeper-cosign
 *
 * Backend co-sign for the playground bundled create+delegate flow.
 *
 * The client has just created a market slab (Tx0: SystemProgram.createAccount +
 * InitMarket). Now it needs to:
 *   1. ConfigureAuthMark — set oracle to AUTH_MARK mode (mode=3)
 *   2. UpdateAssetAuthority(Oracle → keeper) — delegate oracle_authority to OUR keeper
 *
 * UpdateAssetAuthority requires BOTH the current oracle_authority (creator = wallet)
 * AND the new oracle_authority (keeper) to sign. The frontend can't sign for the keeper,
 * so this route does it.
 *
 * Flow:
 *   1. Client POSTs { deployer, slabAddress, initialPriceE6 }
 *   2. Server fetches current slot + recent blockhash from devnet
 *   3. Server builds ConfigureAuthMark + UpdateAssetAuthority instructions
 *   4. Server partially signs the tx with the keeper keypair
 *   5. Server returns { partialTxBase64, keeperPubkey }
 *   6. Client deserializes the partial tx, wallet signs (creator sig), sends on-chain
 *
 * After the tx lands:
 *   - oracle_mode = 3 (AUTH_MARK)
 *   - oracle_authority = keeperPubkey (keeper can now call PushAuthMark)
 *   - marketauth = deployer (creator remains market admin)
 *
 * Security:
 *   - Only runs on devnet (403 on mainnet)
 *   - Validates slabAddress and deployer as valid Solana pubkeys
 *   - Validates the keeper pubkey is available (503 if not configured)
 *   - No auth header needed — the keeper co-sign is safe to expose publicly
 *     because it can only affect oracle_authority, not funds. The creator
 *     wallet still owns the market (marketauth).
 *
 * Environment:
 *   PLAYGROUND_KEEPER_KEYPAIR — JSON [64-byte] array or base58 secret key
 *   DEVNET_MINT_AUTHORITY_KEYPAIR — fallback if above not set
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  encodeConfigureAuthMark,
  encodeUpdateAssetAuthority,
  ACCOUNTS_CONFIGURE_AUTH_MARK,
  ACCOUNTS_UPDATE_AUTHORITY,
  ASSET_AUTH_KIND,
  buildIx,
  buildAccountMetas,
} from "@percolatorct/sdk";
import { getRpcEndpoint, getConfig } from "@/lib/config";
import { requirePlaygroundKeeperSigner } from "@/lib/playground-keeper-signer";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();

/** GET /api/playground/keeper-cosign — return keeper pubkey so clients can inspect without a POST */
export async function GET(_req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }
  try {
    const keeper = requirePlaygroundKeeperSigner();
    return NextResponse.json({ keeperPubkey: keeper.publicKey() });
  } catch (e) {
    return NextResponse.json(
      { error: "Keeper not configured", detail: (e as Error).message },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }

  let keeper;
  try {
    keeper = requirePlaygroundKeeperSigner();
  } catch {
    return NextResponse.json(
      { error: "Keeper keypair not configured (PLAYGROUND_KEEPER_KEYPAIR or DEVNET_MINT_AUTHORITY_KEYPAIR)" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { deployer, slabAddress, initialPriceE6, assetIndex } = body as {
    deployer?: string;
    slabAddress?: string;
    initialPriceE6?: string;
    assetIndex?: number;
  };

  if (!deployer || typeof deployer !== "string") {
    return NextResponse.json({ error: "deployer is required" }, { status: 400 });
  }
  if (!slabAddress || typeof slabAddress !== "string") {
    return NextResponse.json({ error: "slabAddress is required" }, { status: 400 });
  }
  if (!initialPriceE6 || typeof initialPriceE6 !== "string") {
    return NextResponse.json({ error: "initialPriceE6 is required (bigint as string)" }, { status: 400 });
  }

  let deployerPk: PublicKey;
  let slabPk: PublicKey;
  try { deployerPk = new PublicKey(deployer); } catch {
    return NextResponse.json({ error: "Invalid deployer pubkey" }, { status: 400 });
  }
  try { slabPk = new PublicKey(slabAddress); } catch {
    return NextResponse.json({ error: "Invalid slabAddress" }, { status: 400 });
  }

  let priceE6: bigint;
  try {
    priceE6 = BigInt(initialPriceE6);
    if (priceE6 <= 0n) throw new Error("must be positive");
  } catch {
    return NextResponse.json({ error: "Invalid initialPriceE6 — must be positive bigint string" }, { status: 400 });
  }

  const assetIdx = typeof assetIndex === "number" ? assetIndex : 0;
  if (assetIdx < 0 || assetIdx > 13) {
    return NextResponse.json({ error: "assetIndex out of range [0, 13]" }, { status: 400 });
  }

  try {
    const rpcUrl = getRpcEndpoint();
    const connection = new Connection(rpcUrl, "confirmed");
    const keeperPk = new PublicKey(keeper.publicKey());

    /*
     * Preserve the creator-signature authorization boundary.
     *
     * Solana deduplicates required signer slots by public key. If the
     * requester aliases deployer to the server keeper, the keeper signature
     * can satisfy both logical signer roles and turn this response into a
     * fully signed transaction without an independent creator signature.
     */
    if (deployerPk.equals(keeperPk)) {
      return NextResponse.json(
        {
          error: "deployer must be distinct from keeper",
        },
        { status: 400 },
      );
    }

    // Fetch slot (used as initial mark timestamp in ConfigureAuthMark)
    const nowSlot = BigInt(await connection.getSlot("confirmed"));

    // Fetch recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const cfg = getConfig();
    const programId = new PublicKey(cfg.programId);

    // ── Instruction 1: ConfigureAuthMark ──────────────────────────────────────
    // Sets oracle to AUTH_MARK mode (mode=3) and records initial mark price.
    // oracle_authority at this point is `deployer` (the market admin set in InitMarket).
    const configureIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_CONFIGURE_AUTH_MARK, {
        oracleAuthority: deployerPk,
        market: slabPk,
      }),
      data: encodeConfigureAuthMark({
        assetIndex: assetIdx,
        nowSlot,
        initialMarkE6: priceE6,
      }),
    });

    // ── Instruction 2: UpdateAssetAuthority(Oracle → keeper) ─────────────────
    // Transfers oracle_authority from creator (deployer) to keeper.
    // Both current_authority (creator) and new_authority (keeper) must sign.
    const delegateIx: TransactionInstruction = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_UPDATE_AUTHORITY, {
        currentAuthority: deployerPk,
        newAuthority: keeperPk,
        slab: slabPk,
      }),
      data: encodeUpdateAssetAuthority({
        assetIndex: assetIdx,
        kind: ASSET_AUTH_KIND.Oracle,
        newPubkey: keeperPk,
      }),
    });

    // ── Build transaction ─────────────────────────────────────────────────────
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = deployerPk; // creator pays fees
    tx.add(configureIx, delegateIx);

    // Partially sign with keeper (for UpdateAssetAuthority new_authority)
    keeper.partialSign(tx);

    // Serialize (requireAllSignatures: false — creator sig is missing, wallet adds it)
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const partialTxBase64 = Buffer.from(serialized).toString("base64");

    return NextResponse.json({
      partialTxBase64,
      keeperPubkey: keeper.publicKey(),
      nowSlot: nowSlot.toString(),
    });
  } catch (err) {
    console.error("[playground/keeper-cosign] Error:", err);
    return NextResponse.json(
      { error: "Failed to build co-sign tx", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
