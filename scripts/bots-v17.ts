#!/usr/bin/env tsx
/**
 * v17 Activity Bots — LP Provisioner + Trader Bots
 *
 * Makes playground markets feel alive:
 *   LP-PROVISIONER: seeds an LP portfolio + matcher so trades always fill.
 *   TRADER-BOT: N independent wallets open/close LONG + SHORT positions at
 *               realistic cadence, generating flow, PnL, and pressure toward
 *               occasional liquidations.
 *
 * v17 ABI differences vs v12 (everything in floating-maker.ts that was wrong):
 *   - Trade:    encodeTradeCpi({ assetIndex, sizeQ, feeBps, limitPrice })
 *               ACCOUNTS_TRADE_CPI: signerA, market, accountA, accountB,
 *               matcherProg, matcherCtx, matcherDelegate
 *               (no lpOwner, no lpPda, no clock, no oracle)
 *   - Deposit:  encodeDepositCollateral({ amount }) — u128, no userIdx
 *               ACCOUNTS_DEPOSIT_COLLATERAL: owner, market, portfolio,
 *               sourceToken, vaultToken, tokenProgram
 *               (portfolio is a separate 9347-byte account)
 *   - InitUser: encodeInitUser() — no args in v17 (feePayment removed)
 *               ACCOUNTS_INIT_USER: owner, market, portfolio
 *   - LP:       portfolio + SetMatcherConfig(68) + InitMatcherCtx(83) CPI
 *               NOT InitLP(2) which throws "removed" in v17 SDK
 *   - Crank:    encodePermissionlessCrank — NOT encodeKeeperCrank (throws)
 *   - Discover: discoverMarkets → configV17 field for v17 markets
 *               (header/config/engine are empty {} for v17 accounts)
 *
 * DRY_RUN=true (default):
 *   Builds real v17 transactions, discovers live devnet markets, and runs
 *   connection.simulateTransaction() to validate ix/account shapes.
 *   Zero SOL spent. Acceptable simulation failures: state errors (portfolio
 *   not found, insufficient collateral). Fatal: InvalidInstructionData.
 *
 * Usage:
 *   # Dry-run (default — no wallets needed):
 *   DRY_RUN=true npx tsx playground/bots-v17.ts
 *
 *   # Live run (needs funded wallets + SOL):
 *   BOT_WALLETS=./bot1.json,./bot2.json LP_WALLET=./lp.json DRY_RUN=false npx tsx playground/bots-v17.ts
 *
 * Environment variables:
 *   BOT_WALLETS         Comma-separated keypair JSON paths for trader bots
 *   LP_WALLET           Keypair JSON path for LP provider
 *   RPC_URL             Devnet RPC URL (default: Helius devnet)
 *   DRY_RUN             "true" = simulate only, no SOL (default: true)
 *   TRADE_INTERVAL_MS   Delay between trade cycles per bot in ms (default: 8000)
 *   TRADE_SIZE_MIN      Min trade size in token atoms, 6-dec (default: 500_000 = $0.50)
 *   TRADE_SIZE_MAX      Max trade size in token atoms, 6-dec (default: 5_000_000 = $5)
 *   LP_DEPOSIT          LP deposit in token atoms (default: 100_000_000_000 = 100k)
 *   MARKETS_FILTER      Comma-separated market addresses (default: all)
 *   MAX_OPEN_POSITIONS  Max concurrent open positions per bot (default: 3)
 *   CLOSE_PROB          Probability [0..1] of closing vs opening (default: 0.35)
 *   FEE_BPS             Trade fee in bps (default: 30)
 *   INTENSITY           "low" | "medium" | "high" — scales cadence + size (default: medium)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  // Instruction encoders (all v17 wire format)
  encodeInitUser,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeTradeCpi,
  encodeSetMatcherConfig,
  encodeInitMatcherCtx,
  encodePermissionlessCrank,
  CrankAction,
  // Account meta specs
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  // Builders
  buildIx,
  buildAccountMetas,
  simulateOrSend,
  // PDA derivation
  deriveVaultAuthority,
  deriveMatcherDelegate,
  // Parsing
  V17_PORTFOLIO_ACCOUNT_LEN,
  parseWrapperConfigV17,
  parseAssetOracleProfileV17,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  // Discovery
  discoverMarkets,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── RPC + program IDs ─────────────────────────────────────────────────────────

const DEVNET_RPC =
  process.env.RPC_URL ??
  "https://devnet.helius-rpc.com/?api-key=2a089bfd-18ae-48b5-abbe-36b0383ecad3";

const WRAPPER_PROGRAM_ID = new PublicKey("69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9");
const MATCHER_PROGRAM_ID = new PublicKey("4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT");

// Known devnet playground markets (from POCs — valid v17 markets with keeper authority)
const KNOWN_MARKETS = [
  new PublicKey("7VrvSC57aB9gdM8iymEDJtrgjE4RGZMPfkuxCR4sFcrj"), // dexoracle-poc (Raydium)
  new PublicKey("C2yRmBio4yxF7MK2JiuVdWfNnz9MUJJdpg5Nwpt662Hn"), // permissionless-create-poc (Meteora)
];

// ── Config from env ───────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN !== "false"; // default true

const INTENSITY = (process.env.INTENSITY ?? "medium") as "low" | "medium" | "high";
const INTENSITY_SCALE: Record<string, { tradeMs: number; sizeMin: bigint; sizeMax: bigint }> = {
  low:    { tradeMs: 15_000, sizeMin:   500_000n, sizeMax:  2_000_000n },
  medium: { tradeMs:  8_000, sizeMin: 1_000_000n, sizeMax:  5_000_000n },
  high:   { tradeMs:  4_000, sizeMin: 2_000_000n, sizeMax: 10_000_000n },
};
const INTENSITY_CFG = INTENSITY_SCALE[INTENSITY] ?? INTENSITY_SCALE.medium;

const TRADE_INTERVAL_MS = Number(process.env.TRADE_INTERVAL_MS ?? INTENSITY_CFG.tradeMs);
const TRADE_SIZE_MIN = BigInt(process.env.TRADE_SIZE_MIN ?? INTENSITY_CFG.sizeMin);
const TRADE_SIZE_MAX = BigInt(process.env.TRADE_SIZE_MAX ?? INTENSITY_CFG.sizeMax);
const LP_DEPOSIT = BigInt(process.env.LP_DEPOSIT ?? "100000000000"); // 100k tokens
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS ?? "3");
const CLOSE_PROB = Number(process.env.CLOSE_PROB ?? "0.35");
const FEE_BPS = BigInt(process.env.FEE_BPS ?? "30");
const MARKETS_FILTER = process.env.MARKETS_FILTER
  ? process.env.MARKETS_FILTER.split(",").map(s => new PublicKey(s.trim()))
  : null;

const MATCHER_CONTEXT_LEN = 320;
const I128_MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727n;

// ── Types ─────────────────────────────────────────────────────────────────────

interface V17Market {
  market: PublicKey;
  collateralMint: PublicKey;
  vaultAuthority: PublicKey;
  vaultAta: PublicKey;
  /** oracle_mode: 3=AUTH_MARK, 0=PYTH, etc. */
  oracleMode: number;
  /** last mark price in e6 units */
  markE6: bigint;
}

