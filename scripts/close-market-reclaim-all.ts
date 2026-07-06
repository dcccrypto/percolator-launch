/**
 * Close an initialized Percolator market and reclaim all recoverable funds.
 *
 * Default target is the currently filtered mainnet market. Override with:
 *   SLAB_ADDRESS=<slab> PROGRAM_ID=<program> pnpm exec tsx scripts/close-market-reclaim-all.ts
 *
 * Use --dry-run to print the plan without sending transactions.
 */

import dotenv from "dotenv";
import fs from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ACCOUNTS_ADMIN_FORCE_CLOSE,
  ACCOUNTS_CLOSE_ORPHAN_SLAB,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_RESCUE_ORPHAN_VAULT,
  ACCOUNTS_RESOLVE_MARKET,
  ACCOUNTS_WITHDRAW_INSURANCE,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  detectSlabLayout,
  encodeAdminForceClose,
  encodeCloseOrphanSlab,
  encodeCloseSlab,
  encodeRescueOrphanVault,
  encodeResolveMarket,
  encodeWithdrawInsurance,
  fetchSlab,
  parseAllAccounts,
  parseConfig,
  parseEngine,
  parseHeader,
  type Account,
} from "@percolatorct/sdk";

dotenv.config({ path: ".env.production.local", quiet: true });

const DEFAULT_SLAB = "AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J";
const DEFAULT_PROGRAM = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";
const dryRun = process.argv.includes("--dry-run");

function getRpcUrl(): string {
  return (
    process.env.MAINNET_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  ).trim();
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function fmtUsdc(raw: bigint | string | null): string {
  if (raw == null) return "n/a";
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${whole}.${frac}`;
}

function accountNeedsClose(account: Account): boolean {
  return (
    account.capital !== 0n ||
    account.positionSize !== 0n ||
    account.pnl !== 0n ||
    account.reservedPnl !== 0n ||
    account.feeCredits !== 0n ||
    account.exactCohortCount == null ||
    account.exactCohortCount > 0
  );
}

async function getTokenRaw(connection: Connection, tokenAccount: PublicKey): Promise<bigint | null> {
  const info = await connection.getParsedAccountInfo(tokenAccount, "confirmed");
  if (!info.value || !("parsed" in info.value.data)) return null;
  return BigInt(info.value.data.parsed.info.tokenAmount.amount);
}

async function createAtaIfMissingIx(
  connection: Connection,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const existing = await connection.getAccountInfo(ata, "confirmed");
  if (existing) return { ata, ix: null };
  return {
    ata,
    ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
  };
}

function txWithBudget(instructions: TransactionInstruction[]): Transaction {
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...instructions,
  );
  return tx;
}

async function sendStep(
  connection: Connection,
  admin: Keypair,
  label: string,
  instructions: TransactionInstruction[],
): Promise<string | null> {
  if (instructions.length === 0) {
    console.log(`${label}: nothing to send`);
    return null;
  }
  if (dryRun) {
    console.log(`${label}: dry-run (${instructions.length} ix)`);
    return null;
  }

  try {
    const tx = txWithBudget(instructions);
    const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      skipPreflight: false,
      maxRetries: 5,
    });
    console.log(`${label}: ${sig}`);
    return sig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${label} failed: ${msg.slice(0, 700)}`);
    throw err;
  }
}

async function readState(connection: Connection, slab: PublicKey) {
  const info = await connection.getAccountInfo(slab, "confirmed");
  if (!info) return null;
  const data = await fetchSlab(connection, slab);
  const layout = detectSlabLayout(data.length, data);
  const header = parseHeader(data);
  const config = parseConfig(data, layout);
  const engine = parseEngine(data);
  const accounts = parseAllAccounts(data);
  return { info, data, layout, header, config, engine, accounts };
}

