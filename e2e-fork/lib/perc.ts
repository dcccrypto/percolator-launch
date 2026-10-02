/**
 * Chain-level client for the e2e-fork harness: throwaway wallets, the v18 user
 * instructions (built with @percolatorct/sdk 8.0.0, account shapes copied from the
 * P0a seed's proven paths), and on-chain STATE READERS used as assertions.
 * LOCAL ONLY — every Connection is asserted to be 127.0.0.1/localhost.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  buildIx, buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_TRADE_CPI, ACCOUNTS_PERMISSIONLESS_CRANK_BASE, ACCOUNTS_LP_VAULT_DEPOSIT, ACCOUNTS_WITHDRAW_CREATOR_FEE,
  encodeInitUser, encodeDepositCollateral, encodeWithdrawCollateral, encodeTradeCpi, encodePermissionlessCrank,
  encodeDepositToLpVault, encodeStakeDeposit, encodeStakeWithdraw, encodeStakeAccrueFees, encodeNftMint, encodeNftBurn,
  encodeExpireBackingBucket, encodeWithdrawCreatorFee,
  depositAccounts, withdrawAccounts, accrueFeesAccounts,
  deriveDepositPda, deriveLpVaultRegistry, deriveLpBackingLedger, deriveNftPda, deriveMintAuthority,
  deriveExtraAccountMetas, deriveNftRegistry,
  parsePortfolioV17, parseWrapperConfigV17, parseBackingBucketsV17, parseAssetOracleProfileV17,
  parseMarketGroupV17OI, parseLpVaultRegistry, decodeStakePool,
  V17_HEADER_LEN, V17_PORTFOLIO_ACCOUNT_LEN, V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN, V17_ASSET_ORACLE_WRAPPER_LEN,
} from "@percolatorct/sdk";
import { assertLocal, rpc } from "./chain.ts";

export const HARNESS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const RUN = process.env.RUN_DIR ?? path.join(HARNESS, ".run");
export const RPC = process.env.RPC ?? "http://127.0.0.1:38599";
export const WRAPPER = new PublicKey(process.env.WRAPPER_PROGRAM_ID ?? "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
export const STAKE = new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3");
export const NFT = new PublicKey("CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3");
export const MATCHER = new PublicKey("4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT");
export const USDC = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
assertLocal(RPC);

export const conn = new Connection(RPC, { commitment: "confirmed", wsEndpoint: RPC.replace("http", "ws").replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`) });

function loadKp(p: string): Keypair { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))); }
export const admin = loadKp(path.join(RUN, "home/.config/solana/percolator-v17-devnet.json"));
export const mintAuth = loadKp(path.join(RUN, "home/.config/solana/percolator-devnet-mint-authority.json"));

export interface SeedMarket {
  shortSym: string; symbol: string; slab: string; lpPortfolio: string; matcherCtx: string; matcherDelegate: string;
  vaultAta: string; vaultAuth: string; stakePool: string; stakeVault: string; stakeVaultAuth: string; stakeLpMint: string;
  lpVaultRegistry: string; lpVaultMint: string; nftRegistry: string; pool: string; dexType: string; priceE6: string;
}
export function markets(): Record<string, SeedMarket> {
  const s = JSON.parse(fs.readFileSync(path.join(RUN, "seed-state.json"), "utf8"));
  const all = Object.fromEntries(Object.entries(s.markets as Record<string, SeedMarket & { allGreen: boolean }>).filter(([, m]) => m.allGreen));
  // E2E_REMAP="BURNIE=TRUMP,Percolator=TRUMP": keep journeys off markets reserved by a concurrent drill
  for (const pair of (process.env.E2E_REMAP ?? "").split(",").filter(Boolean)) { const [from, to] = pair.split("="); if (all[to]) all[from] = all[to]; }
  return all;
}
export const pk = (s: string) => new PublicKey(s);

// ── tx ────────────────────────────────────────────────────────────────────────
export interface TxResult { ok: boolean; sig?: string; err?: string; logs: string[]; units?: number }
export function customCode(err?: string): number | null {
  const m = err?.match(/"Custom":(\d+)/); return m ? Number(m[1]) : null;
}
export async function send(ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number; simulateOnly?: boolean; heap?: boolean } = {}): Promise<TxResult> {
  const tx = new Transaction();
  if (opts.heap !== false) tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu ?? 1_000_000 }));
  for (const ix of ixs) tx.add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sim = await conn.simulateTransaction(tx);
  const logs = sim.value.logs ?? [];
  if (sim.value.err) return { ok: false, err: JSON.stringify(sim.value.err), logs, units: sim.value.unitsConsumed };
  if (opts.simulateOnly) return { ok: true, logs, units: sim.value.unitsConsumed };
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const bh = await conn.getLatestBlockhash("confirmed");
  const c = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (c.value.err) return { ok: false, sig, err: JSON.stringify(c.value.err), logs };
  return { ok: true, sig, logs, units: sim.value.unitsConsumed };
}
export async function mustSend(label: string, ixs: TransactionInstruction[], signers: Keypair[], opts: { cu?: number } = {}): Promise<string> {
  const r = await send(ixs, signers, opts);
  if (!r.ok) throw new Error(`${label} failed: ${r.err}\n  ${r.logs.slice(-8).join("\n  ")}`);
  return r.sig!;
}

// ── wallets ───────────────────────────────────────────────────────────────────
/** Throwaway wallet: local SOL via surfnet_setAccount, Sim-USDC minted by the sandbox mint authority. */
export async function newWallet(opts: { sol?: number; usdc?: bigint } = {}): Promise<Keypair> {
  const kp = Keypair.generate();
  // fork-only throwaway: persisted so wind-down journeys can owner-sign every portfolio close
  fs.appendFileSync(path.join(RUN, "wallets.jsonl"), JSON.stringify({ pk: kp.publicKey.toBase58(), sk: Array.from(kp.secretKey) }) + "\n");
  await rpc(RPC, "surfnet_setAccount", [kp.publicKey.toBase58(), { lamports: Math.round((opts.sol ?? 5) * LAMPORTS_PER_SOL) }]);
  if ((opts.usdc ?? 0n) > 0n) await mintUsdc(kp.publicKey, opts.usdc!);
  return kp;
}
export async function mintUsdc(owner: PublicKey, amount: bigint): Promise<void> {
  const ata = getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID);
  await mustSend("mintUsdc", [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, owner, USDC, TOKEN_PROGRAM_ID),
    createMintToInstruction(USDC, ata, mintAuth.publicKey, amount, [], TOKEN_PROGRAM_ID),
  ], [admin, mintAuth], { cu: 200_000 });
}
export async function usdcBalance(owner: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID);
  const b = await conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  return b ? BigInt(b.value.amount) : 0n;
}
export async function tokenBalance(ata: PublicKey): Promise<bigint> {
  const b = await conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  return b ? BigInt(b.value.amount) : 0n;
}

