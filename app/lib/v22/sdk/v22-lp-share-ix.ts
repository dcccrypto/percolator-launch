/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/v22-sdk @ d98488b (draft dcccrypto/percolator-sdk#406, sdk 9.0.0-candidate),
 * src/solana/v22-lp-share.ts. Only the imports are retargeted (the installed @percolatorct/sdk 8.0.0 root, the v2.1 txv1 port, and the sibling v22 ports).
 * Delete when @percolatorct/sdk >= 9.0.0 ships and point ./index.ts at the package. Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * v2.2 tag 122 `InitLpShareMetadata` instruction builder and PDAs (percolator-prog `docs/v22-lp-share-mint.md`).
 *
 * Account list (9 with a ticker, 7 without): `[0]` payer (signer, writable; funds the record, never handed to Metaplex), `[1]` registry,
 * `[2]` LP share mint, `[3]` Metaplex metadata PDA (w), `[4]` Metaplex program, `[5]` system program, `[6]` fee-payer PDA (w), and only for
 * the ticker form `[7]` the market and `[8]` `config.marketauth` (signer). `[0]` and `[8]` may be the same wallet.
 *
 * @module v22-lp-share
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { buildAccountMetas, deriveInsuranceLpMint, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { encodeInitLpShareMetadataV22 } from "./v22-wire";
import { ACCOUNTS_INIT_LP_SHARE_METADATA, ACCOUNTS_INIT_LP_SHARE_METADATA_TICKER_TAIL, METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, isLpShareTickerV22 } from "./v22-lp-share";

const te = new TextEncoder();

/** Metaplex metadata PDA of `mint`: `["metadata", metaqbxx..., mint]` under the Token Metadata program. */
export function deriveLpShareMetadataPdaV22(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([te.encode("metadata"), METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBytes(), mint.toBytes()], METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22);
}

/** The wrapper's transient fee-payer PDA `["lp_share_meta_payer", mint]` (funded by the caller, drained back in the same instruction). */
export function deriveLpShareMetaPayerPdaV22(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([te.encode("lp_share_meta_payer"), mint.toBytes()], programId);
}

export interface InitLpShareMetadataArgsV22 {
  programId: PublicKey;
  market: PublicKey;
  /** Funds the record (needs 30,000,000 lamports held; ~15.1M is the net cost). Signer. */
  payer: PublicKey;
  /** `""` = generic form (anyone). 1..=8 of A-Z 0-9 = ticker form, which also needs `marketauth`. */
  ticker?: string;
  /** `config.marketauth` of the market; REQUIRED for the ticker form (signs the wrapper instruction only). */
  marketauth?: PublicKey;
}

/**
 * Tag 122. Throws on a ticker the program would refuse, or a ticker without `marketauth`.
 * @returns The instruction (7 accounts generic, 9 with a ticker).
 */
export function buildInitLpShareMetadataIxV22(a: InitLpShareMetadataArgsV22): TransactionInstruction {
  const ticker = a.ticker ?? "";
  if (ticker !== "" && !isLpShareTickerV22(ticker)) throw new Error(`ticker must be 1..8 characters of A-Z 0-9, got ${JSON.stringify(ticker)}`);
  if (ticker !== "" && !a.marketauth) throw new Error("the ticker form needs marketauth (config.marketauth signs as account [8])");
  const [registry] = deriveLpVaultRegistry(a.programId, a.market);
  const [lpMint] = deriveInsuranceLpMint(a.programId, a.market);
  const [metadata] = deriveLpShareMetadataPdaV22(lpMint);
  const [feePayerPda] = deriveLpShareMetaPayerPdaV22(a.programId, lpMint);
  const keys = buildAccountMetas(ACCOUNTS_INIT_LP_SHARE_METADATA, {
    payer: a.payer, registry, lpMint, metadata, metaplexProgram: METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22, systemProgram: SystemProgram.programId, feePayerPda,
  });
  if (ticker !== "") keys.push(...buildAccountMetas(ACCOUNTS_INIT_LP_SHARE_METADATA_TICKER_TAIL, { market: a.market, marketauth: a.marketauth as PublicKey }));
  return new TransactionInstruction({ programId: a.programId, keys, data: Buffer.from(encodeInitLpShareMetadataV22(ticker)) });
}