async function main() {
  const connection = new Connection(getRpcUrl(), "confirmed");
  const slab = new PublicKey(process.env.SLAB_ADDRESS || DEFAULT_SLAB);
  const programId = new PublicKey(process.env.PROGRAM_ID || DEFAULT_PROGRAM);
  const adminPath =
    process.env.ADMIN_KEYPAIR || `${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`;
  const admin = loadKeypair(adminPath);

  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`);
  console.log(`Slab: ${slab.toBase58()}`);
  console.log(`Program: ${programId.toBase58()}`);
  console.log(`Admin signer: ${admin.publicKey.toBase58()}`);

  let state = await readState(connection, slab);
  if (!state) {
    console.log("Slab account does not exist. Nothing left to close.");
    return;
  }

  if (!state.info.owner.equals(programId)) {
    throw new Error(`Program mismatch: slab owner is ${state.info.owner.toBase58()}`);
  }
  if (!state.header.admin.equals(admin.publicKey)) {
    throw new Error(
      `Admin mismatch: slab admin is ${state.header.admin.toBase58()}, signer is ${admin.publicKey.toBase58()}`,
    );
  }

  const mint = state.config.collateralMint;
  const vault = state.config.vaultPubkey;
  const [vaultAuthority] = deriveVaultAuthority(programId, slab);
  const adminAtaInfo = await createAtaIfMissingIx(connection, admin.publicKey, admin.publicKey, mint);

  console.log(`Data length: ${state.info.data.length}`);
  console.log(`Layout: maxAccounts=${state.layout?.maxAccounts ?? "unknown"} accountSize=${state.layout?.accountSize ?? "unknown"}`);
  console.log(`Resolved: ${state.header.resolved} mode=${state.engine.marketMode}`);
  console.log(`Vault token account: ${vault.toBase58()}`);
  console.log(`Vault authority: ${vaultAuthority.toBase58()}`);
  console.log(`Collateral mint: ${mint.toBase58()}`);
  console.log(`Admin ATA: ${adminAtaInfo.ata.toBase58()}`);
  console.log(`Slab rent lamports: ${state.info.lamports} (${state.info.lamports / LAMPORTS_PER_SOL} SOL)`);
  console.log(`Engine vault: ${fmtUsdc(state.engine.vault)} USDC`);
  console.log(`Insurance: ${fmtUsdc(state.engine.insuranceFund.balance)} USDC`);
  console.log(`Actual vault token balance: ${fmtUsdc(await getTokenRaw(connection, vault))} USDC`);
  console.log("Used accounts:");
  for (const { idx, account } of state.accounts) {
    console.log(
      `  #${idx} kind=${account.kind} owner=${account.owner.toBase58()} capital=${fmtUsdc(account.capital)} pnl=${fmtUsdc(account.pnl)} pos=${account.positionSize.toString()}`,
    );
  }

  if (adminAtaInfo.ix) {
    await sendStep(connection, admin, "Create admin ATA", [adminAtaInfo.ix]);
  }

  const oracleCandidates = [
    slab,
    ...(state.config.dexPool ? [state.config.dexPool] : []),
  ].filter((candidate, index, values) => values.findIndex((v) => v.equals(candidate)) === index);

  if (!state.header.resolved && state.engine.marketMode !== 1) {
    let resolved = false;
    for (const oracle of oracleCandidates) {
      try {
        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, {
            admin: admin.publicKey,
            slab,
            clock: SYSVAR_CLOCK_PUBKEY,
            oracle,
          }),
          data: encodeResolveMarket(),
        });
        await sendStep(connection, admin, `Resolve market (oracle ${oracle.toBase58()})`, [ix]);
        resolved = true;
        break;
      } catch {
        console.log(`Resolve candidate failed: ${oracle.toBase58()}`);
      }
    }
    if (!resolved) throw new Error("Could not resolve market with any known oracle account.");
  } else {
    console.log("Resolve market: already resolved");
  }

  state = await readState(connection, slab);
  if (!state) {
    console.log("Slab closed during resolve step.");
    return;
  }

  const accountsToClose = state.accounts.filter(({ account }) => accountNeedsClose(account));
  for (const { idx, account } of accountsToClose) {
    const { ata: ownerAta, ix: createOwnerAtaIx } = await createAtaIfMissingIx(
      connection,
      admin.publicKey,
      account.owner,
      mint,
    );
    const instructions: TransactionInstruction[] = [];
    if (createOwnerAtaIx) instructions.push(createOwnerAtaIx);
    instructions.push(
      buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_ADMIN_FORCE_CLOSE, {
          admin: admin.publicKey,
          slab,
          vault,
          ownerAta,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: SYSVAR_CLOCK_PUBKEY,
          oracle: slab,
        }),
        data: encodeAdminForceClose({ targetIdx: idx }),
      }),
    );
    await sendStep(
      connection,
      admin,
      `Admin force-close #${idx} (${fmtUsdc(account.capital)} USDC capital)`,
      instructions,
    );
  }

  state = await readState(connection, slab);
  if (!state) {
    console.log("Slab closed after force-close step.");
    return;
  }

  if (state.engine.insuranceFund.balance > 0n) {
    const refreshedAdminAta = await createAtaIfMissingIx(connection, admin.publicKey, admin.publicKey, mint);
    const instructions: TransactionInstruction[] = [];
    if (refreshedAdminAta.ix) instructions.push(refreshedAdminAta.ix);
    instructions.push(
      buildIx({
        programId,
        keys: buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, {
          admin: admin.publicKey,
          slab,
          adminAta: refreshedAdminAta.ata,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          vaultPda: vaultAuthority,
        }),
        data: encodeWithdrawInsurance(),
      }),
    );
    await sendStep(connection, admin, `Withdraw insurance (${fmtUsdc(state.engine.insuranceFund.balance)} USDC)`, instructions);
  } else {
    console.log("Withdraw insurance: zero balance");
  }

  if (dryRun) {
    console.log("Close slab and reclaim rent: dry-run (1 ix)");
    console.log("Dry-run complete. Live mode will re-read state after each transaction before continuing.");
    return;
  }

  state = await readState(connection, slab);
  if (!state) {
    console.log("Slab closed after insurance withdrawal.");
    return;
  }

  const actualVaultBeforeClose = await getTokenRaw(connection, vault);
  if (actualVaultBeforeClose && actualVaultBeforeClose > 0n && state.engine.vault === 0n && state.engine.insuranceFund.balance === 0n) {
    const rescueIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_RESCUE_ORPHAN_VAULT, {
        admin: admin.publicKey,
        slab,
        adminAta: adminAtaInfo.ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        vaultPda: vaultAuthority,
      }),
      data: encodeRescueOrphanVault(),
    });
    try {
      await sendStep(connection, admin, `Rescue orphan vault (${fmtUsdc(actualVaultBeforeClose)} USDC)`, [rescueIx]);
    } catch {
      console.log("Rescue orphan vault failed; continuing to normal CloseSlab path.");
    }
  }

  state = await readState(connection, slab);
  if (!state) {
    console.log("Slab closed after rescue step.");
    return;
  }

  const remainingAccounts = state.accounts.filter(({ account }) => accountNeedsClose(account));
  if (remainingAccounts.length > 0) {
    throw new Error(`Cannot close slab: ${remainingAccounts.length} account(s) still non-empty.`);
  }

  try {
    const closeIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_CLOSE_SLAB, {
        dest: admin.publicKey,
        slab,
        vault,
        vaultAuthority,
        destAta: adminAtaInfo.ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      data: encodeCloseSlab(),
    });
    await sendStep(connection, admin, "Close slab and reclaim rent", [closeIx]);
  } catch {
    const orphanIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_CLOSE_ORPHAN_SLAB, {
        admin: admin.publicKey,
        slab,
        vault,
      }),
      data: encodeCloseOrphanSlab(),
    });
    await sendStep(connection, admin, "Close orphan slab and reclaim rent", [orphanIx]);
  }

  const finalState = await readState(connection, slab);
  const finalVault = await getTokenRaw(connection, vault);
  const finalAdminToken = await getTokenRaw(connection, adminAtaInfo.ata);
  const finalSol = await connection.getBalance(admin.publicKey, "confirmed");

  console.log("Final verification:");
  console.log(`  Slab exists: ${finalState ? "yes" : "no"}`);
  console.log(`  Vault token balance: ${fmtUsdc(finalVault)} USDC`);
  console.log(`  Admin token balance: ${fmtUsdc(finalAdminToken)} USDC`);
  console.log(`  Admin SOL balance: ${finalSol / LAMPORTS_PER_SOL} SOL`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