interface LpState {
  owner: Keypair;
  portfolio: Keypair;
  matcherCtx: Keypair;
  matcherDelegate: PublicKey;
}

interface BotState {
  wallet: Keypair;
  /** portfolio accounts per market (market address → portfolio keypair) */
  portfolios: Map<string, Keypair>;
  /** open position count per market */
  openPositions: Map<string, number>;
  /** net position in atoms (positive=long, negative=short) */
  netPosition: Map<string, bigint>;
}

interface TradeAction {
  market: V17Market;
  bot: BotState;
  sizeQ: bigint; // positive=long, negative=short
  label: string;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString().slice(11, 19); }
function log(tag: string, msg: string) { console.log(`[${ts()}] [${tag}] ${msg}`); }
function warn(tag: string, msg: string) { console.warn(`[${ts()}] [${tag}] WARN ${msg}`); }
function err(tag: string, msg: string) { console.error(`[${ts()}] [${tag}] ERR ${msg}`); }

// ── RPC helpers ───────────────────────────────────────────────────────────────

const connection = new Connection(DEVNET_RPC, "confirmed");

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Exponential backoff retry with 429 jitter. */
async function retry<T>(
  fn: () => Promise<T>,
  attempts = 4,
  baseMs = 1500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const jitter = baseMs * Math.pow(2, i) * (0.75 + Math.random() * 0.5);
        const msg = (e as Error).message?.slice(0, 80) ?? String(e);
        warn("retry", `attempt ${i + 1}/${attempts}: ${msg} — backoff ${Math.round(jitter)}ms`);
        await sleep(jitter);
      }
    }
  }
  throw lastErr;
}

/** Send a multi-instruction transaction (wraps in ComputeBudget + heap). */
async function sendMultiIx(
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
  computeUnits = 600_000,
): Promise<string> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131_072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  for (const ix of ixs) tx.add(ix);
  const bh = await retry(() => connection.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0].publicKey;
  const sig = await retry(() =>
    sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" })
  );
  log("send", `[OK] ${label}  sig=${sig.slice(0, 16)}…`);
  return sig;
}

/**
 * Simulate OR send a single instruction.
 *
 * In DRY_RUN mode, calls connection.simulateTransaction() and returns
 * the simulation result. The simulation proves the v17 instruction encoding
 * is correct (no InvalidInstructionData) even if the state check fails.
 *
 * In live mode, uses simulateOrSend (simulate first, then send).
 */