// ── readers (assertions read these) ──────────────────────────────────────────
async function data(a: PublicKey): Promise<Uint8Array> {
  const i = await conn.getAccountInfo(a, "confirmed");
  if (!i) throw new Error(`account ${a.toBase58()} not found`);
  return new Uint8Array(i.data);
}
function u64(d: Uint8Array, o: number): bigint { return new DataView(d.buffer, d.byteOffset).getBigUint64(o, true); }
function u128(d: Uint8Array, o: number): bigint { return u64(d, o) | (u64(d, o + 8) << 64n); }
const ASSET0 = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
/** engine-owned AssetStateV16 for asset i (after the wrapper prefix) */
function engineOff(asset = 0) { return ASSET0 + asset * V17_MARKET_ASSET_SLOT_LEN + V17_ASSET_ORACLE_WRAPPER_LEN; }
const SIDE_MODE = ["Normal", "DrainOnly", "ResetPending"] as const;

export interface MarketState {
  chainSlot: bigint; engineSlot: bigint; lag: bigint;
  markE6: bigint; lastGoodOracleSlot: bigint;
  vaultTokens: bigint;
  fees: { protocolAccrued: bigint; protocolWithdrawn: bigint; lpAccrued: bigint; lpWithdrawn: bigint; insReserveAccrued: bigint; insReserveWithdrawn: bigint; creatorClaimable: bigint };
  buckets: { domain: number; status: string; expiry: bigint; lapsed: boolean; freshUnliened: bigint }[];
  sideMode: { long: string; short: string };
  aLong: bigint; aShort: bigint; reduceOnly: boolean;
  oi: unknown;
  marketId: bigint;
}
export async function readMarket(m: SeedMarket): Promise<MarketState> {
  const d = await data(pk(m.slab));
  const chainSlot = BigInt(await conn.getSlot("confirmed"));
  const cfg = parseWrapperConfigV17(d, V17_HEADER_LEN);
  const bb = parseBackingBucketsV17(d, { chainSlot });
  const prof = parseAssetOracleProfileV17(d, ASSET0);
  const e = engineOff(0);
  return {
    chainSlot, engineSlot: bb.headerCurrentSlot, lag: chainSlot - bb.headerCurrentSlot,
    markE6: cfg.markEwmaE6, lastGoodOracleSlot: cfg.lastGoodOracleSlot,
    vaultTokens: m.vaultAta ? await tokenBalance(pk(m.vaultAta)) : 0n,
    fees: {
      protocolAccrued: cfg.protocolFeeAccruedAtoms, protocolWithdrawn: cfg.protocolFeeWithdrawnAtoms,
      lpAccrued: cfg.lpFeeAccruedAtoms, lpWithdrawn: (cfg as any).lpFeeWithdrawnAtoms ?? 0n,
      insReserveAccrued: cfg.insuranceReserveAccruedAtoms, insReserveWithdrawn: cfg.insuranceReserveWithdrawnAtoms,
      creatorClaimable: prof.creatorFeeClaimableAtoms,
    },
    buckets: bb.buckets.map((b: any) => ({ domain: b.domain, status: b.statusName, expiry: b.expirySlot, lapsed: b.lapsed, freshUnliened: b.freshUnlienedBackingNum })),
    sideMode: { long: SIDE_MODE[d[e + 513]] ?? `?${d[e + 513]}`, short: SIDE_MODE[d[e + 514]] ?? `?${d[e + 514]}` },
    // engine A_side (u128 @ +49/+65; limits-ui constants.ts, engine lib.rs ADL_ONE = 1e15): reduce-only while either != ADL_ONE
    aLong: u128(d, e + 49), aShort: u128(d, e + 65),
    reduceOnly: u128(d, e + 49) !== 1_000_000_000_000_000n || u128(d, e + 65) !== 1_000_000_000_000_000n,
    oi: parseMarketGroupV17OI(d),
    marketId: u64(d, e),
  };
}
export interface PortState { owner: string; capital: bigint; pnl: bigint; legs: { assetIndex?: number; basisPosQ: bigint; marketId: bigint }[]; portfolioId: bigint; matcherSequence: bigint; positionEpoch: bigint }
export async function readPortfolio(p: PublicKey): Promise<PortState> {
  const x = parsePortfolioV17(await data(p));
  return {
    owner: x.owner.toBase58(), capital: x.capital, pnl: x.pnl,
    legs: x.legs.filter((l: any) => l.active).map((l: any) => ({ basisPosQ: l.basisPosQ, marketId: l.marketId })),
    portfolioId: x.portfolioId, matcherSequence: x.matcherSequence, positionEpoch: x.matcherPositionEpoch,
  };
}
export async function readLpVault(m: SeedMarket) { return parseLpVaultRegistry(await data(pk(m.lpVaultRegistry))); }
export async function readStakePool(m: SeedMarket) { return decodeStakePool(Buffer.from(await data(pk(m.stakePool)))); }

