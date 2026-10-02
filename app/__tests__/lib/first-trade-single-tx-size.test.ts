// @vitest-environment node
/**
 * GH#2959: the first trade is ONE transaction. With the REAL builders it must fit Solana's
 * 1232-byte packet with both signatures (wallet + portfolio keypair) and the compute-budget
 * prefix sendTx adds. Measured live 2026-10-02 (Percolator 9EPm8nB8, Jimothy CzKxVxPm): 811 bytes,
 * 13 accounts, 323-333k CU.
 */
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { buildFirstTradeInitIxs, buildFundAndTradeIxs } from "@/lib/first-trade";
import { FIRST_TRADE_CU_CAP } from "@/hooks/useFirstTrade";

const PACKET = 1232;
const pk = () => Keypair.generate().publicKey;

function firstTradeTx(feeBps?: bigint) {
  const wallet = Keypair.generate();
  const portfolio = Keypair.generate();
  const programId = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
  const market = pk();
  const p = {
    programId, owner: wallet.publicKey, market, portfolio: portfolio.publicKey, userAta: pk(), vaultTokenAta: pk(),
    depositAtoms: 123_456_789_012n,
    lp: { accountB: pk(), matcherProg: pk(), matcherCtx: pk(), matcherDelegate: pk() },
    lpId: { portfolioId: 2n ** 40n, positionEpoch: 2n ** 40n, matcherSequence: 2n ** 40n },
    marketId: 2n ** 40n, size: -(2n ** 60n), limitPriceE6: 2n ** 50n, feeBps, marketTradeFeeBps: 5n,
  };
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: FIRST_TRADE_CU_CAP }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }));
  for (const ix of buildFirstTradeInitIxs(p, 10_000_000)) tx.add(ix);
  for (const ix of buildFundAndTradeIxs(p, { portfolioId: 2n ** 40n, sequence: 0n, positionEpoch: 0n })) tx.add(ix);
  tx.recentBlockhash = pk().toBase58();
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet, portfolio);
  return tx;
}

describe("GH#2959 first-trade single transaction fits", () => {
  it("serialises under 1232 bytes with both signatures (no fee channel)", () => {
    const tx = firstTradeTx();
    expect(tx.signatures).toHaveLength(2);
    expect(tx.serialize().length).toBeLessThanOrEqual(PACKET);
  });

  it("and with the P2 fee channel set (the largest trade data)", () => {
    const n = firstTradeTx(50n).serialize().length;
    expect(n).toBeLessThanOrEqual(PACKET);
    // headroom: well under the packet, so an extra account or two never tips it over
    expect(n).toBeLessThan(PACKET - 200);
  });

  it("CU cap stays inside one transaction's 1.4M", () => {
    expect(FIRST_TRADE_CU_CAP).toBeLessThanOrEqual(1_400_000);
    expect(FIRST_TRADE_CU_CAP).toBeGreaterThan(400_000);
  });
});
