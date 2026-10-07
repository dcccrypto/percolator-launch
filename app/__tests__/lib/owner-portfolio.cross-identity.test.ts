/**
 * #2560 (review of #3138, blocking): the wallet's CROSS / primary portfolio is the lowest base58
 * pubkey. An isolated portfolio created with a plain random Keypair sorted below it about half
 * the time and silently became "primary": cross trades, deposits and the dock badges then moved
 * into the isolated account. These tests pin the three things that keep identity stable:
 *   1. ONE code-unit comparator (never localeCompare, which is locale- and case-folding);
 *   2. isolated keypairs are ground to sort AFTER the primary;
 *   3. therefore pickOwnerPortfolio / listOwnerPortfolios keep returning the original cross.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import {
  compareBase58,
  comparePortfolioPubkeys,
  generateIsolatedKeypair,
  IsolatedKeypairError,
  listOwnerPortfolios,
  pickOwnerPortfolio,
  OWNER_PORTFOLIO_OWNER_OFF,
} from "@/lib/owner-portfolio";

const owner = Keypair.generate().publicKey;

vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  return {
    ...real,
    parsePortfolioV17: (d: Uint8Array) => ({ owner: new PublicKey(d.slice(OWNER_PORTFOLIO_OWNER_OFF, OWNER_PORTFOLIO_OWNER_OFF + 32)) }),
  };
});

function acct(pubkey: PublicKey) {
  const d = Buffer.alloc(V17_PORTFOLIO_ACCOUNT_LEN);
  owner.toBuffer().copy(d, OWNER_PORTFOLIO_OWNER_OFF);
  return { pubkey, account: { data: d } };
}

/** A keypair whose base58 starts with a character matching `pred`. */
function keypairStartingWith(pred: (c: string) => boolean): Keypair {
  for (;;) {
    const kp = Keypair.generate();
    if (pred(kp.publicKey.toBase58()[0])) return kp;
  }
}

describe("one code-unit comparator for 'primary'", () => {
  it("compareBase58 is plain code-unit order: uppercase before lowercase", () => {
    expect(compareBase58("Bx", "aX")).toBeLessThan(0);
    expect(compareBase58("aX", "Bx")).toBeGreaterThan(0);
    expect(compareBase58("same", "same")).toBe(0);
  });

  it("listOwnerPortfolios orders mixed-case base58 by code unit (localeCompare would put the lowercase key first)", () => {
    // lowercase 'a'..'f' vs uppercase 'H'..'Z': alphabetical (localeCompare) says a < H, code unit says H < a.
    const lower = keypairStartingWith((c) => c >= "a" && c <= "f").publicKey;
    const upper = keypairStartingWith((c) => c >= "H" && c <= "Z").publicKey;
    expect(lower.toBase58() < upper.toBase58()).toBe(false); // code unit: the uppercase key is first
    const listed = listOwnerPortfolios([acct(lower), acct(upper)], owner).map((p) => p.pubkey.toBase58());
    expect(listed).toEqual([upper.toBase58(), lower.toBase58()]);
    expect(pickOwnerPortfolio([acct(lower), acct(upper)], owner)?.pubkey.equals(upper)).toBe(true);
    expect(comparePortfolioPubkeys(upper, lower)).toBeLessThan(0);
  });
});

describe("generateIsolatedKeypair: an isolated portfolio never becomes primary", () => {
  it("skips keypairs that sort at or before the primary and returns the first that sorts after", () => {
    const primary = Keypair.generate().publicKey;
    const lows: Keypair[] = [];
    const highs: Keypair[] = [];
    while (lows.length < 3 || highs.length < 1) {
      const kp = Keypair.generate();
      (comparePortfolioPubkeys(kp.publicKey, primary) < 0 ? lows : highs).push(kp);
    }
    const queue = [...lows.slice(0, 3), highs[0]];
    const generate = vi.fn(() => queue.shift()!);
    const kp = generateIsolatedKeypair(primary, { generate });
    expect(kp).toBe(highs[0]);
    expect(generate).toHaveBeenCalledTimes(4); // 3 lows rejected, the 4th accepted
  });

  it("fails closed (nothing to sign) instead of looping forever", () => {
    // A generator that only ever yields a key BELOW the primary.
    const low = keypairStartingWith((c) => c <= "5");
    const primary = keypairStartingWith((c) => c >= "A").publicKey;
    const generate = vi.fn(() => low);
    expect(() => generateIsolatedKeypair(primary, { generate, maxAttempts: 25 })).toThrow(IsolatedKeypairError);
    expect(generate).toHaveBeenCalledTimes(25);
  });

  it("property: over many wallets the grounded isolated key always sorts after the cross key, so the cross account stays primary", () => {
    for (let i = 0; i < 60; i++) {
      // Crosses in the lower ~75% of the alphabet keep the grind short and the test deterministic
      // in duration (a cross near the very top is the documented fail-closed tail, tested above).
      const cross = keypairStartingWith((c) => c <= "k").publicKey;
      const iso = generateIsolatedKeypair(cross).publicKey;
      expect(comparePortfolioPubkeys(iso, cross)).toBeGreaterThan(0);
      // RPC order must not matter: either order, the cross account is picked and listed first.
      const a = [acct(cross), acct(iso)];
      const b = [acct(iso), acct(cross)];
      expect(pickOwnerPortfolio(a, owner)?.pubkey.equals(cross)).toBe(true);
      expect(pickOwnerPortfolio(b, owner)?.pubkey.equals(cross)).toBe(true);
      expect(listOwnerPortfolios(b, owner)[0].pubkey.equals(cross)).toBe(true);
    }
  });

  it("CONTROL: a plain random keypair DOES take over as primary about half the time (the bug being fixed)", () => {
    let flips = 0;
    for (let i = 0; i < 200; i++) {
      const cross = Keypair.generate().publicKey;
      const iso = Keypair.generate().publicKey;
      if (pickOwnerPortfolio([acct(cross), acct(iso)], owner)?.pubkey.equals(iso)) flips++;
    }
    expect(flips).toBeGreaterThan(40);
    expect(flips).toBeLessThan(160);
  });
});