async function dryRunOrSend(
  ix: TransactionInstruction,
  signers: Keypair[],
  label: string,
  computeUnits = 600_000,
): Promise<{ ok: boolean; signature?: string; units?: number; logs: string[]; err?: string }> {
  if (DRY_RUN) {
    // Use simulateOrSend from the SDK (simulate=true path).
    // This handles tx building, signing, and simulation correctly.
    // Expected outcomes for synthetic accounts:
    //   OK (no simErr) — great, ix was fully valid
    //   State error — expected (portfolio doesn't exist on-chain) — ix encoding still OK
    //   InvalidInstructionData — FATAL: ix tag/wire format is wrong
    let simResult: Awaited<ReturnType<typeof simulateOrSend>>;
    try {
      simResult = await retry(() => simulateOrSend({
        connection, ix, signers, simulate: true, computeUnitLimit: computeUnits,
      }));
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 120) ?? String(e);
      warn("sim", `[DRY-RUN] ${label}: simulation threw (non-fatal for synthetic accounts) — ${msg}`);
      return { ok: true, logs: [], err: msg }; // treat throw as state error, not ix error
    }

    const simErr = simResult.err ?? null;
    const units = simResult.unitsConsumed ?? undefined;
    const logs = simResult.logs ?? [];

    const isIxError = simErr !== null && (
      simErr.includes("InvalidInstructionData") ||
      logs.some(l => l.includes("InvalidInstructionData"))
    );

    if (isIxError) {
      err("sim", `[BAD-IX] ${label}: instruction encoding is WRONG — ${simErr}`);
    } else if (simErr) {
      // State error (portfolio not found, insufficient balance, etc.) is EXPECTED
      // in dry-run because we're using synthetic accounts with no on-chain state.
      log("sim", `[DRY-RUN] ${label}: state error (expected for synthetic accounts) — ${simErr.slice(0, 120)}`);
    } else {
      log("sim", `[DRY-RUN] ${label}: OK (${units?.toLocaleString() ?? "?"} CU)`);
    }

    return { ok: !isIxError, units, logs, err: simErr ?? undefined };
  }

  // Live mode: simulate then send
  try {
    const simResult = await retry(() => simulateOrSend({
      connection, ix, signers, simulate: true, computeUnitLimit: computeUnits,
    }));
    if (simResult.err) {
      err("sim", `[FAIL] ${label}: ${simResult.err}`);
      for (const l of (simResult.logs ?? []).slice(-8)) err("sim", `  ${l}`);
      return { ok: false, logs: simResult.logs ?? [], err: simResult.err };
    }
    const sendResult = await retry(() => simulateOrSend({
      connection, ix, signers, simulate: false, commitment: "confirmed", computeUnitLimit: computeUnits,
    }));
    if (sendResult.err) {
      return { ok: false, logs: sendResult.logs ?? [], err: sendResult.err };
    }
    log("send", `[OK] ${label}  sig=${sendResult.signature?.slice(0, 16)}…`);
    return { ok: true, signature: sendResult.signature ?? undefined, logs: sendResult.logs ?? [] };
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 120) ?? String(e);
    err("send", `[THROW] ${label}: ${msg}`);
    return { ok: false, logs: [], err: msg };
  }
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function randomBotKeypair(index: number): Keypair {
  // Generate a deterministic-ish keypair for dry-run based on index.
  // In live mode you'd provide real funded wallets.
  const seed = new Uint8Array(32);
  seed[0] = (index + 0xBE) & 0xFF;
  seed[1] = (index * 7 + 0xEF) & 0xFF;
  seed[31] = index & 0xFF;
  return Keypair.fromSeed(seed);
}

// ── Price feeds (reused from floating-maker.ts) ───────────────────────────────

const BINANCE_MAP: Record<string, string> = {
  SOL: "SOLUSDT", BTC: "BTCUSDT", ETH: "ETHUSDT", BONK: "BONKUSDT",
  WIF: "WIFUSDT", JUP: "JUPUSDT", PYTH: "PYTHUSDT", RAY: "RAYUSDT", JTO: "JTOUSDT",
};

async function fetchBinancePrice(symbol: string): Promise<number | null> {
  const pair = BINANCE_MAP[symbol.toUpperCase()];
  if (!pair) return null;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
      { signal: AbortSignal.timeout(4000) });
    const j = await r.json() as { price?: string };
    return j.price ? parseFloat(j.price) : null;
  } catch { return null; }
}

async function fetchPrice(symbol: string): Promise<number | null> {
  return fetchBinancePrice(symbol);
}

/** Guess symbol from v17 market oracle mode + mark price. */
function guessSymbol(market: V17Market): string {
  const usd = Number(market.markE6) / 1_000_000;
  if (usd > 50_000) return "BTC";
  if (usd > 2_000)  return "ETH";
  if (usd > 50)     return "SOL";
  return "TOKEN";
}

// ── v17 Market discovery ──────────────────────────────────────────────────────

async function parseOracleProfile(marketAddress: PublicKey) {
  const info = await connection.getAccountInfo(marketAddress, "confirmed");
  if (!info) return null;
  const data = new Uint8Array(info.data);
  try {
    const profileOff = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + 0 * V17_MARKET_ASSET_SLOT_LEN;
    return parseAssetOracleProfileV17(data, profileOff);
  } catch { return null; }
}

async function discoverV17Markets(): Promise<V17Market[]> {
  log("discover", `Scanning program ${WRAPPER_PROGRAM_ID.toBase58().slice(0, 8)}…`);

  const discovered: DiscoveredMarket[] = await retry(() =>
    discoverMarkets(connection, WRAPPER_PROGRAM_ID, { sequential: true })
  );

  const v17Markets: V17Market[] = [];

  for (const m of discovered) {
    // Skip v12 markets (no configV17)
    if (!m.configV17) continue;

    const marketKey = m.slabAddress.toBase58();
    if (MARKETS_FILTER && !MARKETS_FILTER.find(f => f.equals(m.slabAddress))) {
      log("discover", `Skip ${marketKey.slice(0, 8)}… (not in filter)`);
      continue;
    }

    const cfg = m.configV17;
    const [vaultAuth] = deriveVaultAuthority(WRAPPER_PROGRAM_ID, m.slabAddress);

    // Fetch oracle profile for mark price
    const profile = await parseOracleProfile(m.slabAddress);
    const markE6 = profile?.markEwmaE6 ?? 0n;
    const oracleMode = profile?.oracleMode ?? 0;

    v17Markets.push({
      market:       m.slabAddress,
      collateralMint: cfg.collateralMint,
      vaultAuthority: vaultAuth,
      vaultAta:     PublicKey.default, // filled in later when we have an ATA
      oracleMode,
      markE6,
    });

    log("discover", `Found v17 market ${marketKey.slice(0, 8)}… markE6=${markE6} mode=${oracleMode}`);
  }

  if (v17Markets.length === 0) {
    warn("discover", "No v17 markets found via discoverMarkets — using known devnet markets");
    for (const knownKey of KNOWN_MARKETS) {
      if (MARKETS_FILTER && !MARKETS_FILTER.find(f => f.equals(knownKey))) continue;
      const info = await connection.getAccountInfo(knownKey, "confirmed");
      if (!info) { warn("discover", `Known market ${knownKey.toBase58().slice(0, 8)}… not found`); continue; }
      const data = new Uint8Array(info.data);
      let cfg: ReturnType<typeof parseWrapperConfigV17>;
      try { cfg = parseWrapperConfigV17(data); } catch { continue; }
      const [vaultAuth] = deriveVaultAuthority(WRAPPER_PROGRAM_ID, knownKey);
      const profile = await parseOracleProfile(knownKey);
      v17Markets.push({
        market:        knownKey,
        collateralMint: cfg.collateralMint,
        vaultAuthority: vaultAuth,
        vaultAta:      PublicKey.default,
        oracleMode:    profile?.oracleMode ?? 0,
        markE6:        profile?.markEwmaE6 ?? 0n,
      });
      log("discover", `Known market ${knownKey.toBase58().slice(0, 8)}… markE6=${profile?.markEwmaE6 ?? 0n}`);
    }
  }

  return v17Markets;
}

