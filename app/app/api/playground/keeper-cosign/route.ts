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
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { readAssetMarketId, readAssetControlSeqs } from "@/lib/v18-wire";
import { MAX_PRICE_E6 } from "@/lib/oraclePrice";
import { requirePlaygroundKeeperSigner } from "@/lib/playground-keeper-signer";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { authorizeKeeperCosignV1 } from "@/lib/launch-single-tx/cosign-validate";
import { launchCreatePins, neutralFromInstructions, type LaunchCreatePins } from "@/lib/launch-single-tx/shape";
import { cosignV1RateLimited } from "@/lib/launch-single-tx/cosign-rate-limit";
import { canonicalVaultLpMatcher } from "@/lib/limits/p3-wizard";
import { getClientIp } from "@/lib/get-client-ip";
import { WELL_KNOWN } from "@percolatorct/sdk";
import type { Connection } from "@solana/web3.js";

/**
 * Asset 0's co-sign inputs on a market whose only prior tx is the launch's M1
 * (createAccount + InitMarket + SetNftProgramId), used when `fresh: true` and the
 * slab doesn't exist yet. Each is fixed by the program, not guessed:
 *   - marketId 1: the engine header starts `next_market_id` at 1 and the first
 *     asset activation (InitMarket's asset 0) takes it.
 *   - oracleObservation 0 / authorityEpoch 0: nothing in M1 advances either lane
 *     (SetNftProgramId only writes the NFT-registry PDA).
 * Measured on fresh markets: marketId=1 authEpoch=0 after InitMarket, and
 * ConfigureAuthMark then lands with observationSequence 1. If they were ever
 * wrong, the CAS makes this tx fail on-chain — it can't mis-apply.
 */
const FRESH_ASSET0 = { marketId: 1n, oracleObservation: 0n, authorityEpoch: 0n } as const;

/**
 * The co-sign pair, built in ONE place for both the legacy partial tx and the v1 single-transaction
 * check (the v1 path compares the client's message against exactly these bytes).
 */
function buildCosignPair(a: {
  programId: PublicKey;
  deployer: PublicKey;
  slab: PublicKey;
  keeper: PublicKey;
  assetIndex: number;
  marketId: bigint;
  seqs: { oracleObservation: bigint; authorityEpoch: bigint };
  nowSlot: bigint;
  priceE6: bigint;
}): { configureIx: TransactionInstruction; delegateIx: TransactionInstruction } {
  // ── Instruction 1: ConfigureAuthMark ──────────────────────────────────────
  // Sets oracle to AUTH_MARK mode (mode=3) and records initial mark price.
  // oracle_authority at this point is `deployer` (the market admin set in InitMarket).
  const configureIx = buildIx({
    programId: a.programId,
    keys: buildAccountMetas(ACCOUNTS_CONFIGURE_AUTH_MARK, {
      oracleAuthority: a.deployer,
      market: a.slab,
    }),
    data: encodeConfigureAuthMark({
      assetIndex: a.assetIndex,
      marketId: a.marketId,
      nowSlot: a.nowSlot,
      initialMarkE6: a.priceE6,
      observationSequence: a.seqs.oracleObservation + 1n,
    }),
  });

  // ── Instruction 2: UpdateAssetAuthority(Oracle → keeper) ─────────────────
  // Transfers oracle_authority from creator (deployer) to keeper.
  // Both current_authority (creator) and new_authority (keeper) must sign.
  const delegateIx: TransactionInstruction = buildIx({
    programId: a.programId,
    keys: buildAccountMetas(ACCOUNTS_UPDATE_AUTHORITY, {
      currentAuthority: a.deployer,
      newAuthority: a.keeper,
      slab: a.slab,
    }),
    data: encodeUpdateAssetAuthority({
      assetIndex: a.assetIndex,
      marketId: a.marketId,
      kind: ASSET_AUTH_KIND.Oracle,
      newPubkey: a.keeper,
      authorityEpoch: a.seqs.authorityEpoch,
    }),
  });
  return { configureIx, delegateIx };
}

/**
 * Rent-exempt minimum per account size, read from the cluster once per instance (a protocol constant for a
 * given size; the batched launch caches it the same way, hooks/useCreateMarket.ts getCachedRentExemption).
 */
