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
import {
  encodeKeeperCrank,
  encodePushOraclePrice,
  buildAccountMetas,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildIx,
  fetchSlab,
  parseHeader,
  parseConfig,
  derivePythPushOraclePDA,
} from "@percolator/core";

// Rate limiting: max 1 crank per slab per 10 seconds
const lastCrankMap = new Map<string, number>();

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

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> },
) {
  if (!requireAuth(req)) return UNAUTHORIZED;
  const { slab: slabStr } = await params;

  const payer = getKeypair();
  if (!payer) {
    return NextResponse.json(
      { success: false, error: "Crank service not configured" },
      { status: 503 },
    );
  }

  // Rate limit
  const now = Date.now();
  const last = lastCrankMap.get(slabStr) ?? 0;
  if (now - last < 10_000) {
    return NextResponse.json(
      { success: false, error: "Rate limited — max 1 crank per slab per 10 seconds" },
      { status: 429 },
    );
  }

  let slabPk: PublicKey;
  try {
    slabPk = new PublicKey(slabStr);
  } catch {
    return NextResponse.json({ success: false, error: "Invalid slab address" }, { status: 400 });
  }

  const connection = getConnection();
  const programId = getProgramId();

  try {
    const data = await fetchSlab(connection, slabPk);
    const header = parseHeader(data);
    const config = parseConfig(data);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));

    let oracleAccount: PublicKey;

    if (isAdminOracle(config.indexFeedId)) {
      // Admin oracle: push price first
      const price = await fetchDexScreenerPrice(config.collateralMint.toBase58());
      const priceE6 = Math.max(Math.round(price * 1_000_000), 1);
      const ts = Math.floor(Date.now() / 1000);

      const pushData = encodePushOraclePrice({
        priceE6: priceE6.toString(),
        timestamp: ts.toString(),
      });
      const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
        payer.publicKey,
        slabPk,
      ]);
      tx.add(buildIx({ programId, keys: pushKeys, data: pushData }));

      oracleAccount = slabPk; // self-referential for admin oracle
    } else {
      // Pyth oracle
      const feedIdHex = Buffer.from(config.indexFeedId.toBytes()).toString("hex");
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

    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
      skipPreflight: true,
    });

    lastCrankMap.set(slabStr, Date.now());

    const slot = await connection.getSlot("confirmed");

    return NextResponse.json({ success: true, signature: sig, slot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