// ── user instructions ─────────────────────────────────────────────────────────
export async function createPortfolio(owner: Keypair, m: SeedMarket): Promise<PublicKey> {
  const port = Keypair.generate();
  const lam = await conn.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);
  await mustSend("createPortfolio", [
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: port.publicKey, space: V17_PORTFOLIO_ACCOUNT_LEN, lamports: lam, programId: WRAPPER }),
    buildIx({ programId: WRAPPER, keys: buildAccountMetas(ACCOUNTS_INIT_USER, { owner: owner.publicKey, market: pk(m.slab), portfolio: port.publicKey }), data: encodeInitUser() }),
  ], [owner, port]);
  return port.publicKey;
}
export async function depositIx(owner: PublicKey, m: SeedMarket, port: PublicKey, amount: bigint) {
  const id = await readPortfolio(port);
  return buildIx({
    programId: WRAPPER,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
      owner, market: pk(m.slab), portfolio: port, sourceToken: getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID),
      vaultToken: pk(m.vaultAta), tokenProgram: TOKEN_PROGRAM_ID,
    }),
    data: encodeDepositCollateral({ portfolioId: id.portfolioId, expectedSequence: id.matcherSequence, amount }),
  });
}
export async function withdrawIx(owner: PublicKey, m: SeedMarket, port: PublicKey, amount: bigint) {
  const id = await readPortfolio(port);
  return buildIx({
    programId: WRAPPER,
    keys: buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, {
      owner, market: pk(m.slab), portfolio: port, vaultToken: pk(m.vaultAta), destToken: getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID),
      vaultAuthority: pk(m.vaultAuth), tokenProgram: TOKEN_PROGRAM_ID,
    } as any),
    data: encodeWithdrawCollateral({ portfolioId: id.portfolioId, expectedSequence: id.matcherSequence, amount } as any),
  });
}
export async function tradeIx(signer: PublicKey, m: SeedMarket, port: PublicKey, sizeQ: bigint, opts: { limitPrice?: bigint } = {}) {
  const [a, b, md] = await Promise.all([readPortfolio(port), readPortfolio(pk(m.lpPortfolio)), data(pk(m.slab))]);
  return buildIx({
    programId: WRAPPER,
    keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, {
      signerA: signer, market: pk(m.slab), accountA: port, accountB: pk(m.lpPortfolio),
      matcherProg: MATCHER, matcherCtx: pk(m.matcherCtx), matcherDelegate: pk(m.matcherDelegate),
    }),
    data: encodeTradeCpi({
      accountAPortfolioId: a.portfolioId, accountAPositionEpoch: a.positionEpoch,
      accountBPortfolioId: b.portfolioId, accountBPositionEpoch: b.positionEpoch, accountBMatcherSequence: b.matcherSequence,
      assetIndex: 0, marketId: u64(md, engineOff(0)), sizeQ, feeBps: 30n, limitPrice: opts.limitPrice ?? 0n, backingFeeCapBps: 0,
    }),
  });
}
export function crankIx(caller: PublicKey, m: SeedMarket, portfolio: PublicKey = pk(m.lpPortfolio)) {
  return buildIx({
    programId: WRAPPER,
    keys: buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, { owner: caller, market: pk(m.slab), portfolio }),
    data: encodePermissionlessCrank({ nowSlot: 0n, observations: [{ assetIndex: 0, oracleAccounts: 0 }] }),
  });
}
/** Size in base q for a USD notional at the current mark. */
export async function qForUsd(m: SeedMarket, usd: number): Promise<bigint> {
  const st = await readMarket(m);
  return (BigInt(Math.round(usd * 1e6)) * 1_000_000n) / st.markE6;
}

