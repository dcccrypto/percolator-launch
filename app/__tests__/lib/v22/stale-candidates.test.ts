// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { staleCandidatesFromAccounts } from "@/lib/v22/earn-exit";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

const L = LAYOUT_V22;
function portfolio(market: PublicKey, legs: { stale: boolean; liq?: boolean }[]): Uint8Array {
  const d = new Uint8Array(L.portfolio.accountLen);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Portfolio;
  d.set(market.toBytes(), 16);
  v.setUint16(L.portfolio.provenanceVersionOff, 1, true);
  v.setUint16(L.portfolio.provenanceDiscriminatorOff, L.engineDiscriminator, true);
  legs.forEach((l, i) => {
    const b = L.portfolio.legsOff + i * L.portfolio.legStride;
    d[b + L.portfolio.leg.active] = 1;
    d[b + L.portfolio.leg.stale] = l.stale ? 1 : 0;
    d[b + L.portfolio.leg.bandLiqPending!] = l.liq ? 1 : 0;
  });
  return d;
}

afterEach(() => __setDevnetV22ForTest(null));

describe("stale candidates (v22 layout, 217 B legs)", () => {
  it("keeps only stale, positioned portfolios of THIS market; liquidating first, then more legs", () => {
    __setDevnetV22ForTest(true);
    const m = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey, c = Keypair.generate().publicKey, e = Keypair.generate().publicKey, f = Keypair.generate().publicKey;
    const out = staleCandidatesFromAccounts(
      [
        { pubkey: a, data: portfolio(m, [{ stale: true }]) },
        { pubkey: b, data: portfolio(m, [{ stale: true }, { stale: false }, { stale: true }]) },
        { pubkey: c, data: portfolio(m, [{ stale: true, liq: true }]) },
        { pubkey: e, data: portfolio(m, [{ stale: false }]) }, // current: skipped
        { pubkey: f, data: portfolio(other, [{ stale: true }]) }, // other market: skipped
        { pubkey: Keypair.generate().publicKey, data: new Uint8Array(100) }, // garbage: skipped, never guessed
      ],
      m,
    );
    expect(out.map((x) => x.key.toBase58())).toEqual([c, b, a].map((x) => x.toBase58()));
    expect(out.map((x) => x.legs)).toEqual([1, 3, 1]);
  });

  it("a v2.1-length portfolio is refused (not read with v2.2 offsets) when the flag is on", () => {
    __setDevnetV22ForTest(true);
    const m = Keypair.generate().publicKey;
    const d = new Uint8Array(9563);
    new DataView(d.buffer).setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
    new DataView(d.buffer).setUint16(8, 18, true);
    d[10] = 2;
    d.set(m.toBytes(), 16);
    // VERSION 18 decodes under v2.1 geometry (both are known), but its discriminator is 0 here -> typed refusal -> skipped.
    expect(staleCandidatesFromAccounts([{ pubkey: Keypair.generate().publicKey, data: d }], m)).toEqual([]);
  });
});