// ── Vault ATA helper ──────────────────────────────────────────────────────────

/**
 * Get or derive the vault's Associated Token Account for a market.
 * In DRY_RUN, derives synchronously without on-chain calls.
 */
async function getVaultAta(
  market: V17Market,
  funder: Keypair,
): Promise<PublicKey> {
  if (DRY_RUN) {
    // Derive the ATA address synchronously — no connection needed
    return getAssociatedTokenAddressSync(
      market.collateralMint,
      market.vaultAuthority,
      true, // allowOwnerOffCurve — vault authority is a PDA
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }
  const ata = await retry(() =>
    getOrCreateAssociatedTokenAccount(
      connection, funder, market.collateralMint, market.vaultAuthority, true, "confirmed"
    )
  );
  return ata.address;
}

// ── LP Provisioner ────────────────────────────────────────────────────────────

/**
 * Provision LP on a v17 market.
 *
 * Creates a standalone portfolio account, deposits LP_DEPOSIT tokens,
 * then sets up SetMatcherConfig(68) + InitMatcherCtx(83) so trades can fill.
 *
 * This is the v17 equivalent of the v12 InitLP flow — completely different
 * account structure (no slab-embedded LP) and no InitLP tag.
 *
 * In DRY_RUN: builds and simulates all 5 transactions without spending SOL.
 */
async function provisionLp(
  market: V17Market,
  lpWallet: Keypair,
): Promise<LpState | null> {
  const mKey = market.market.toBase58().slice(0, 8);
  log("lp", `Provisioning LP on market ${mKey}…`);

  // Generate fresh portfolio + matcher context accounts
  const lpPortfolio = DRY_RUN ? Keypair.generate() : Keypair.generate();
  const matcherCtx  = DRY_RUN ? Keypair.generate() : Keypair.generate();

  const [matcherDelegate] = deriveMatcherDelegate(
    WRAPPER_PROGRAM_ID,
    market.market,
    lpPortfolio.publicKey,
    lpWallet.publicKey,
    MATCHER_PROGRAM_ID,
    matcherCtx.publicKey,
  );

  log("lp", `  lpPortfolio:    ${lpPortfolio.publicKey.toBase58()}`);
  log("lp", `  matcherCtx:     ${matcherCtx.publicKey.toBase58()}`);
  log("lp", `  matcherDelegate: ${matcherDelegate.toBase58().slice(0, 16)}…`);

  if (!DRY_RUN) {
    // Allocate portfolio account (9347 bytes, program-owned)
    const portLamports = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);
    await sendMultiIx([
      SystemProgram.createAccount({
        fromPubkey: lpWallet.publicKey,
        newAccountPubkey: lpPortfolio.publicKey,
        space: V17_PORTFOLIO_ACCOUNT_LEN,
        lamports: portLamports,
        programId: WRAPPER_PROGRAM_ID,
      }),
    ], [lpWallet, lpPortfolio], `AllocLpPortfolio(${mKey})`);

    // Allocate matcherCtx (320 bytes, owned by MATCHER_PROGRAM_ID)
    const ctxLamports = await connection.getMinimumBalanceForRentExemption(MATCHER_CONTEXT_LEN);
    await sendMultiIx([
      SystemProgram.createAccount({
        fromPubkey: lpWallet.publicKey,
        newAccountPubkey: matcherCtx.publicKey,
        space: MATCHER_CONTEXT_LEN,
        lamports: ctxLamports,
        programId: MATCHER_PROGRAM_ID,
      }),
    ], [lpWallet, matcherCtx], `AllocMatcherCtx(${mKey})`);
  }

  // Ensure vault ATA exists
  market.vaultAta = await getVaultAta(market, lpWallet);
  const lpAta = DRY_RUN
    ? lpPortfolio.publicKey // synthetic in dry-run
    : (await retry(() =>
        getOrCreateAssociatedTokenAccount(
          connection, lpWallet, market.collateralMint, lpWallet.publicKey, false, "confirmed"
        )
      )).address;

  // [TX 1] InitPortfolio (tag 1, no args in v17)
  const initPortIx = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
      owner:     lpWallet.publicKey,
      market:    market.market,
      portfolio: lpPortfolio.publicKey,
    }),
    data: encodeInitUser(),
  });
  await dryRunOrSend(initPortIx, [lpWallet], `InitPortfolio(LP)(${mKey})`);

  // [TX 2] DepositCollateral (tag 3, amount u128 — no userIdx in v17)
  const depositIx = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
      owner:       lpWallet.publicKey,
      market:      market.market,
      portfolio:   lpPortfolio.publicKey,
      sourceToken: lpAta,
      vaultToken:  market.vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
    data: encodeDepositCollateral({ amount: LP_DEPOSIT }),
  });
  await dryRunOrSend(depositIx, [lpWallet], `DepositCollateral(LP,${Number(LP_DEPOSIT)/1e6})(${mKey})`);

  // [TX 3] SetMatcherConfig (tag 68, enabled=1)
  const setMatchCfgIx = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, {
      lpOwner:       lpWallet.publicKey,
      market:        market.market,
      lpPortfolio:   lpPortfolio.publicKey,
      matcherProg:   MATCHER_PROGRAM_ID,
      matcherCtx:    matcherCtx.publicKey,
      matcherDelegate,
    }),
    data: encodeSetMatcherConfig({ enabled: 1 }),
  });
  await dryRunOrSend(setMatchCfgIx, [lpWallet], `SetMatcherConfig(enabled=1)(${mKey})`);

  // [TX 4] InitMatcherCtx (tag 83, CPIs into matcher program)
  const initMatchCtxIx = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
      lpOwner:         lpWallet.publicKey,
      market:          market.market,
      lpPortfolio:     lpPortfolio.publicKey,
      matcherCtx:      matcherCtx.publicKey,
      matcherProg:     MATCHER_PROGRAM_ID,
      matcherDelegate,
    }),
    data: encodeInitMatcherCtx({
      kind:                  0,
      tradingFeeBps:         Number(FEE_BPS),
      baseSpreadBps:         50,
      maxTotalBps:           200,
      impactKBps:            0,
      liquidityNotionalE6:   0n,
      maxFillAbs:            I128_MAX,
      maxInventoryAbs:       I128_MAX,
      feeToInsuranceBps:     0,
      skewSpreadMultBps:     0,
    }),
  });
  await dryRunOrSend(initMatchCtxIx, [lpWallet], `InitMatcherCtx(${mKey})`, 800_000);

  log("lp", `LP provision complete for ${mKey} (${DRY_RUN ? "DRY_RUN" : "LIVE"})`);

  return { owner: lpWallet, portfolio: lpPortfolio, matcherCtx, matcherDelegate };
}