// ── Earn (LP vault) ───────────────────────────────────────────────────────────
/** P3: when the LP-vault registry is bound to a vault-owned LP, tags 75/77/78 need the bound-vault tail. */
export async function withP3TailIfBound(ix: TransactionInstruction, m: SeedMarket): Promise<TransactionInstruction> {
  const sdk = await import("@percolatorct/sdk") as any;
  if (!sdk.isLpVaultRegistryBoundP3) return ix;
  const reg = await conn.getAccountInfo(pk(m.lpVaultRegistry));
  if (!reg || !sdk.isLpVaultRegistryBoundP3(new Uint8Array(reg.data))) return ix;
  const av = sdk.decodeAssetVaultLpP3(new Uint8Array((await conn.getAccountInfo(pk(m.slab)))!.data), 0);
  const [vls] = sdk.deriveVaultLpStateP3(WRAPPER, pk(m.slab));
  return sdk.withBoundVaultLpTailP3(ix, vls, av.vaultLpPortfolio);
}
export async function lpVaultDepositIxs(owner: PublicKey, m: SeedMarket, amount: bigint, domain = 0) {
  const lpMint = pk(m.lpVaultMint);
  const lpAta = getAssociatedTokenAddressSync(lpMint, owner, false, TOKEN_PROGRAM_ID);
  const [ledger0] = deriveLpBackingLedger(WRAPPER, pk(m.slab), 0);
  const [ledger1] = deriveLpBackingLedger(WRAPPER, pk(m.slab), 1);
  return {
    lpAta,
    ixs: [
      createAssociatedTokenAccountIdempotentInstruction(owner, lpAta, owner, lpMint, TOKEN_PROGRAM_ID),
      await withP3TailIfBound(buildIx({
        programId: WRAPPER,
        keys: buildAccountMetas(ACCOUNTS_LP_VAULT_DEPOSIT, {
          depositor: owner, market: pk(m.slab), registry: pk(m.lpVaultRegistry), lpMint, depositorLpAta: lpAta,
          sourceToken: getAssociatedTokenAddressSync(USDC, owner, false, TOKEN_PROGRAM_ID), vaultToken: pk(m.vaultAta), ledger: ledger0,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, siblingLedger: ledger1,
        }),
        data: encodeDepositToLpVault({ amount, domain }),
      }), m),
    ],
  };
}

