// @vitest-environment node
/**
 * v2.2 QA NB-1: closing a position showed "couldn't match this position to your wallet" on EVERY v2.2 portfolio.
 * verifyPortfolioTarget decoded the account with the installed SDK's v2.1 parser (9,563 B); a v2.2 portfolio is 10,603 B
 * (VERSION 19), so the gate refused the wallet's own account. Real bytes: QA's CHILLHOUSE portfolio 6R9jmBX3… .
 */
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import fixture from "../../fixtures/v22-flat-winner-portfolio-2026-10-11.json";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { PortfolioTargetError, verifyPortfolioTarget } from "@/lib/portfolio-target";
import { liftV22Portfolio } from "../../helpers/portfolio-disc20";

const data = liftV22Portfolio(Uint8Array.from(Buffer.from(fixture.b64, "base64"))); // recorded pre-#299: lifted to disc 20 / 10,607 B
const program = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const market = new PublicKey(fixture.market);
const owner = new PublicKey(fixture.owner);
const info = { owner: program, data };

describe("NB-1: the close / withdraw target gate on a v2.2 portfolio", () => {
  afterEach(() => __setDevnetV22ForTest(null));

  it("accepts the wallet's own v2.2 portfolio (10,607 B since engine #299, VERSION 19), whatever its address", () => {
    __setDevnetV22ForTest(true);
    expect(data.length).toBe(10_607);
    expect(Buffer.from(verifyPortfolioTarget(info, program, market, owner)).equals(Buffer.from(data))).toBe(true);
  });

  it("still refuses another wallet, another market, another program, a missing account", () => {
    __setDevnetV22ForTest(true);
    const other = Keypair.generate().publicKey;
    expect(() => verifyPortfolioTarget(info, program, market, other)).toThrow(PortfolioTargetError);
    expect(() => verifyPortfolioTarget(info, program, other, owner)).toThrow(PortfolioTargetError);
    expect(() => verifyPortfolioTarget({ owner: other, data }, program, market, owner)).toThrow(PortfolioTargetError);
    expect(() => verifyPortfolioTarget(null, program, market, owner)).toThrow(PortfolioTargetError);
    // engine #299: the recorded pre-#299 bytes (disc 19, 10,603 B) are refused, not mis-read
    expect(() => verifyPortfolioTarget({ owner: program, data: Uint8Array.from(Buffer.from(fixture.b64, "base64")) }, program, market, owner)).toThrow(PortfolioTargetError);
    expect(() => verifyPortfolioTarget({ owner: program, data: data.slice(0, 9_563) }, program, market, owner)).toThrow(PortfolioTargetError);
  });
});