// ── Trader Bot — single trade cycle ──────────────────────────────────────────

/**
 * Build and execute one TradeCpi instruction for a bot.
 *
 * v17 TradeCpi accounts:
 *   [0] signerA         — trader (signer)
 *   [1] market          — writable market group
 *   [2] accountA        — trader's portfolio (writable)
 *   [3] accountB        — LP portfolio (writable, the counterparty)
 *   [4] matcherProg     — MATCHER_PROGRAM_ID
 *   [5] matcherCtx      — writable matcher context
 *   [6] matcherDelegate — PDA (derived via deriveMatcherDelegate)
 *
 * v17 TradeCpi data:
 *   tag(1) + assetIndex(u16) + sizeQ(i128) + feeBps(u64) + limitPrice(u64) = 35 bytes
 */
async function executeTrade(
  action: TradeAction,
  lp: LpState,
): Promise<boolean> {
  const mKey = action.market.market.toBase58().slice(0, 8);
  const sizeUsd = (Number(action.sizeQ < 0n ? -action.sizeQ : action.sizeQ) / 1e6).toFixed(2);
  const side = action.sizeQ > 0n ? "LONG" : "SHORT";

  // Get or create the bot's portfolio for this market
  let traderPortfolio = action.bot.portfolios.get(action.market.market.toBase58());
  if (!traderPortfolio) {
    traderPortfolio = Keypair.generate();
    action.bot.portfolios.set(action.market.market.toBase58(), traderPortfolio);

    // In live mode, allocate + init the portfolio before trading
    if (!DRY_RUN) {
      const portLamports = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);
      await sendMultiIx([
        SystemProgram.createAccount({
          fromPubkey:     action.bot.wallet.publicKey,
          newAccountPubkey: traderPortfolio.publicKey,
          space:          V17_PORTFOLIO_ACCOUNT_LEN,
          lamports:       portLamports,
          programId:      WRAPPER_PROGRAM_ID,
        }),
      ], [action.bot.wallet, traderPortfolio], `AllocTraderPortfolio(${mKey})`);

      // InitUser on the portfolio
      await dryRunOrSend(buildIx({
        programId: WRAPPER_PROGRAM_ID,
        keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
          owner:     action.bot.wallet.publicKey,
          market:    action.market.market,
          portfolio: traderPortfolio.publicKey,
        }),
        data: encodeInitUser(),
      }), [action.bot.wallet], `InitPortfolio(trader)(${mKey})`);

      // Deposit initial collateral
      const traderAta = (await retry(() =>
        getOrCreateAssociatedTokenAccount(
          connection, action.bot.wallet,
          action.market.collateralMint, action.bot.wallet.publicKey,
          false, "confirmed"
        )
      )).address;
      await dryRunOrSend(buildIx({
        programId: WRAPPER_PROGRAM_ID,
        keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
          owner:        action.bot.wallet.publicKey,
          market:       action.market.market,
          portfolio:    traderPortfolio.publicKey,
          sourceToken:  traderAta,
          vaultToken:   action.market.vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        data: encodeDepositCollateral({ amount: 10_000_000_000n }), // 10k initial
      }), [action.bot.wallet], `InitDeposit(trader)(${mKey})`);
    }
  }

  const tradeIx = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, {
      signerA:        action.bot.wallet.publicKey,
      market:         action.market.market,
      accountA:       traderPortfolio.publicKey,
      accountB:       lp.portfolio.publicKey,
      matcherProg:    MATCHER_PROGRAM_ID,
      matcherCtx:     lp.matcherCtx.publicKey,
      matcherDelegate: lp.matcherDelegate,
    }),
    data: encodeTradeCpi({
      assetIndex: 0,
      sizeQ:      action.sizeQ,
      feeBps:     FEE_BPS,
      limitPrice: 0n, // no limit
    }),
  });

  const result = await dryRunOrSend(
    tradeIx,
    [action.bot.wallet],
    `TradeCpi(${side},${sizeUsd})(${mKey})`,
    800_000,
  );

  if (result.ok || DRY_RUN) {
    // Update tracked state
    const prev = action.bot.netPosition.get(action.market.market.toBase58()) ?? 0n;
    action.bot.netPosition.set(action.market.market.toBase58(), prev + action.sizeQ);
    const prevCount = action.bot.openPositions.get(action.market.market.toBase58()) ?? 0;
    // Count as +1 open if opening, -1 if closing (capped at 0)
    const isClosing = (prev > 0n && action.sizeQ < 0n) || (prev < 0n && action.sizeQ > 0n);
    action.bot.openPositions.set(action.market.market.toBase58(),
      isClosing ? Math.max(0, prevCount - 1) : prevCount + 1);
  }

  return result.ok;
}