const rentCache = new Map<number, bigint>();
async function rentExemptFor(connection: Connection, pins: LaunchCreatePins): Promise<Map<number, bigint>> {
  const spaces = [...new Set(Object.values(pins).map((p) => p.space))];
  await Promise.all(
    spaces.map(async (n) => {
      if (!rentCache.has(n)) rentCache.set(n, BigInt(await connection.getMinimumBalanceForRentExemption(n, "confirmed")));
    }),
  );
  return new Map(spaces.map((n) => [n, rentCache.get(n)!]));
}

/** base64 of a v1 message: <= 4096 bytes. */
const MAX_V1_MESSAGE_B64 = 5_464;

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

  const { deployer, slabAddress, initialPriceE6, assetIndex, fresh, v1MessageBase64 } = body as {
    deployer?: string;
    slabAddress?: string;
    initialPriceE6?: string;
    assetIndex?: number;
    fresh?: boolean;
    /** Single-transaction launch (Solana v1): the whole launch message the keeper is asked to sign. */
    v1MessageBase64?: unknown;
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
    // SEC: bound the caller-supplied initial mark to the protocol max — the same
    // ceiling every other price path is clamped to (lib/oraclePrice MAX_PRICE_E6).
    // Without it a creator could seed their own market's ConfigureAuthMark with an
    // absurd initial mark.
    if (priceE6 > MAX_PRICE_E6) throw new Error("exceeds max");
  } catch {
    return NextResponse.json(
      { error: `Invalid initialPriceE6 — must be a positive bigint string ≤ ${MAX_PRICE_E6} (E6)` },
      { status: 400 },
    );
  }

  const assetIdx = typeof assetIndex === "number" ? assetIndex : 0;
  if (assetIdx < 0 || assetIdx > 13) {
    return NextResponse.json({ error: "assetIndex out of range [0, 13]" }, { status: 400 });
  }
  if (fresh === true && assetIdx !== 0) {
    return NextResponse.json({ error: "fresh co-sign is only valid for asset 0" }, { status: 400 });
  }

  try {
    const connection = getServerConnection("confirmed");
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

    // ── Single-transaction launch (Solana v1) ────────────────────────────────
    // The keeper signs the WHOLE launch message, so it is validated first: strict decode, the keeper
    // only as new_authority of the one UpdateAssetAuthority (read-only signer, never the fee payer, a
    // program, or a create/transfer source), the co-sign pair byte-identical to what this route
    // builds, the exact launch shape, v1 limits. See lib/launch-single-tx/cosign-validate.ts.
    if (v1MessageBase64 !== undefined) {
      if (typeof v1MessageBase64 !== "string" || v1MessageBase64.length === 0 || v1MessageBase64.length > MAX_V1_MESSAGE_B64) {
        return NextResponse.json({ error: "Invalid v1MessageBase64" }, { status: 400 });
      }
      if (fresh !== true || assetIdx !== 0) {
        return NextResponse.json({ error: "a v1 co-sign is only valid for a fresh launch of asset 0" }, { status: 400 });
      }
      // L-3: every v1 request costs RPC reads and a keeper signature; bound it per IP and per deployer.
      const limited = cosignV1RateLimited(getClientIp(req), deployerPk.toBase58());
      if (limited) {
        return NextResponse.json({ error: `Too many v1 co-sign requests (per ${limited}); retry in a minute` }, { status: 429, headers: { "Retry-After": "60" } });
      }
      const message = new Uint8Array(Buffer.from(v1MessageBase64, "base64"));
      if (Buffer.from(message).toString("base64") !== v1MessageBase64) {
        return NextResponse.json({ error: "Invalid v1MessageBase64 (not canonical base64)" }, { status: 400 });
      }
      const cfgV1 = getConfig();
      const wrapperId = new PublicKey(cfgV1.programId);
      const stakeId = (cfgV1 as { vaultProgramId?: string }).vaultProgramId ?? DEVNET_PROGRAM_IDS.stake;
      // The single transaction CREATES the slab: an existing account means this is not a fresh launch.
      if (await connection.getAccountInfo(slabPk, "confirmed")) {
        return NextResponse.json({ error: "the slab already exists; a v1 co-sign is only for a launch that creates it" }, { status: 409 });
      }
      const currentSlot = BigInt(await connection.getSlot("confirmed"));
      let createPins: LaunchCreatePins;
      try {
        createPins = launchCreatePins({
          wrapper: wrapperId.toBase58(),
          matcher: canonicalVaultLpMatcher(cfgV1.matcherProgramId).toBase58(),
          tokenProgram: WELL_KNOWN.tokenProgram.toBase58(),
        });
      } catch (e) {
        return NextResponse.json({ error: `v1 co-sign unavailable: ${(e as Error).message}` }, { status: 503 });
      }
      const rentExemptLamports = await rentExemptFor(connection, createPins);
      const verdict = await authorizeKeeperCosignV1({
        message,
        keeper: keeperPk.toBase58(),
        deployer: deployerPk.toBase58(),
        slab: slabPk.toBase58(),
        programs: { wrapper: wrapperId.toBase58(), stake: stakeId },
        currentSlot,
        expectedCosign: (slot) => {
          const pair = buildCosignPair({
            programId: wrapperId, deployer: deployerPk, slab: slabPk, keeper: keeperPk, assetIndex: 0,
            marketId: FRESH_ASSET0.marketId, seqs: FRESH_ASSET0, nowSlot: slot, priceE6,
          });
          const [configure, delegate] = neutralFromInstructions(deployerPk, [pair.configureIx, pair.delegateIx]);
          return { configure: configure!, delegate: delegate! };
        },
        createPins,
        rentExemptLamports,
        // L-2: never sign a message whose lifetime cannot land (or that was built on a stale/forged hash).
        isBlockhashValid: async (bh) => (await connection.isBlockhashValid(bh, { commitment: "confirmed" })).value,
      });
      if (!verdict.ok) {
        console.warn("[playground/keeper-cosign] v1 co-sign refused:", verdict.reason);
        return NextResponse.json({ error: `v1 co-sign refused: ${verdict.reason}` }, { status: 422 });
      }
      const sig = keeper.signMessageBytes(verdict.message);
      return NextResponse.json({
        keeperSignatureBase64: Buffer.from(sig).toString("base64"),
        keeperPubkey: keeper.publicKey(),
        nowSlot: verdict.message.nowSlot.toString(),
      });
    }

    // Fetch slot (used as initial mark timestamp in ConfigureAuthMark)
    const nowSlot = BigInt(await connection.getSlot("confirmed"));

    // Fetch recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const cfg = getConfig();
    const programId = new PublicKey(cfg.programId);

    // v18: ConfigureAuthMark and UpdateAssetAuthority bind the asset's market_id and
    // their replay lanes — live-read from the market. observation_sequence is the
    // oracle-observation nonce + 1 (strictly-increasing); authority_epoch is the CAS
    // CURRENT value (not +1). ConfigureAuthMark advances the oracle-observation lane
    // but NOT the authority-epoch lane, so both reads come from one pre-tx snapshot.
    const slabInfo = await connection.getAccountInfo(slabPk, "confirmed");
    let cosignMarketId: bigint;
    let cosignSeqs: { oracleObservation: bigint; authorityEpoch: bigint };
    if (slabInfo?.data) {
      // The market exists: always bind to its live state.
      const slabData = new Uint8Array(slabInfo.data);
      cosignMarketId = readAssetMarketId(slabData, assetIdx);
      cosignSeqs = readAssetControlSeqs(slabData, assetIdx);
    } else if (fresh === true) {
      // One-approval launch: the client signs [M1, this co-sign tx, M2, …] in a
      // single wallet approval BEFORE M1 (createAccount + InitMarket +
      // SetNftProgramId) has landed, so there is no slab to read yet. This tx
      // lands right after M1, when asset 0's values are fixed by construction.
      cosignMarketId = FRESH_ASSET0.marketId;
      cosignSeqs = FRESH_ASSET0;
    } else {
      return NextResponse.json({ error: "market account not found" }, { status: 404 });
    }

    const { configureIx, delegateIx } = buildCosignPair({
      programId, deployer: deployerPk, slab: slabPk, keeper: keeperPk, assetIndex: assetIdx,
      marketId: cosignMarketId, seqs: cosignSeqs, nowSlot, priceE6,
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
