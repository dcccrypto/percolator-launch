/**
 * Council r10 recheck D1: the funding counter at the open, written into the opening transaction so any device can read it back from chain.
 *
 * The Trade result and the close estimate need `counters_at_open` (lib/funding-flow.ts). Standard RPC cannot read an account as it was at an older
 * slot, and the wrapper logs no funding event, so a device that did not place the trade had no way to get it. But while a portfolio holds NO
 * active leg its funding counters cannot move (the engine only moves them when it settles a leg), so the value read just before an open from flat
 * IS the value at the open. The app puts it in an SPL Memo instruction of that same transaction: `perc:fb1:<net paid atoms>`. The memo is
 * signed by the trader's wallet with the trade, so it lands only if the trade lands. The chain walk (lib/entry-chain.ts) reads it from the
 * opening fill's own instruction data.
 *
 * Written only for an open from flat with zero active legs (anything else can move the counters between the read and the fill). A trade that
 * is not such an open carries no memo, and a memo in any transaction other than the opening fill is ignored.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { FundingSample } from "@/lib/funding-flow";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PREFIX = "perc:fb1:";
const RE = /^perc:fb1:(-?\d{1,30})$/;

export function fundingMemoText(netPaid: bigint): string {
  return `${PREFIX}${netPaid.toString()}`;
}

export function fundingMemoIx(netPaid: bigint): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(fundingMemoText(netPaid), "utf8") });
}

/**
 * The memo for a trade, or null when it must not carry one. `before` is the taker portfolio as read right before the trade (null = not read).
 * Only an open from flat on a portfolio with no active leg qualifies: then the counters cannot change before the fill.
 */
export function openFundingMemoIx(before: { q: bigint; funding: FundingSample | null } | null | undefined): TransactionInstruction | null {
  if (!before || before.q !== 0n || !before.funding || before.funding.legs !== 0) return null;
  return fundingMemoIx(before.funding.netPaid);
}

/** A brand-new portfolio (created in the same transaction) starts with every counter at zero. */
export function newPortfolioFundingMemoIx(): TransactionInstruction {
  return fundingMemoIx(0n);
}

/**
 * The funding base a transaction's memo states, from its signed instruction data. Null when there is no memo of ours, or more than one
 * (never guess which one counts).
 */
export function fundingBaseFromTx(
  message: { staticAccountKeys?: readonly PublicKey[]; compiledInstructions?: readonly { programIdIndex: number; data: Uint8Array }[] } | null | undefined,
): bigint | null {
  const keys = message?.staticAccountKeys;
  const ixs = message?.compiledInstructions;
  if (!keys || !ixs) return null;
  let found: bigint | null = null;
  let n = 0;
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(MEMO_PROGRAM_ID)) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(ix.data);
    } catch {
      continue;
    }
    const m = RE.exec(text);
    if (!m) continue;
    n++;
    found = BigInt(m[1]);
  }
  return n === 1 ? found : null;
}

/** True for the error a transaction too large to serialize throws (the memo is then dropped and the trade sent without it). */
export function isTxTooLarge(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /too large|encoding overruns/i.test(m);
}

/** Room kept for what the send path adds after this point (compute-budget instructions, a self-heal crank prefix). */
export const MEMO_SIZE_HEADROOM = 200;
const PACKET = 1232;

const compactLen = (n: number): number => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/** Serialized size of a legacy transaction holding `ixs` (signatures included), counted from the wire format (no serializer involved). */
export function legacyTxSize(ixs: readonly TransactionInstruction[], feePayer: PublicKey): number {
  const keys = new Set<string>([feePayer.toBase58()]);
  const signers = new Set<string>([feePayer.toBase58()]);
  let ixBytes = 0;
  for (const ix of ixs) {
    keys.add(ix.programId.toBase58());
    for (const k of ix.keys) {
      keys.add(k.pubkey.toBase58());
      if (k.isSigner) signers.add(k.pubkey.toBase58());
    }
    ixBytes += 1 + compactLen(ix.keys.length) + ix.keys.length + compactLen(ix.data.length) + ix.data.length;
  }
  const message = 3 + compactLen(keys.size) + 32 * keys.size + 32 + compactLen(ixs.length) + ixBytes;
  return compactLen(signers.size) + 64 * signers.size + message;
}

/** The memo when the transaction still fits with it and the headroom; otherwise null (the trade goes without it). */
export function memoIfFits(ixs: readonly TransactionInstruction[], memo: TransactionInstruction | null, feePayer: PublicKey | null | undefined): TransactionInstruction | null {
  if (!memo || !feePayer) return null;
  return legacyTxSize([...ixs, memo], feePayer) + MEMO_SIZE_HEADROOM <= PACKET ? memo : null;
}

/**
 * Sends `ixs` with the memo appended; if that transaction is too large to serialize, sends it once more without the memo. Any other error is
 * the trade's own and is rethrown untouched. A missing memo only means other devices cannot rebuild the funding: never a reason to block a trade.
 */
export async function sendWithFundingMemo(ixs: TransactionInstruction[], memoIn: TransactionInstruction | null, send: (ixs: TransactionInstruction[]) => Promise<string>, feePayer?: PublicKey | null): Promise<string> {
  const memo = feePayer === undefined ? memoIn : memoIfFits(ixs, memoIn, feePayer);
  if (!memo) return send(ixs);
  let sig: string;
  try {
    sig = await send([...ixs, memo]);
  } catch (e) {
    if (isTxTooLarge(e)) return send(ixs);
    throw e;
  }
  const base = fundingBaseFromTx({ staticAccountKeys: [MEMO_PROGRAM_ID], compiledInstructions: [{ programIdIndex: 0, data: memo.data }] });
  if (base !== null) noteMemoBase(sig, base);
  return sig;
}

// The base this device wrote into a landed open, by signature: the trading device's own trade book uses the same number as every other
// device (lib/trade-book.ts `fundingBefore`), and needs no post-trade read for it.
const memoBases = new Map<string, bigint>();
export function noteMemoBase(sig: string, base: bigint): void {
  memoBases.set(sig, base);
  if (memoBases.size > 50) memoBases.delete(memoBases.keys().next().value as string);
}
export function memoBaseFor(sig: string | null | undefined): bigint | null {
  return sig ? memoBases.get(sig) ?? null : null;
}