// ── Stake ────────────────────────────────────────────────────────────────────
export function stakeDepositIxs(user: PublicKey, m: SeedMarket, amount: bigint) {
  const lpMint = pk(m.stakeLpMint);
  const userLpAta = getAssociatedTokenAddressSync(lpMint, user, false, TOKEN_PROGRAM_ID);
  const [depositPda] = deriveDepositPda(pk(m.stakePool), user, STAKE);
  return {
    userLpAta,
    ixs: [
      createAssociatedTokenAccountIdempotentInstruction(user, userLpAta, user, lpMint, TOKEN_PROGRAM_ID),
      buildIx({
        programId: STAKE,
        keys: depositAccounts({
          user, pool: pk(m.stakePool), userCollateralAta: getAssociatedTokenAddressSync(USDC, user, false, TOKEN_PROGRAM_ID),
          vault: pk(m.stakeVault), lpMint, userLpAta, vaultAuth: pk(m.stakeVaultAuth), depositPda, slab: pk(m.slab),
        }),
        data: encodeStakeDeposit(amount),
      }),
    ],
  };
}
export function stakeWithdrawIx(user: PublicKey, m: SeedMarket, lpAmount: bigint) {
  const lpMint = pk(m.stakeLpMint);
  const [depositPda] = deriveDepositPda(pk(m.stakePool), user, STAKE);
  return buildIx({
    programId: STAKE,
    keys: withdrawAccounts({
      user, pool: pk(m.stakePool), userLpAta: getAssociatedTokenAddressSync(lpMint, user, false, TOKEN_PROGRAM_ID), lpMint,
      vault: pk(m.stakeVault), userCollateralAta: getAssociatedTokenAddressSync(USDC, user, false, TOKEN_PROGRAM_ID),
      vaultAuth: pk(m.stakeVaultAuth), depositPda, slab: pk(m.slab),
    }),
    data: encodeStakeWithdraw(lpAmount),
  });
}
export function stakeAccrueIx(caller: PublicKey, m: SeedMarket) {
  return buildIx({ programId: STAKE, keys: accrueFeesAccounts({ caller, pool: pk(m.stakePool), vault: pk(m.stakeVault), slab: pk(m.slab) }), data: encodeStakeAccrueFees() });
}

