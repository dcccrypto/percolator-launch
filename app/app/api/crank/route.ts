import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export const dynamic = 'force-dynamic';
import {
  encodeKeeperCrank,
  encodePushOraclePrice,
  buildAccountMetas,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildIx,
  discoverMarkets,
  derivePythPushOraclePDA,
  type DiscoveredMarket,
} from "@percolator/core";

const ALL_ZEROS = new PublicKey("11111111111111111111111111111111");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(str: string): Uint8Array {
  const bytes: number[] = [];
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error("Invalid base58 character");
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function getKeypair(): Keypair | null {
  const raw = process.env.CRANK_KEYPAIR;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(decodeBase58(raw));
  } catch {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {
      return null;
    }
  }
}

function getConnection(): Connection {
  const url =
    process.env.SOLANA_RPC_URL ||
    `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`;
  return new Connection(url, "confirmed");
}

function getProgramId(): PublicKey {
  return new PublicKey(
    process.env.PROGRAM_ID || "EXsr2Tfz8ntWYP3vgCStdknFBoafvJQugJKAh4nFdo8f",
  );
}

function isAdminOracle(feedId: PublicKey): boolean {
  return feedId.equals(ALL_ZEROS) || feedId.equals(PublicKey.default);
}

async function fetchDexScreenerPrice(mint: string): Promise<number> {
  const resp = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    { headers: { "User-Agent": "percolator-crank/1.0" }, signal: AbortSignal.timeout(5000) },
  );
  const json = (await resp.json()) as Record<string, unknown>;
  const pairs = (json.pairs || []) as Array<{ priceUsd: string; liquidity?: { usd: number } }>;
  if (!pairs.length) throw new Error("No pairs found");
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return parseFloat(pairs[0].priceUsd);
}

// In-memory cache of last crank results
const lastCrankResults = new Map<string, { slot: number; timestamp: number; signature: string }>();

/**
 * GET /api/crank — list all markets and their last crank info
 */
export async function GET() {
  const connection = getConnection();
  const programId = getProgramId();

  try {
    const markets = await discoverMarkets(connection, programId);
    const result = markets.map((m) => {
      const addr = m.slabAddress.toBase58();
      const cached = lastCrankResults.get(addr);
      return {
        slab: addr,
        admin: m.header.admin.toBase58(),
        mint: m.config.collateralMint.toBase58(),
        lastCrankSlot: Number(m.engine.lastCrankSlot),
        lastApiCrank: cached
          ? { slot: cached.slot, timestamp: cached.timestamp, signature: cached.signature }
          : null,
      };
    });
    return NextResponse.json({ markets: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/crank — crank ALL discovered markets (batch)
 */
export async function POST(req: NextRequest) {
  // Auth check — prevent anyone from draining crank wallet SOL
  const apiKey = process.env.INDEXER_API_KEY;
  if (apiKey) {
    const provided = req.headers.get("x-api-key");
    if (!provided || provided !== apiKey) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const payer = getKeypair();
  if (!payer) {
    return NextResponse.json(
      { success: false, error: "Crank service not configured" },
      { status: 503 },
    );
  }

  const connection = getConnection();
  const programId = getProgramId();

  try {
    const markets = await discoverMarkets(connection, programId);
    const results: Array<{
      slab: string;
      success: boolean;
      signature?: string;
      error?: string;
    }> = [];

    for (const market of markets) {
      const addr = market.slabAddress.toBase58();
      try {
        const sig = await crankSingleMarket(connection, programId, payer, market);
        const slot = await connection.getSlot("confirmed");
        lastCrankResults.set(addr, { slot, timestamp: Date.now(), signature: sig });
        results.push({ slab: addr, success: true, signature: sig });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ slab: addr, success: false, error: message });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function crankSingleMarket(
  connection: Connection,
  programId: PublicKey,
  payer: Keypair,
  market: DiscoveredMarket,
): Promise<string> {
  const slabPk = market.slabAddress;
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));

  let oracleAccount: PublicKey;

  if (isAdminOracle(market.config.indexFeedId)) {
    if (!market.config.oracleAuthority.equals(payer.publicKey)) {
      // R2-S3: Not the oracle authority — skip price push
      oracleAccount = slabPk;
    } else {
      const price = await fetchDexScreenerPrice(market.config.collateralMint.toBase58());
      const priceE6 = Math.max(Math.round(price * 1_000_000), 1);
      const ts = Math.floor(Date.now() / 1000);

      const pushData = encodePushOraclePrice({
        priceE6: priceE6.toString(),
        timestamp: ts.toString(),
      });
      const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slabPk]);
      tx.add(buildIx({ programId, keys: pushKeys, data: pushData }));

      oracleAccount = slabPk;
    }
  } else {
    const feedIdHex = Buffer.from(market.config.indexFeedId.toBytes()).toString("hex");
    const [pythPDA] = derivePythPushOraclePDA(feedIdHex);
    oracleAccount = pythPDA;
  }

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    slabPk,
    SYSVAR_CLOCK_PUBKEY,
    oracleAccount,
  ]);
  tx.add(buildIx({ programId, keys: crankKeys, data: crankData }));

  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
    skipPreflight: true,
  });
}