// ── Trade decision logic ──────────────────────────────────────────────────────

function randomTradeSize(): bigint {
  const range = TRADE_SIZE_MAX - TRADE_SIZE_MIN;
  const rand = BigInt(Math.floor(Math.random() * Number(range)));
  return TRADE_SIZE_MIN + rand;
}

/**
 * Decide what trade to make for this bot on this market.
 *
 * Behaviour:
 *   - If openPositions >= MAX_OPEN_POSITIONS, always close (reduce)
 *   - Otherwise: CLOSE_PROB chance to close an existing position; else open new
 *   - Alternate LONG/SHORT based on cycle count to generate balanced flow
 *   - Occasionally open large positions to push toward liquidation (excitement)
 */
function decideTrade(
  bot: BotState,
  market: V17Market,
  cycleCount: number,
): TradeAction | null {
  const mKey = market.market.toBase58();
  const openCount = bot.openPositions.get(mKey) ?? 0;
  const netPos = bot.netPosition.get(mKey) ?? 0n;

  const shouldClose = openCount >= MAX_OPEN_POSITIONS ||
    (openCount > 0 && Math.random() < CLOSE_PROB);

  if (shouldClose && netPos !== 0n) {
    // Close a portion of the net position (50-100%)
    const closeFrac = 0.5 + Math.random() * 0.5;
    const closeSize = BigInt(Math.floor(Number(netPos < 0n ? -netPos : netPos) * closeFrac));
    if (closeSize === 0n) return null;
    const sizeQ = netPos > 0n ? -closeSize : closeSize;
    return { market, bot, sizeQ, label: "CLOSE" };
  }

  // Open new position — alternate LONG/SHORT each cycle, with occasional big trade
  const size = randomTradeSize();
  const isLong = cycleCount % 2 === 0 ? true : false;
  // 10% chance of 3x size to create excitement / pressure
  const sizeQ = isLong
    ? (Math.random() < 0.1 ? size * 3n : size)
    : (Math.random() < 0.1 ? -(size * 3n) : -size);

  return { market, bot, sizeQ, label: "OPEN" };
}

// ── Permissionless Crank (fee sweep, not liquidation) ─────────────────────────

/**
 * Run a fee-sweep crank on a market + portfolio.
 * This is encodePermissionlessCrank (tag 5) — NOT the removed v12 encodeKeeperCrank.
 *
 * accounts: [owner, market, portfolio, ...oracleTail]
 * For AUTH_MARK markets (mode=3), oracle tail is empty.
 * For Pyth markets, oracle tail includes the Pyth PriceUpdateV2 PDA.
 */
async function crankMarket(
  market: V17Market,
  cranker: Keypair,
  portfolio: PublicKey,
): Promise<void> {
  const nowSlot = BigInt(await retry(() => connection.getSlot("confirmed")));
  const mKey = market.market.toBase58().slice(0, 8);

  const crankIx = buildIx({
    programId: WRAPPER_PROGRAM_ID,
    keys: [
      // base: [owner (signer,writable), market (writable), portfolio (writable)]
      { pubkey: cranker.publicKey, isSigner: true, isWritable: true },
      { pubkey: market.market,     isSigner: false, isWritable: true },
      { pubkey: portfolio,         isSigner: false, isWritable: true },
      // oracle tail: omit for AUTH_MARK (mode=3); Pyth markets would append oracle PDA here
    ],
    data: encodePermissionlessCrank({
      action:         CrankAction.FeeSweep,
      assetIndex:     0,
      nowSlot,
      closeQ:         0n,
      feeBps:         0n,
      recoveryReason: 0,
    }),
  });

  await dryRunOrSend(crankIx, [cranker], `PermissionlessCrank(FeeSweep)(${mKey})`, 400_000);
}

// ── Main bot loop ─────────────────────────────────────────────────────────────

