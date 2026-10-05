/**
 * M1 of the create-market batch — the transaction that creates the market — as ONE builder shared
 * by hooks/useCreateMarket.ts (batched and sequential paths) and the tx-size test. UX WP-7: M1 also
 * carries the keeper-registration memo (lib/keeper-register-memo.ts): the creator's own signature
 * over the pool binding, in the same tx as InitMarket, so registering the price feed needs no
 * separate signMessage prompt.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { ACCOUNTS_INIT_MARKET, WELL_KNOWN, buildAccountMetas, buildIx, encodeSetNftProgramId } from "@percolatorct/sdk";
import { encodeInitMarketData, type GrowthLaunch } from "@/lib/v21/growth-launch";
import type { InitMarketV17Args } from "@percolatorct/sdk";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";

export interface M1Params {
  programId: PublicKey;
  wallet: PublicKey;
  slab: PublicKey;
  mint: PublicKey;
  vaultAta: PublicKey;
  vaultPda: PublicKey;
  nftRegistry: PublicKey;
  slabRent: number;
  slabSize: number;
  initArgs: InitMarketV17Args;
  /** Devnet v2.1: the growth block (appends the r_gap / l_launch trailer to InitMarket). Absent = today's bytes. */
  growth?: GrowthLaunch;
  /** The keeper-registration memo (UX WP-7), when the market is keeper-priced. */
  memo?: TransactionInstruction | null;
}

export function buildM1Instructions(p: M1Params): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({ fromPubkey: p.wallet, newAccountPubkey: p.slab, lamports: p.slabRent, space: p.slabSize, programId: p.programId }),
    createAssociatedTokenAccountInstruction(p.wallet, p.vaultAta, p.vaultPda, p.mint),
    // v18 InitMarket takes exactly 3 accounts [admin, slab, mint].
    buildIx({ programId: p.programId, keys: buildAccountMetas(ACCOUNTS_INIT_MARKET, { admin: p.wallet, slab: p.slab, mint: p.mint }), data: encodeInitMarketData(p.initArgs, p.growth) }),
    buildIx({
      programId: p.programId,
      keys: [
        { pubkey: p.wallet, isSigner: true, isWritable: true },
        { pubkey: p.slab, isSigner: false, isWritable: false },
        { pubkey: p.nftRegistry, isSigner: false, isWritable: true },
        { pubkey: WELL_KNOWN.systemProgram, isSigner: false, isWritable: false },
      ],
      data: encodeSetNftProgramId({ nftProgramId: PERCOLATOR_NFT_PROGRAM_ID }),
    }),
  ];
  if (p.memo) ixs.push(p.memo);
  return ixs;
}
