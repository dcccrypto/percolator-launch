// @vitest-environment node
/**
 * getLpInventoryState `syncLive` under three conditions: sync live, sync not live, and the
 * sync-state read failing. Records what a caller (lpInventoryRoomQ -> ticket cap / close guard)
 * sees in each case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN, V17_PORTFOLIO_IDENTITY_TRAILER_LEN } from "@percolatorct/sdk";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";

vi.mock("@/lib/market-lp", async () => {
  const sdk = await import("@percolatorct/sdk");
  const { PublicKey: Pk } = await import("@solana/web3.js");
  return {
    resolveMarketLp: async (c: { getProgramAccounts: () => Promise<{ account: { data: Uint8Array } }[]> }) => {
      const rows = await c.getProgramAccounts();
      for (const r of rows) {
        const d = r.account.data;
        const off = d.length - 104 - sdk.V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
        if (off < 0) continue;
        return { matcherCtx: new Pk(d.subarray(off + 32, off + 64)), pubkey: new Pk(new Uint8Array(32).fill(9)) };
      }
      return null;
    },
  };
});

const detect = vi.hoisted(() => ({ mode: "live" as "live" | "notlive" | "throw" }));
vi.mock("@/lib/program-upgrade-detect", async () => {
  const actual = await vi.importActual<typeof import("@/lib/program-upgrade-detect")>("@/lib/program-upgrade-detect");
  return {
    ...actual,
    matcherLpSyncLive: vi.fn(async () => {
      if (detect.mode === "throw") throw new Error("rpc down");
      return detect.mode === "live";
    }),
  };
});

import { getLpInventoryState } from "@/lib/matcherCaps";
import { lpInventoryRoomQ } from "@/lib/limits/lp-inventory-room";
import { matcherLpSyncLive as realish } from "@/lib/program-upgrade-detect";

const PROGRAM = Keypair.generate().publicKey;

function lpPortfolio(ctx: PublicKey): Buffer {
  const buf = Buffer.alloc(V17_PORTFOLIO_ACCOUNT_LEN);
  Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]).copy(buf, 0);
  buf[10] = 2;
  const off = buf.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  ctx.toBuffer().copy(buf, off + 32);
  buf.writeBigUInt64LE(1n, off + 96);
  return buf;
}

function ctxData(maxFill: bigint, maxInv: bigint, inventory: bigint): Buffer {
  const buf = Buffer.alloc(64 + 256);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(64 + 80, maxFill, true);
  dv.setBigUint64(64 + 128, maxInv, true);
  dv.setBigUint64(64 + 96, inventory & 0xffffffffffffffffn, true);
  dv.setBigUint64(64 + 96 + 8, inventory >> 64n, true);
  return buf;
}

function conn(ctxPk: PublicKey) {
  return {
    rpcEndpoint: "https://fake",
    getProgramAccounts: async () => [{ pubkey: Keypair.generate().publicKey, account: { data: lpPortfolio(ctxPk) } }],
    getMultipleAccountsInfo: async () => [
      { data: ctxData(1000n, 4000n, 3000n), owner: new PublicKey(DEVNET_PROGRAM_IDS.matcher) },
      null,
      null,
    ],
  } as unknown as Connection;
}

async function state(mode: "live" | "notlive" | "throw") {
  detect.mode = mode;
  const slab = Keypair.generate().publicKey;
  const ctxPk = Keypair.generate().publicKey;
  return getLpInventoryState(conn(ctxPk), PROGRAM, slab);
}

describe("getLpInventoryState syncLive", () => {
  beforeEach(() => {
    detect.mode = "live";
  });

  it("sync live -> syncLive true", async () => {
    expect((await state("live"))?.syncLive).toBe(true);
  });

  it("sync not live -> syncLive false", async () => {
    expect((await state("notlive"))?.syncLive).toBe(false);
  });

  it("sync-state read throws -> syncLive false (fail-closed), counters still returned", async () => {
    const st = await state("throw");
    expect(st).toEqual((await state("notlive")));
    expect(st?.syncLive).toBe(false);
    expect(st?.counterQ).toBe(3000n);
  });

  it("caller-visible room for the same reads under live / not-live / error", async () => {
    // A real position of 0 (flat) with a stale counter of 3000 of 4000 max inventory.
    const room = async (mode: "live" | "notlive" | "throw") => {
      const st = (await state(mode))!;
      return lpInventoryRoomQ({ counterQ: st.counterQ, realQ: 0n, maxInventoryAbs: 4000n, syncLive: st.syncLive }, "short");
    };
    const live = await room("live");
    const notLive = await room("notlive");
    const err = await room("throw");
    expect(live).toBe(4000n); // real position (flat) -> full room
    expect(notLive).toBe(1000n); // min(counter, real) -> shrunk by the stale counter
    expect(err).toBe(notLive); // error is indistinguishable from "not live"
  });

  it("the real matcherLpSyncLive resolves false (never throws) for a non-canonical LP matcher", async () => {
    // Documents that the .catch in getLpInventoryState guards a path the detector itself never throws on.
    const c = { getAccountInfo: vi.fn(async () => { throw new Error("rpc"); }) } as unknown as Connection;
    const actual = await vi.importActual<typeof import("@/lib/program-upgrade-detect")>("@/lib/program-upgrade-detect");
    expect(await actual.matcherLpSyncLive(c, DEVNET_PROGRAM_IDS.wrapper, DEVNET_PROGRAM_IDS.matcher)).toBe(false);
    expect(realish).toBeDefined();
  });
});