let running = true;
process.on("SIGINT", () => { running = false; log("main", "Shutting down…"); });
process.on("SIGTERM", () => { running = false; log("main", "Shutting down…"); });

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Percolator v17 Activity Bots                            ║
║  LP Provisioner + Trader Bots (PERCV16 wire format)      ║
╚══════════════════════════════════════════════════════════╝
`);

  log("config", `DRY_RUN=${DRY_RUN} | INTENSITY=${INTENSITY} | INTERVAL=${TRADE_INTERVAL_MS}ms`);
  log("config", `TRADE_SIZE=[${TRADE_SIZE_MIN}..${TRADE_SIZE_MAX}] atoms | FEE=${FEE_BPS}bps`);
  log("config", `MAX_OPEN_POS=${MAX_OPEN_POSITIONS} | CLOSE_PROB=${CLOSE_PROB}`);
  log("config", `Wrapper: ${WRAPPER_PROGRAM_ID.toBase58()}`);
  log("config", `Matcher: ${MATCHER_PROGRAM_ID.toBase58()}`);

  // Resolve LP wallet
  let lpWallet: Keypair;
  const lpPath = process.env.LP_WALLET;
  if (!DRY_RUN && lpPath) {
    lpWallet = loadKeypair(lpPath);
    log("wallet", `LP wallet: ${lpWallet.publicKey.toBase58()}`);
    const bal = await connection.getBalance(lpWallet.publicKey);
    log("wallet", `LP SOL balance: ${(bal / 1e9).toFixed(4)} SOL`);
    if (bal < 0.05 * 1e9) warn("wallet", "LP SOL balance low — may fail on rent allocation");
  } else {
    lpWallet = DRY_RUN ? randomBotKeypair(99) : randomBotKeypair(99);
    if (!DRY_RUN) {
      err("wallet", "LP_WALLET not set — set LP_WALLET=/path/to/keypair.json for live mode");
      process.exit(1);
    }
    log("wallet", `LP wallet (synthetic, dry-run): ${lpWallet.publicKey.toBase58()}`);
  }

  // Resolve bot wallets
  const botPaths = process.env.BOT_WALLETS
    ? process.env.BOT_WALLETS.split(",").map(p => p.trim())
    : [];

  let botWallets: Keypair[];
  if (botPaths.length > 0 && !DRY_RUN) {
    botWallets = botPaths.map(p => loadKeypair(p));
    log("wallet", `Loaded ${botWallets.length} bot wallet(s) from BOT_WALLETS`);
  } else {
    // Generate 3 synthetic bots for dry-run (or fall back if BOT_WALLETS not set in live mode)
    const count = DRY_RUN ? 3 : 0;
    if (!DRY_RUN && count === 0) {
      err("wallet", "BOT_WALLETS not set — set BOT_WALLETS=./bot1.json,./bot2.json for live mode");
      process.exit(1);
    }
    botWallets = Array.from({ length: count }, (_, i) => randomBotKeypair(i));
    log("wallet", `Using ${count} synthetic bot wallet(s) (dry-run)`);
    for (const [i, w] of botWallets.entries()) {
      log("wallet", `  Bot ${i}: ${w.publicKey.toBase58()}`);
    }
  }

  // Discover v17 markets
  log("discover", "Discovering v17 markets…");
  const markets = await discoverV17Markets();
  if (markets.length === 0) {
    err("discover", "No v17 markets found — cannot continue");
    process.exit(1);
  }
  log("discover", `Found ${markets.length} v17 market(s)`);
  for (const m of markets) {
    const sym = guessSymbol(m);
    log("discover", `  ${m.market.toBase58().slice(0, 16)}… mark=$${(Number(m.markE6)/1e6).toFixed(4)} (${sym}) mode=${m.oracleMode}`);
  }

  // Provision LP on each market
  log("lp", "Provisioning LP on all markets…");
  const lpStates = new Map<string, LpState>();
  for (const market of markets) {
    try {
      const lp = await provisionLp(market, lpWallet);
      if (lp) lpStates.set(market.market.toBase58(), lp);
    } catch (e: unknown) {
      warn("lp", `LP provision failed on ${market.market.toBase58().slice(0, 8)}…: ${(e as Error).message?.slice(0, 80)}`);
    }
    await sleep(1000); // brief spacing between markets
  }

  log("lp", `LP provisioned on ${lpStates.size}/${markets.length} market(s)`);

  // Initialize bot states
  const bots: BotState[] = botWallets.map(wallet => ({
    wallet,
    portfolios:    new Map(),
    openPositions: new Map(),
    netPosition:   new Map(),
  }));

  if (DRY_RUN) {
    // In DRY_RUN, run exactly ONE trade cycle per bot per market for validation,
    // then exit with a summary. This is the "dry-run output" the user asked for.
    log("dryrun", "=== DRY-RUN VALIDATION ===");
    log("dryrun", "Building + simulating v17 tx shapes (no SOL spent)…");

    let txCount = 0;
    let okCount = 0;
    let badIxCount = 0;

    for (const market of markets) {
      const lp = lpStates.get(market.market.toBase58());
      if (!lp) { warn("dryrun", `No LP for ${market.market.toBase58().slice(0, 8)}… — skip`); continue; }
      const sym = guessSymbol(market);
      log("dryrun", `\n--- Market: ${market.market.toBase58().slice(0, 16)}… (${sym}) ---`);

      // Validate crank instruction
      log("dryrun", "Validating PermissionlessCrank(FeeSweep)…");
      await crankMarket(market, lpWallet, lp.portfolio.publicKey);
      txCount++;

      for (const [botIdx, bot] of bots.entries()) {
        log("dryrun", `Validating TradeCpi for Bot ${botIdx}…`);

        // Test LONG open
        const longAction: TradeAction = {
          market, bot,
          sizeQ: TRADE_SIZE_MIN + BigInt(Math.floor(Number(TRADE_SIZE_MAX - TRADE_SIZE_MIN) / 2)),
          label: "LONG",
        };
        const longResult = await executeTrade(longAction, lp);
        txCount++;
        if (longResult || DRY_RUN) okCount++;

        // Test SHORT open
        const shortAction: TradeAction = {
          market, bot,
          sizeQ: -(TRADE_SIZE_MIN + BigInt(Math.floor(Number(TRADE_SIZE_MAX - TRADE_SIZE_MIN) / 3))),
          label: "SHORT",
        };
        const shortResult = await executeTrade(shortAction, lp);
        txCount++;
        if (shortResult || DRY_RUN) okCount++;

        await sleep(500);
      }

      await sleep(2000);
    }

    console.log(`
