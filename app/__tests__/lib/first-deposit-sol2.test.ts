// @vitest-environment node
/**
 * SOL-2 (v2.2 QA 2026-10-11): a new user can deposit WITHOUT trading. `createAndDeposit` (hooks/useFirstTrade.ts)
 * sends ONE tx [CreateAccount, InitPortfolio, Deposit(predicted id, sequence 0)]: exactly the first trade's legs
 * minus the trade. Verified on devnet (ledger v22-qa-issues.md SOL-2); here the instruction bytes are pinned.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildFirstDepositIx, buildFirstTradeInitIxs, buildFundAndTradeIxs, type FirstTradeIxParams } from "@/lib/first-trade";

const k = () => Keypair.generate().publicKey;
const base = {
  programId: new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM"),
  owner: k(), market: k(), portfolio: k(), userAta: k(), vaultTokenAta: k(), depositAtoms: 25_000_000n,
};

describe("SOL-2 standalone first deposit", () => {
  it("the deposit leg is byte-identical to the first trade's deposit leg (same accounts, predicted id, sequence 0)", () => {
    const p: FirstTradeIxParams = {
      ...base,
      lp: { accountB: k(), matcherProg: k(), matcherCtx: k(), matcherDelegate: k() },
      lpId: { portfolioId: 1n, positionEpoch: 0n, matcherSequence: 0n },
      marketId: 7n, size: 1000n, limitPriceE6: 1n, feeBps: 135n,
    };
    const id = { portfolioId: 42n, sequence: 0n, positionEpoch: 0n };
    const viaTrade = buildFundAndTradeIxs(p, id)[0];
    const alone = buildFirstDepositIx(base, id);
    expect(Buffer.from(alone.data).equals(Buffer.from(viaTrade.data))).toBe(true);
    expect(alone.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual(viaTrade.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]));
    expect(alone.programId.equals(base.programId)).toBe(true);
  });
  it("create + init + deposit carries no trade instruction (nothing is traded)", () => {
    const ixs = [...buildFirstTradeInitIxs(base, 1_000_000), buildFirstDepositIx(base, { portfolioId: 42n, sequence: 0n })];
    expect(ixs).toHaveLength(3);
    // tag 10 = TradeCpi: never present
    expect(ixs.filter((ix) => ix.programId.equals(base.programId)).some((ix) => ix.data[0] === 10)).toBe(false);
  });
  it("NEGATIVE CONTROL: a different predicted id changes the deposit bytes (the id is really bound)", () => {
    const a = buildFirstDepositIx(base, { portfolioId: 42n, sequence: 0n });
    const b = buildFirstDepositIx(base, { portfolioId: 43n, sequence: 0n });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
  });
});
