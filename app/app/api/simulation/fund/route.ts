export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import {
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodePushOraclePrice,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  SLAB_TIERS,
} from '@percolator/core';
import { getConfig } from '@/lib/config';
import { SimulationManager } from '@/lib/simulation/SimulationManager';

/**
 * POST /api/simulation/fund
 * 
 * Mints collateral tokens to the user's wallet and deposits them into the market.
 * Since we generated the mint, the user is mint authority and can mint freely.
 * 
 * Request body: { payerPublicKey: string, mintAmount?: number }
 * Returns: { transactions: string[] } — base64 serialized unsigned transactions
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { payerPublicKey, mintAmount = 10_000_000_000 } = body; // Default: 10,000 tokens (6 decimals)

    if (!payerPublicKey) {
      return NextResponse.json({ error: 'payerPublicKey is required' }, { status: 400 });
    }

    let payerPk: PublicKey;
    try {
      payerPk = new PublicKey(payerPublicKey);
    } catch {
      return NextResponse.json({ error: 'Invalid payerPublicKey' }, { status: 400 });
    }

    const manager = SimulationManager.getInstance();
    const session = manager.getSelfServiceSession(payerPublicKey);

    if (!session) {
      return NextResponse.json(
        { error: 'No simulation session found. Create a market first.' },
        { status: 404 }
      );
    }

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, 'confirmed');
    const programsByTier = (cfg as Record<string, unknown>).programsBySlabTier as Record<string, string> | undefined;
    const selectedProgramId = programsByTier?.small ?? cfg.programId;
    const programId = new PublicKey(selectedProgramId);

    const slabPk = new PublicKey(session.slabAddress);
    const mintPk = new PublicKey(session.mintKeypair.publicKey);
    const [vaultPda] = deriveVaultAuthority(programId, slabPk);
    const vaultAta = await getAssociatedTokenAddress(mintPk, vaultPda, true);
    const payerAta = await getAssociatedTokenAddress(mintPk, payerPk);

    // ─── Transaction 1: Mint tokens to user ───
    const tx1 = new Transaction();

    // Check if ATA exists, create if not
    try {
      await getAccount(connection, payerAta);
    } catch {
      tx1.add(createAssociatedTokenAccountInstruction(payerPk, payerAta, payerPk, mintPk));
    }

    // Mint tokens — user is mint authority (set during create-market)
    tx1.add(
      createMintToInstruction(
        mintPk,
        payerAta,
        payerPk, // mint authority = payer
        BigInt(mintAmount),
      )
    );

    // ─── Transaction 2: Deposit collateral + insurance + crank ───
    const tx2 = new Transaction();

    const lpCollateral = BigInt(Math.floor(mintAmount * 0.7)); // 70% to LP
    const insuranceAmount = BigInt(Math.floor(mintAmount * 0.2)); // 20% to insurance

    // Deposit collateral (LP slot 0)
    const depositData = encodeDepositCollateral({
      userIdx: 0,
      amount: lpCollateral.toString(),
    });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payerPk, slabPk, payerAta, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    tx2.add(buildIx({ programId, keys: depositKeys, data: depositData }));

    // Top up insurance
    const topupData = encodeTopUpInsurance({ amount: insuranceAmount.toString() });
    const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      payerPk, slabPk, payerAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    tx2.add(buildIx({ programId, keys: topupKeys, data: topupData }));

    // Push fresh price from oracle authority before crank
    const now = Math.floor(Date.now() / 1000);
    const pushData = encodePushOraclePrice({
      priceE6: '1000000', // $1.00
      timestamp: now.toString(),
    });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      session.oracleKeypair.publicKey, slabPk,
    ]);
    tx2.add(buildIx({ programId, keys: pushKeys, data: pushData }));

    // Crank
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payerPk, slabPk, WELL_KNOWN.clock, slabPk,
    ]);
    tx2.add(buildIx({ programId, keys: crankKeys, data: crankData }));

    // Serialize instructions as JSON (client builds fresh txs with fresh blockhashes)
    const serializeIx = (ix: { programId: PublicKey; keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; data: Buffer | Uint8Array }) => ({
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(ix.data).toString('base64'),
    });

    const { Keypair: _Keypair } = await import('@solana/web3.js');
    const serializeKeypair = (kp: InstanceType<typeof _Keypair>) =>
      Buffer.from(kp.secretKey).toString('base64');

    const instructionGroups = [
      {
        label: 'Mint collateral tokens',
        instructions: tx1.instructions.map(serializeIx),
        signers: [] as string[],
      },
      {
        label: 'Deposit, insurance & crank',
        instructions: tx2.instructions.map(serializeIx),
        signers: [serializeKeypair(session.oracleKeypair)],
      },
    ];

    return NextResponse.json({
      instructionGroups,
      mintedAmount: mintAmount,
      lpCollateral: lpCollateral.toString(),
      insuranceAmount: insuranceAmount.toString(),
      remainingBalance: (BigInt(mintAmount) - lpCollateral - insuranceAmount).toString(),
    });
  } catch (error) {
    console.error('Fund simulation error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to fund simulation', details: message }, { status: 500 });
  }
}
