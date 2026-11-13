// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  NO_BALANCE_KNOWN,
  balanceKey,
  resolveTokenBalance,
} from "@/lib/token-balance";

// The Earn panel's "Max: N USDC" hint flickered between the real balance and 0
// on the live playground. `useInsuranceLP.refreshState` re-reads the user's
// collateral ATA every ~10s and swallowed every failure as zero:
//
//   let userCollateralBalance = 0n;
//   try   { ... getAccountInfo(collateralAta) ... }
//   catch { /* ATA doesn't exist yet - user has 0 collateral available */ }
//
// That comment names one cause for a catch with at least two. On a
// rate-limited endpoint the read throws every few polls, so the panel asserted
// "you hold 0" on no evidence, then corrected itself on the next good poll.
//
// The distinction that matters: an ABSENT account is evidence of zero; a
// FAILED READ is evidence of nothing.

const ALICE = "A1iceWa11etPubkey11111111111111111111111111";
const BOB = "B0bWa11etPubkey2222222222222222222222222222";
const USDC = "UsdcMint1111111111111111111111111111111111";
const WBTC = "WbtcMint2222222222222222222222222222222222";
const ONE_K = 1_000_000_000n; // 1000 USDC at 6 decimals

const ALICE_USDC = balanceKey(ALICE, USDC);
const held = (amount: bigint) => ({ key: ALICE_USDC, amount });

describe("resolveTokenBalance", () => {
  it("keeps the last known balance when the read fails", () => {
    // the flicker itself: 1000 USDC on screen, RPC throws, must NOT become 0
    expect(resolveTokenBalance(held(ONE_K), ALICE_USDC, { ok: false })).toEqual(
      held(ONE_K),
    );
  });

  it("reports zero only when the account is confirmed absent", () => {
    expect(
      resolveTokenBalance(held(ONE_K), ALICE_USDC, { ok: true, absent: true }),
    ).toEqual(held(0n));
  });

  it("reports the real amount when the read succeeds", () => {
    expect(
      resolveTokenBalance(NO_BALANCE_KNOWN, ALICE_USDC, {
        ok: true,
        amount: 42n,
      }),
    ).toEqual(held(42n));
  });

  it("a failed read with nothing known reports zero rather than inventing one", () => {
    expect(
      resolveTokenBalance(NO_BALANCE_KNOWN, ALICE_USDC, { ok: false }),
    ).toEqual(held(0n));
  });

  it("a successful read to zero is honoured (a spent balance is not sticky)", () => {
    // CONTROL. Without this, "keep the previous value" could be implemented as
    // "never decrease", which would strand a stale balance after a withdrawal.
    expect(
      resolveTokenBalance(held(ONE_K), ALICE_USDC, { ok: true, amount: 0n }),
    ).toEqual(held(0n));
  });

  it("never carries one wallet's balance over to another", () => {
    // CONTROL on the fix itself. Carrying the previous figure forward must not
    // survive a wallet switch — Bob would be shown Alice's 1000 USDC.
    const bobUsdc = balanceKey(BOB, USDC);
    expect(resolveTokenBalance(held(ONE_K), bobUsdc, { ok: false })).toEqual({
      key: bobUsdc,
      amount: 0n,
    });
  });

  it("never carries a balance over to a different mint", () => {
    // CONTROL. The slab (and so the collateral mint) changes under a mounted
    // hook exactly like the wallet does; 1000 USDC is not 1000 WBTC.
    const aliceWbtc = balanceKey(ALICE, WBTC);
    expect(resolveTokenBalance(held(ONE_K), aliceWbtc, { ok: false })).toEqual({
      key: aliceWbtc,
      amount: 0n,
    });
  });

  it("drops the balance when the wallet disconnects", () => {
    expect(resolveTokenBalance(held(ONE_K), null, { ok: false })).toEqual({
      key: null,
      amount: 0n,
    });
  });
});

describe("balanceKey", () => {
  it("distinguishes wallet and mint", () => {
    expect(balanceKey(ALICE, USDC)).not.toBe(balanceKey(BOB, USDC));
    expect(balanceKey(ALICE, USDC)).not.toBe(balanceKey(ALICE, WBTC));
    expect(balanceKey(ALICE, USDC)).toBe(balanceKey(ALICE, USDC));
  });

  it("is null when either half is unknown, so nothing is carried forward", () => {
    expect(balanceKey(null, USDC)).toBeNull();
    expect(balanceKey(ALICE, null)).toBeNull();
    expect(balanceKey(undefined, undefined)).toBeNull();
  });
});
