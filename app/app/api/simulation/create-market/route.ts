export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  createInitializeMint2Instruction,
  getMintLen,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  encodeInitMarket,
  encodeInitLP,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeSetOraclePriceCap,
  encodeUpdateConfig,
  encodeKeeperCrank,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_UPDATE_CONFIG,
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  SLAB_TIERS,
  deriveLpPda,
} from '@percolator/core';
import { getConfig } from '@/lib/config';
import { getRandomToken } from '@/lib/simulation/tokens';
import { SimulationManager } from '@/lib/simulation/SimulationManager';

const ALL_ZEROS_FEED = '0'.repeat(64);
const MATCHER_CTX_SIZE = 320;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { payerPublicKey } = body;

    if (!payerPublicKey) {
      return NextResponse.json({ error: 'payerPublicKey is required' }, { status: 400 });
    }

    let payerPk: PublicKey;
    try {
      payerPk = new PublicKey(payerPublicKey);
    } catch {
      return NextResponse.json({ error: 'Invalid payerPublicKey' }, { status: 400 });
    }

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, 'confirmed');

    // Use small tier for simulation
    const tier = SLAB_TIERS.small;
    const programsByTier = (cfg as Record<string, unknown>).programsBySlabTier as Record<string, string> | undefined;
    const selectedProgramId = programsByTier?.small ?? cfg.programId;
    const programId = new PublicKey(selectedProgramId);
    const matcherProgramId = new PublicKey(cfg.matcherProgramId);

    // Generate keypairs server-side
    const oracleKeypair = Keypair.generate();
    const mintKeypair = Keypair.generate();
    const slabKeypair = Keypair.generate();
    const matcherCtxKeypair = Keypair.generate();

    // Get random token
    const token = getRandomToken();

    // Derive PDAs
    const [vaultPda] = deriveVaultAuthority(programId, slabKeypair.publicKey);
    const vaultAta = await getAssociatedTokenAddress(mintKeypair.publicKey, vaultPda, true);
    const [lpPda] = deriveLpPda(programId, slabKeypair.publicKey, 0);

    // Calculate costs
    const mintRent = await connection.getMinimumBalanceForRentExemption(getMintLen([]));
    const slabRent = await connection.getMinimumBalanceForRentExemption(tier.dataSize);
    const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
    const estimatedCostSol = (mintRent + slabRent + matcherCtxRent + 50_000_000) / 1e9; // + buffer for tx fees

    const initialPriceE6 = 1_000_000; // $1.00 initial price

    // ─── Transaction 1: Create mint + slab account ───
    const tx1 = new Transaction();

    // Create mint account
    tx1.add(
      SystemProgram.createAccount({
        fromPubkey: payerPk,
        newAccountPubkey: mintKeypair.publicKey,
        lamports: mintRent,
        space: getMintLen([]),
        programId: TOKEN_PROGRAM_ID,
      })
    );

    // Initialize mint (payer is mint authority so we can mint tokens later)
    tx1.add(
      createInitializeMint2Instruction(
        mintKeypair.publicKey,
        token.decimals,
        payerPk, // mint authority = payer (so server can mint via user sig later)
        null, // no freeze authority
      )
    );

    // Create slab account
    tx1.add(
      SystemProgram.createAccount({
        fromPubkey: payerPk,
        newAccountPubkey: slabKeypair.publicKey,
        lamports: slabRent,
        space: tier.dataSize,
        programId,
      })
    );

    // Create vault ATA
    tx1.add(
      createAssociatedTokenAccountInstruction(
        payerPk,
        vaultAta,
        vaultPda,
        mintKeypair.publicKey,
      )
    );

    // InitMarket
    const initMarketData = encodeInitMarket({
      admin: payerPk,
      collateralMint: mintKeypair.publicKey,
      indexFeedId: ALL_ZEROS_FEED,
      maxStalenessSecs: '86400',
      confFilterBps: 0,
      invert: 0,
      unitScale: 0,
      initialMarkPriceE6: BigInt(initialPriceE6).toString(),
      warmupPeriodSlots: '10', // Short warmup for simulation
      maintenanceMarginBps: '500',
      initialMarginBps: '1000',
      tradingFeeBps: '30',
      maxAccounts: tier.maxAccounts.toString(),
      newAccountFee: '1000000',
      riskReductionThreshold: '0',
      maintenanceFeePerSlot: '0',
      maxCrankStalenessSlots: '400',
      liquidationFeeBps: '100',
      liquidationFeeCap: '100000000000',
      liquidationBufferBps: '50',
      minLiquidationAbs: '1000000',
    });

    const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payerPk,
      slabKeypair.publicKey,
      mintKeypair.publicKey,
      vaultAta,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      WELL_KNOWN.rent,
      vaultPda,
      WELL_KNOWN.systemProgram,
    ]);

    tx1.add(buildIx({ programId, keys: initMarketKeys, data: initMarketData }));

    // ─── Transaction 2: Oracle setup + Config + Crank ───
    const tx2 = new Transaction();

    // SetOracleAuthority → payer becomes authority
    const setAuthData = encodeSetOracleAuthority({ newAuthority: payerPk });
    const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      payerPk, slabKeypair.publicKey,
    ]);
    tx2.add(buildIx({ programId, keys: setAuthKeys, data: setAuthData }));

    // PushOraclePrice
    const now = Math.floor(Date.now() / 1000);
    const pushData = encodePushOraclePrice({
      priceE6: BigInt(initialPriceE6).toString(),
      timestamp: now.toString(),
    });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      payerPk, slabKeypair.publicKey,
    ]);
    tx2.add(buildIx({ programId, keys: pushKeys, data: pushData }));

    // SetOraclePriceCap
    const priceCapData = encodeSetOraclePriceCap({ maxChangeE2bps: BigInt(100_000) }); // 10% cap — generous for sim
    const priceCapKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      payerPk, slabKeypair.publicKey,
    ]);
    tx2.add(buildIx({ programId, keys: priceCapKeys, data: priceCapData }));

    // UpdateConfig
    const updateConfigData = encodeUpdateConfig({
      fundingHorizonSlots: '3600',
      fundingKBps: '100',
      fundingInvScaleNotionalE6: '1000000000000',
      fundingMaxPremiumBps: '1000',
      fundingMaxBpsPerSlot: '10',
      threshFloor: '0',
      threshRiskBps: '500',
      threshUpdateIntervalSlots: '100',
      threshStepBps: '100',
      threshAlphaBps: '5000',
      threshMin: '0',
      threshMax: '1000000000000000000',
      threshMinStep: '0',
    });
    const updateConfigKeys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
      payerPk, slabKeypair.publicKey,
    ]);
    tx2.add(buildIx({ programId, keys: updateConfigKeys, data: updateConfigData }));

    // KeeperCrank (pre-LP)
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payerPk, slabKeypair.publicKey, WELL_KNOWN.clock, slabKeypair.publicKey,
    ]);
    tx2.add(buildIx({ programId, keys: crankKeys, data: crankData }));

    // ─── Transaction 3: InitLP with matcher ───
    const tx3 = new Transaction();

    // Create payer ATA for the new mint
    const payerAta = await getAssociatedTokenAddress(mintKeypair.publicKey, payerPk);
    tx3.add(
      createAssociatedTokenAccountInstruction(payerPk, payerAta, payerPk, mintKeypair.publicKey)
    );

    // Create matcher context account
    tx3.add(
      SystemProgram.createAccount({
        fromPubkey: payerPk,
        newAccountPubkey: matcherCtxKeypair.publicKey,
        lamports: matcherCtxRent,
        space: MATCHER_CTX_SIZE,
        programId: matcherProgramId,
      })
    );

    // Initialize vAMM matcher
    const vammData = new Uint8Array(66);
    const vammDv = new DataView(vammData.buffer);
    let off = 0;
    vammData[off] = 2; off += 1; // Tag 2 = InitVamm
    vammData[off] = 0; off += 1; // mode 0 = passive
    vammDv.setUint32(off, 30, true); off += 4;  // tradingFeeBps
    vammDv.setUint32(off, 50, true); off += 4;  // baseSpreadBps
    vammDv.setUint32(off, 200, true); off += 4; // maxTotalBps
    vammDv.setUint32(off, 0, true); off += 4;   // impactKBps
    vammDv.setBigUint64(off, 10000000000000n, true); off += 8; // liquidityE6
    vammDv.setBigUint64(off, 0n, true); off += 8;
    vammDv.setBigUint64(off, 1_000_000_000_000n, true); off += 8; // maxFillAbs
    vammDv.setBigUint64(off, 0n, true); off += 8;
    vammDv.setBigUint64(off, 0n, true); off += 8;
    vammDv.setBigUint64(off, 0n, true); off += 8;

    tx3.add(new TransactionInstruction({
      programId: matcherProgramId,
      keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },
        { pubkey: matcherCtxKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(vammData),
    }));

    // Mint tokens for LP fee payment (payer is mint authority)
    const LP_FEE = 1_000_000; // matches newAccountFee in InitMarket
    tx3.add(
      createMintToInstruction(
        mintKeypair.publicKey,
        payerAta,
        payerPk, // mint authority
        BigInt(LP_FEE),
      )
    );

    // InitLP
    const initLpData = encodeInitLP({
      matcherProgram: matcherProgramId,
      matcherContext: matcherCtxKeypair.publicKey,
      feePayment: LP_FEE.toString(),
    });
    const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      payerPk, slabKeypair.publicKey, payerAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    tx3.add(buildIx({ programId, keys: initLpKeys, data: initLpData }));

    // ─── Transaction 4: Delegate oracle authority to server keypair ───
    const tx4 = new Transaction();

    // Push price again (fresh timestamp for crank)
    const now2 = Math.floor(Date.now() / 1000);
    const pushData2 = encodePushOraclePrice({
      priceE6: BigInt(initialPriceE6).toString(),
      timestamp: now2.toString(),
    });
    const pushKeys2 = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      payerPk, slabKeypair.publicKey,
    ]);
    tx4.add(buildIx({ programId, keys: pushKeys2, data: pushData2 }));

    // Final crank
    const crankData2 = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys2 = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payerPk, slabKeypair.publicKey, WELL_KNOWN.clock, slabKeypair.publicKey,
    ]);
    tx4.add(buildIx({ programId, keys: crankKeys2, data: crankData2 }));

    // Delegate oracle authority to server-generated keypair
    const delegateAuthData = encodeSetOracleAuthority({ newAuthority: oracleKeypair.publicKey });
    const delegateAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      payerPk, slabKeypair.publicKey,
    ]);
    tx4.add(buildIx({ programId, keys: delegateAuthKeys, data: delegateAuthData }));

    // Push initial price from new oracle authority
    // NOTE: This ix must be signed by the oracle keypair, so we partially sign it server-side
    const pushData3 = encodePushOraclePrice({
      priceE6: BigInt(initialPriceE6).toString(),
      timestamp: (now2 + 1).toString(),
    });
    const pushKeys3 = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      oracleKeypair.publicKey, slabKeypair.publicKey,
    ]);
    tx4.add(buildIx({ programId, keys: pushKeys3, data: pushData3 }));

    // ─── Serialize instructions as JSON (no blockhash needed) ───
    // Client will build fresh transactions with fresh blockhashes

    const serializeIx = (ix: TransactionInstruction) => ({
      programId: ix.programId.toBase58(),
      keys: ix.keys.map(k => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(ix.data).toString('base64'),
    });

    const serializeKeypair = (kp: Keypair) =>
      Buffer.from(kp.secretKey).toString('base64');

    // Group A: tx1 — Create mint + slab + vault ATA + InitMarket
    // Group B: tx2 + tx3 combined — Oracle setup + Config + Crank + Payer ATA + Matcher + vAMM + InitLP
    // Group C: tx4 — Push price + Crank + Delegate oracle + Push from oracle
    const instructionGroups = [
      {
        label: 'Create mint, slab & market',
        instructions: tx1.instructions.map(serializeIx),
        signers: [serializeKeypair(mintKeypair), serializeKeypair(slabKeypair)],
      },
      {
        label: 'Oracle, config & LP setup',
        instructions: [...tx2.instructions, ...tx3.instructions].map(serializeIx),
        signers: [serializeKeypair(matcherCtxKeypair)],
      },
      {
        label: 'Delegate oracle & finalize',
        instructions: tx4.instructions.map(serializeIx),
        signers: [serializeKeypair(oracleKeypair)],
      },
    ];

    // Store session in manager
    const manager = SimulationManager.getInstance();
    manager.storeSelfServiceSession({
      oracleKeypair,
      mintKeypair,
      slabAddress: slabKeypair.publicKey.toBase58(),
      tokenName: token.name,
      tokenSymbol: token.symbol,
      payerPublicKey,
      createdAt: Date.now(),
    });

    return NextResponse.json({
      instructionGroups,
      slabAddress: slabKeypair.publicKey.toBase58(),
      mintAddress: mintKeypair.publicKey.toBase58(),
      oraclePublicKey: oracleKeypair.publicKey.toBase58(),
      oracleSecret: Buffer.from(oracleKeypair.secretKey).toString('base64'),
      tokenName: token.name,
      tokenSymbol: token.symbol,
      tokenDescription: token.description,
      estimatedCostSol: Math.ceil(estimatedCostSol * 100) / 100,
      initialPriceE6,
    });
  } catch (error) {
    console.error('Create market error:', error);
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    return NextResponse.json({ error: 'Failed to create market', details: message }, { status: 500 });
  }
}
