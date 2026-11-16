import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { triggerHeldNftScan, getHeldNftSnapshot, makeHeldNftScanKey } from "@/lib/userAccountScan";

function conn(impl: (size: number) => Promise<unknown[]>) {
  return {
    getProgramAccounts: vi.fn((_pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) =>
      impl(cfg.filters[0].dataSize as number),
    ),
  } as never;
}

describe("held-NFT scan failure is not reported as 'holds none'", () => {
  it("first scan failing on one layout rejects instead of resolving []", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const pid = Keypair.generate().publicKey;
    const wallet = Keypair.generate().publicKey;
    const c = conn(async (size) => {
      if (size === 199) throw new Error("429");
      return [];
    });
    const raw = new Uint8Array([1]);
    await expect(triggerHeldNftScan({ connection: c, nftProgramId: pid, wallet, raw })).rejects.toThrow();
    expect(getHeldNftSnapshot(makeHeldNftScanKey(pid, wallet))).toBeNull();
  });

  it("failed first scan releases the dedup claim so the same raw retries", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const pid = Keypair.generate().publicKey;
    const wallet = Keypair.generate().publicKey;
    let fail = true;
    const c = conn(async () => {
      if (fail) throw new Error("timeout");
      return [];
    });
    const raw = new Uint8Array([2]);
    await triggerHeldNftScan({ connection: c, nftProgramId: pid, wallet, raw }).catch(() => {});
    fail = false;
    const res = await triggerHeldNftScan({ connection: c, nftProgramId: pid, wallet, raw });
    expect(res).toEqual([]);
    expect(getHeldNftSnapshot(makeHeldNftScanKey(pid, wallet))).toEqual([]);
  });

  it("keeps returning last-good snapshot when a later scan fails", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const pid = Keypair.generate().publicKey;
    const wallet = Keypair.generate().publicKey;
    const acct = { pubkey: Keypair.generate().publicKey, account: { data: Buffer.alloc(239) } };
    let fail = false;
    const c = conn(async (size) => {
      if (fail) throw new Error("429");
      return size === 239 ? [acct] : [];
    });
    const first = await triggerHeldNftScan({ connection: c, nftProgramId: pid, wallet, raw: new Uint8Array([3]) });
    expect(first).toHaveLength(1);
    fail = true;
    const second = await triggerHeldNftScan({ connection: c, nftProgramId: pid, wallet, raw: new Uint8Array([4]) });
    expect(second).toHaveLength(1);
  });
});