// ── NFT ──────────────────────────────────────────────────────────────────────
export function nftMintIx(owner: PublicKey, m: SeedMarket, port: PublicKey, marketId: bigint, nftMint: PublicKey) {
  const [nftPda] = deriveNftPda(port, marketId, NFT);
  const [mintAuthPda] = deriveMintAuthority(NFT);
  const [extraMetas] = deriveExtraAccountMetas(nftMint, NFT);
  const [nftRegistry] = deriveNftRegistry(WRAPPER, pk(m.slab));
  const ownerAta = getAssociatedTokenAddressSync(nftMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const ix = new TransactionInstruction({
    programId: NFT,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: nftPda, isSigner: false, isWritable: true },
      { pubkey: nftMint, isSigner: true, isWritable: true }, { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: port, isSigner: false, isWritable: true }, { pubkey: mintAuthPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: extraMetas, isSigner: false, isWritable: true },
      { pubkey: nftRegistry, isSigner: false, isWritable: false }, { pubkey: WRAPPER, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeNftMint(0)),
  });
  return { ix, nftPda, ownerAta, extraMetas, nftRegistry, mintAuthPda };
}
export function nftBurnIx(holder: PublicKey, m: SeedMarket, port: PublicKey, marketId: bigint, nftMint: PublicKey) {
  const [nftPda] = deriveNftPda(port, marketId, NFT);
  const [mintAuthPda] = deriveMintAuthority(NFT);
  const [extraMetas] = deriveExtraAccountMetas(nftMint, NFT);
  const [nftRegistry] = deriveNftRegistry(WRAPPER, pk(m.slab));
  const holderAta = getAssociatedTokenAddressSync(nftMint, holder, false, TOKEN_2022_PROGRAM_ID);
  return new TransactionInstruction({
    programId: NFT,
    keys: [
      { pubkey: holder, isSigner: true, isWritable: true }, { pubkey: nftPda, isSigner: false, isWritable: true },
      { pubkey: nftMint, isSigner: false, isWritable: true }, { pubkey: holderAta, isSigner: false, isWritable: true },
      { pubkey: port, isSigner: false, isWritable: true }, { pubkey: mintAuthPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: extraMetas, isSigner: false, isWritable: true },
      { pubkey: nftRegistry, isSigner: false, isWritable: false }, { pubkey: WRAPPER, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeNftBurn()),
  });
}

// ── repairs / forced conditions ───────────────────────────────────────────────
export function expireBucketIx(m: SeedMarket, domain: number) {
  return new TransactionInstruction({ programId: WRAPPER, keys: [{ pubkey: pk(m.slab), isSigner: false, isWritable: true }], data: Buffer.from(encodeExpireBackingBucket({ domain } as any)) });
}
export { ACCOUNTS_WITHDRAW_CREATOR_FEE, encodeWithdrawCreatorFee, deriveLpVaultRegistry, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID };

/** Wait (real time, ~400 ms/slot) until the chain has advanced N slots. surfpool --offline
 *  cannot time-travel (slotsInEpoch=0 → time_travel.rs:101 panics), and real elapsed
 *  slots are the honest model of "the keeper was down for N minutes" anyway. */
export async function advanceSlots(n: number, maxMs = 20 * 60_000): Promise<void> {
  const target = (await conn.getSlot("confirmed")) + n;
  const t0 = Date.now();
  while ((await conn.getSlot("confirmed")) < target && Date.now() - t0 < maxMs) await sleep(2000);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Portfolios owned by `owner` in market `m` (on-chain scan; used to assert UI-created accounts). */
export async function findPortfolios(owner: PublicKey, m: SeedMarket): Promise<PublicKey[]> {
  const accs = await conn.getProgramAccounts(WRAPPER, { filters: [{ dataSize: V17_PORTFOLIO_ACCOUNT_LEN }] });
  const out: PublicKey[] = [];
  for (const a of accs) {
    try {
      const p = parsePortfolioV17(new Uint8Array(a.account.data)) as any;
      if (p.owner.equals(owner) && p.marketGroupId.equals(pk(m.slab))) out.push(a.pubkey);
    } catch { /* not a portfolio */ }
  }
  return out;
}
/** Instructions (program + tag byte) of a landed tx — proves what the wallet actually signed. */
export async function txIxs(sig: string): Promise<{ program: string; tag: number }[]> {
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t) return [];
  const keys = t.transaction.message.getAccountKeys().staticAccountKeys;
  return t.transaction.message.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex].toBase58(), tag: ix.data[0] }));
}