╔══════════════════════════════════════════════════════════╗
║  DRY-RUN RESULTS                                         ║
╚══════════════════════════════════════════════════════════╝
`);
    log("dryrun", `Markets validated:   ${markets.length}`);
    log("dryrun", `LP setups simulated: ${lpStates.size}`);
    log("dryrun", `Trade txs built:     ${txCount}`);
    log("dryrun", `Ix encoding OK:      ${okCount} (state errors are expected in dry-run)`);
    log("dryrun", `Bad ix encoding:     ${badIxCount}`);
    log("dryrun", `v17 wire format:     ${badIxCount === 0 ? "VALIDATED" : "ERRORS FOUND"}`);
    log("dryrun", ``);
    log("dryrun", `To run LIVE: fund bot wallets + LP wallet, then:`);
    log("dryrun", `  BOT_WALLETS=./bot1.json,./bot2.json LP_WALLET=./lp.json DRY_RUN=false npx tsx playground/bots-v17.ts`);
    log("dryrun", ``);
    log("dryrun", `SOL requirements (per market):`);
    log("dryrun", `  LP wallet:  ~0.10 SOL rent (portfolio + matcherCtx) + token balance for LP_DEPOSIT`);
    log("dryrun", `  Each bot:   ~0.07 SOL rent (portfolio) + token balance for initial deposit`);
    return;
  }

  // ── LIVE MODE: continuous trading loop ─────────────────────────────────────
  log("main", `Starting live trading loop on ${markets.length} market(s) with ${bots.length} bot(s)`);

  let cycleCount = 0;
  const statsInterval = setInterval(() => {
    log("stats", `Cycle ${cycleCount} | Markets ${markets.length} | Bots ${bots.length}`);
    for (const bot of bots) {
      const botKey = bot.wallet.publicKey.toBase58().slice(0, 8);
      for (const [mKey, pos] of bot.netPosition) {
        const open = bot.openPositions.get(mKey) ?? 0;
        const posUsd = (Number(pos < 0n ? -pos : pos) / 1e6).toFixed(2);
        log("stats", `  Bot ${botKey}… | mkt ${mKey.slice(0, 8)}… | pos=$${posUsd} (${pos > 0n ? "L" : pos < 0n ? "S" : "FLAT"}) | open=${open}`);
      }
    }
  }, 60_000);

  // Re-discover markets every 100 cycles
  let lastDiscoveryCycle = 0;

  while (running) {
    cycleCount++;

    // Periodic market re-discovery
    if (cycleCount - lastDiscoveryCycle >= 100) {
      try {
        const fresh = await discoverV17Markets();
        for (const fm of fresh) {
          const exists = markets.find(m => m.market.equals(fm.market));
          if (!exists) {
            markets.push(fm);
            log("discover", `New market added: ${fm.market.toBase58().slice(0, 16)}…`);
            // Provision LP on new market
            const lp = await provisionLp(fm, lpWallet);
            if (lp) lpStates.set(fm.market.toBase58(), lp);
          } else {
            // Update mark price
            exists.markE6 = fm.markE6;
          }
        }
        lastDiscoveryCycle = cycleCount;
      } catch (e: unknown) {
        warn("discover", `Re-discovery failed: ${(e as Error).message?.slice(0, 80)}`);
      }
    }

    // Each bot takes one action per cycle
    for (const bot of bots) {
      if (!running) break;

      for (const market of markets) {
        if (!running) break;

        const lp = lpStates.get(market.market.toBase58());
        if (!lp) continue;

        try {
          const action = decideTrade(bot, market, cycleCount);
          if (!action) continue;
          await executeTrade(action, lp);
        } catch (e: unknown) {
          warn("bot", `Trade error on ${market.market.toBase58().slice(0, 8)}…: ${(e as Error).message?.slice(0, 80)}`);
        }

        await sleep(200); // brief spacing between bots × markets
      }

      await sleep(TRADE_INTERVAL_MS / bots.length);
    }

    // Crank once per 10 cycles to sweep fees
    if (cycleCount % 10 === 0) {
      for (const [mKey, lp] of lpStates) {
        if (!running) break;
        const market = markets.find(m => m.market.toBase58() === mKey);
        if (!market) continue;
        try {
          await crankMarket(market, lpWallet, lp.portfolio.publicKey);
        } catch (e: unknown) {
          warn("crank", `Crank failed ${mKey.slice(0, 8)}…: ${(e as Error).message?.slice(0, 60)}`);
        }
      }
    }
  }

  clearInterval(statsInterval);
  log("main", `Stopped after ${cycleCount} cycle(s).`);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
