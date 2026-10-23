// @vitest-environment node
/**
 * NB-2 (2026-10-14): the debug line's `not on devnet: r:<key>` entries for QA's txs (E2XDCUR... = a matcher delegate PDA,
 * 5KqxPq1u... = a vault-authority PDA) are program-derived addresses: no account on ANY cluster, by design. They are
 * classified apart so a real mainnet-only key stands out, and the app's trade/withdraw builders are asserted never to carry
 * a market's mainnet metadata addresses (mainnet_ca, dex_pool_address) as tx keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { DEVNET_GENESIS_HASH } from "@/lib/v22/devnet-guard";
import { __resetSignGuardForTest, forbiddenKeysIn, formatSignEntry, guardSign, noteBlockhash, signLog } from "@/lib/v22/sign-guard";
import { buildTradeIxs } from "@/lib/trade-ix";
import { deriveMatcherDelegate, deriveVaultAuthority } from "@percolatorct/sdk";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const MATCHER = new PublicKey("AsHvEJ8zNctKmdeS57H5E4w6nkTLi3bPVpd6ZCLc2ayN");
const BH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const k = () => Keypair.generate().publicKey;
// the market's mainnet metadata (markets.mainnet_ca / dex_pool_address): addresses that exist only on mainnet
const MAINNET_CA = k();
const DEX_POOL = k();
const FORBIDDEN = new Set([MAINNET_CA.toBase58(), DEX_POOL.toBase58()]);

function tradeTx(): Transaction {
  const market = k(), signer = k(), a = k(), b = k(), ctx = k();
  const [delegate] = deriveMatcherDelegate(WRAPPER, market, b, signer, MATCHER, ctx);
  const tx = new Transaction().add(
    ...buildTradeIxs({
      programId: WRAPPER, signer, market, accountA: a, accountB: b, matcherProg: MATCHER, matcherCtx: ctx, matcherDelegate: delegate,
      takerId: { portfolioId: 1n, positionEpoch: 0n }, lpId: { portfolioId: 2n, positionEpoch: 0n, matcherSequence: 0n },
      marketId: 0n, legs: [], size: 1000n, limitPriceE6: 1_000_000n,
    }),
  );
  tx.recentBlockhash = BH;
  tx.feePayer = signer;
  return tx;
}

describe("NB-2: PDAs are not 'not on devnet'", () => {
  beforeEach(() => { __setDevnetV22ForTest(true); __resetSignGuardForTest(); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { __setDevnetV22ForTest(null); vi.restoreAllMocks(); });

  it("a matcher-delegate / vault-authority PDA is absent by design: listed apart, not as a suspect", async () => {
    const tx = tradeTx();
    const [va] = deriveVaultAuthority(WRAPPER, tx.instructions[0].keys[1].pubkey);
    const strange = k(); // an ON-curve key the cluster does not have: stays a suspect
    tx.instructions[0].keys.push({ pubkey: va, isSigner: false, isWritable: false }, { pubkey: strange, isSigner: false, isWritable: false });
    const c = { getGenesisHash: async () => DEVNET_GENESIS_HASH, isBlockhashValid: async () => ({ context: { slot: 1 }, value: true }), getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(() => null) };
    noteBlockhash(BH, "t", c as never);
    await guardSign({ txs: [tx], via: "x", connection: c as never, chain: "solana:devnet", sign: async () => 1 });
    const e = signLog()[0];
    expect(e.absentPdas?.some((x) => x.endsWith(va.toBase58()))).toBe(true);
    expect(e.absentPdas?.every((x) => !PublicKey.isOnCurve(new PublicKey(x.slice(2)).toBytes()))).toBe(true);
    expect(e.absentOnDevnet).toContain(`r:${strange.toBase58()}`);
    expect(e.absentOnDevnet?.some((x) => x.endsWith(va.toBase58()))).toBe(false);
    expect(formatSignEntry(e)).toMatch(/program-derived address/);
  });

  it("the trade builder never carries a market's mainnet metadata addresses as tx keys", () => {
    expect(forbiddenKeysIn(tradeTx(), FORBIDDEN)).toEqual([]);
  });

  it("NEGATIVE CONTROL: the check does catch a mainnet-metadata key if one is added", () => {
    const tx = tradeTx();
    tx.instructions[0].keys.push({ pubkey: DEX_POOL, isSigner: false, isWritable: false });
    expect(forbiddenKeysIn(tx, FORBIDDEN)).toEqual([DEX_POOL.toBase58()]);
  });
});
