/**
 * Position NFT layout v3 (S1-2 incarnation binding, percolator-nft 95dcece): the app's parser port, the incarnation
 * classification, both-layout held-NFT scan, error 28 routing and the stale-NFT UX. Not part of the v2.1 quarantine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  staleNftKind,
  POSITION_NFT_LEGACY_V2_LEN,
  POSITION_NFT_STATE_LEN_V3,
  isNftCurrentForPortfolio,
  isNftStale,
  nftIncarnationStatus,
  parsePositionNftAccountV3,
} from "@/lib/v22/sdk/nft-v3";
import { getHeldNftProgramAccounts } from "@/lib/userAccountScan";
import { humanizeError } from "@/lib/errorMessages";
import { isStaleIncarnationSim } from "@/hooks/useBurnPositionNft";
import { PositionNftMenuView, NFT_MENU_COPY } from "@/components/trade/PositionNftMenu";
import { SendPositionNftModal, NFT_STALE_SEND_REFUSED } from "@/components/trade/SendPositionNftModal";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { resetNftIncarnationCache, resolveNftLegacyIsStale } from "@/lib/nft-incarnation";

const cfg = vi.hoisted(() => ({ deployed: false, minDeploySlot: null as number | null }));
// Per-cluster S1-2 deploy config (lib/program-ids.ts); toggled per test.
vi.mock("@/lib/program-ids", async () => {
  const actual = await vi.importActual<typeof import("@/lib/program-ids")>("@/lib/program-ids");
  return { ...actual, nftS12Deploy: () => ({ deployed: cfg.deployed, minDeploySlot: cfg.minDeploySlot }) };
});

const MAGIC = 0x5045_5243_4e46_5400n;

function nftBytes(version: 2 | 3, opts: { group?: PublicKey; id?: bigint; holder?: PublicKey } = {}): Uint8Array {
  const buf = new Uint8Array(version === 3 ? 239 : 199);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, MAGIC, true);
  buf[8] = version;
  if (opts.holder) buf.set(opts.holder.toBytes(), 167);
  if (version === 3) {
    buf.set((opts.group ?? PublicKey.default).toBytes(), 199);
    view.setBigUint64(231, opts.id ?? 0n, true);
  }
  return buf;
}

describe("parsePositionNftAccountV3", () => {
  it("v3: 239 B, incarnation at 199..231 / 231..239, last_holder stays at 167", () => {
    expect(POSITION_NFT_STATE_LEN_V3).toBe(239);
    const group = PublicKey.unique();
    const holder = PublicKey.unique();
    const p = parsePositionNftAccountV3(nftBytes(3, { group, id: 42n, holder }));
    expect(p.isLegacyV2).toBe(false);
    expect(p.version).toBe(3);
    expect(p.portfolioMarketGroup?.equals(group)).toBe(true);
    expect(p.portfolioIdAtMint).toBe(42n);
    expect(p.lastHolder.equals(holder)).toBe(true);
  });
  it("legacy v2 (199 B) parses with the incarnation absent; a truncated v3 and an unknown version throw", () => {
    const p = parsePositionNftAccountV3(nftBytes(2));
    expect(p.isLegacyV2).toBe(true);
    expect(p.portfolioMarketGroup).toBeNull();
    expect(p.portfolioIdAtMint).toBeNull();
    const short = nftBytes(3).subarray(0, 238);
    expect(() => parsePositionNftAccountV3(short)).toThrow(/too small/);
    const bad = nftBytes(2);
    bad[8] = 9;
    expect(() => parsePositionNftAccountV3(bad)).toThrow(/invalid version/);
    expect(POSITION_NFT_LEGACY_V2_LEN).toBe(199);
  });
});

describe("incarnation classification", () => {
  const group = PublicKey.unique();
  const live = { marketGroupId: group, portfolioId: 7n };
  it("same (group, id) is current; a re-created portfolio (new id) or another group is stale", () => {
    const cur = parsePositionNftAccountV3(nftBytes(3, { group, id: 7n }));
    expect(isNftCurrentForPortfolio(cur, live)).toBe(true);
    expect(nftIncarnationStatus(cur, live)).toBe("current");
    const recreated = parsePositionNftAccountV3(nftBytes(3, { group, id: 6n }));
    expect(nftIncarnationStatus(recreated, live)).toBe("stale");
    expect(isNftStale(nftIncarnationStatus(recreated, live), false)).toBe(true);
    const otherGroup = parsePositionNftAccountV3(nftBytes(3, { group: PublicKey.unique(), id: 7n }));
    expect(nftIncarnationStatus(otherGroup, live)).toBe("stale");
    expect(nftIncarnationStatus(cur, { marketGroupId: undefined, portfolioId: 7n })).toBe("stale");
  });
  it("id 0 never matches (0 == 0 does not bind)", () => {
    const zero = parsePositionNftAccountV3(nftBytes(3, { group, id: 0n }));
    expect(nftIncarnationStatus(zero, { marketGroupId: group, portfolioId: 0n })).toBe("stale");
  });
  it("legacy v2 is classified legacy and, while the S1-2 program is not the one in use, is NOT hidden", () => {
    const legacy = parsePositionNftAccountV3(nftBytes(2));
    expect(nftIncarnationStatus(legacy, live)).toBe("legacy");
    expect(isNftStale("legacy", false)).toBe(false);
    expect(isNftStale("legacy", true)).toBe(true); // under the S1-2 program a legacy NFT is dead
    expect(staleNftKind(legacy)).toBe("unrecoverable");
    expect(staleNftKind(parsePositionNftAccountV3(nftBytes(3, { group, id: 1n })))).toBe("burnable");
  });
});

describe("getHeldNftProgramAccounts: both layouts", () => {
  const wallet = PublicKey.unique();
  const mk = (len: number) => ({ pubkey: PublicKey.unique(), account: { data: Buffer.alloc(len), executable: false, lamports: 1, owner: PERCOLATOR_NFT_PROGRAM_ID } });
  it("queries dataSize 239 AND 199 with last_holder @167 and returns both sets", async () => {
    const calls: Array<{ filters: unknown[] }> = [];
    const connection = {
      getProgramAccounts: vi.fn(async (_pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) => {
        calls.push(cfg);
        const size = cfg.filters[0].dataSize;
        return size === 239 ? [mk(239)] : size === 199 ? [mk(199), mk(199)] : [];
      }),
    } as unknown as Connection;
    const out = await getHeldNftProgramAccounts(connection, PERCOLATOR_NFT_PROGRAM_ID, wallet.toBase58());
    expect(out.map((r) => r.account.data.length).sort()).toEqual([199, 199, 239]);
    expect(calls.map((c) => (c.filters[0] as { dataSize: number }).dataSize).sort()).toEqual([199, 239]);
    for (const c of calls) expect(c.filters[1]).toEqual({ memcmp: { offset: 167, bytes: wallet.toBase58() } });
  });
  it("fails closed when either query fails (no half-empty list)", async () => {
    const connection = {
      getProgramAccounts: vi.fn(async (_pid: PublicKey, cfg: { filters: Array<{ dataSize?: number }> }) => {
        if (cfg.filters[0].dataSize === 199) throw new Error("429");
        return [mk(239)];
      }),
    } as unknown as Connection;
    await expect(getHeldNftProgramAccounts(connection, PERCOLATOR_NFT_PROGRAM_ID, wallet.toBase58())).rejects.toThrow("429");
  });
});

describe("error 28 StalePortfolioIncarnation", () => {
  const nftId = PERCOLATOR_NFT_PROGRAM_ID.toBase58();
  it("humanizeError maps NFT Custom(28) to a calm line (and only for the NFT program)", () => {
    const msg = humanizeError(`Program ${nftId} failed: custom program error: 0x1c`);
    expect(msg).toMatch(/earlier version of the account/);
    expect(msg).toMatch(/Burn it to reclaim its rent/);
  });
  it("a simulated Burn failing with the NFT program's 28 routes to EmergencyBurn; the wrapper's 28 does not", () => {
    const err = { InstructionError: [0, { Custom: 28 }] };
    expect(isStaleIncarnationSim(err, [`Program ${nftId} failed: custom program error: 0x1c`], "WrapperProg1111")).toBe(true);
    expect(isStaleIncarnationSim(err, [`Program WrapperProg1111 failed: custom program error: 0x1c`], "WrapperProg1111")).toBe(false);
    expect(isStaleIncarnationSim({ InstructionError: [0, { Custom: 22 }] }, [`Program ${nftId} failed`], "WrapperProg1111")).toBe(false);
  });
});

describe("stale NFT UX", () => {
  const base = { canWrap: false, isWrapped: false, collateralLabel: "1 USDC", busy: null, error: null, onWrap: () => undefined, onSend: () => undefined, onUnwrap: () => undefined };
  it("menu: a stale NFT offers Burn and one refusal line, never Send or Unwrap", () => {
    const onUnwrap = vi.fn();
    const onSend = vi.fn();
    const { getByTestId, queryByTestId } = render(<PositionNftMenuView {...base} staleNft onUnwrap={onUnwrap} onSend={onSend} />);
    fireEvent.click(getByTestId("position-nft-menu-button"));
    expect(queryByTestId("position-nft-send")).toBeNull();
    expect(queryByTestId("position-nft-unwrap")).toBeNull();
    expect(getByTestId("position-nft-stale-line").textContent).toBe(NFT_MENU_COPY.staleSendRefused);
    fireEvent.click(getByTestId("position-nft-stale-burn"));
    expect(onUnwrap).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
  it("send modal: stale refuses with the one line and keeps Confirm disabled even with a valid destination", () => {
    const onConfirm = vi.fn();
    const { getByTestId, getByPlaceholderText, getByRole } = render(
      <SendPositionNftModal positionSummary="LONG 1 SOL" nftMintShort="abc" loading={false} error={null} stale onConfirm={onConfirm} onCancel={() => undefined} />,
    );
    expect(getByTestId("send-nft-stale").textContent).toBe(NFT_STALE_SEND_REFUSED);
    fireEvent.change(getByPlaceholderText(/Paste Solana pubkey/), { target: { value: PublicKey.unique().toBase58() } });
    fireEvent.click(getByRole("checkbox"));
    const confirm = Array.from(document.querySelectorAll("button")).find((b) => /send/i.test(b.textContent ?? "") && b.textContent !== "Cancel");
    if (confirm) fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("resolveNftLegacyIsStale: keyed off deployed state, not a code constant", () => {
  const pd = (slot: bigint) => {
    const b = new Uint8Array(12);
    const v = new DataView(b.buffer);
    v.setUint32(0, 3, true);
    v.setBigUint64(4, slot, true);
    return { data: Buffer.from(b) };
  };
  const connWithSlot = (slot: bigint | "throw") => ({
    getAccountInfo: vi.fn(async () => {
      if (slot === "throw") throw new Error("429");
      return pd(slot);
    }),
  });
  beforeEach(() => {
    resetNftIncarnationCache();
    cfg.deployed = false;
    cfg.minDeploySlot = null;
  });
  it("pre-S1-2 (config false, no probe slot, no v3 seen): legacy stays valid, and no RPC is made", async () => {
    const c = connWithSlot(1n);
    expect(await resolveNftLegacyIsStale(c, PERCOLATOR_NFT_PROGRAM_ID, false)).toBe(false);
    expect(c.getAccountInfo).not.toHaveBeenCalled();
  });
  it("config flipped in the runbook step -> legacy is stale", async () => {
    cfg.deployed = true;
    expect(await resolveNftLegacyIsStale(connWithSlot(1n), PERCOLATOR_NFT_PROGRAM_ID)).toBe(true);
  });
  it("a 239 B record seen proves the S1-2 build; the answer is then sticky", async () => {
    expect(await resolveNftLegacyIsStale(connWithSlot(1n), PERCOLATOR_NFT_PROGRAM_ID, true)).toBe(true);
    expect(await resolveNftLegacyIsStale(connWithSlot(1n), PERCOLATOR_NFT_PROGRAM_ID, false)).toBe(true);
  });
  it("ProgramData slot probe: >= minDeploySlot -> stale; below -> not; a probe error never flips to stale or back", async () => {
    cfg.minDeploySlot = 1000;
    // PDA derivation is unreliable under this jsdom/pure-JS-bigint environment (see usePositionNft.sharedScan.test.ts); the address is not under test.
    vi.spyOn(PublicKey, "findProgramAddressSync").mockReturnValue([PublicKey.default, 255]);
    expect(await resolveNftLegacyIsStale(connWithSlot(999n), PERCOLATOR_NFT_PROGRAM_ID)).toBe(false);
    resetNftIncarnationCache();
    expect(await resolveNftLegacyIsStale(connWithSlot("throw"), PERCOLATOR_NFT_PROGRAM_ID)).toBe(false);
    resetNftIncarnationCache();
    expect(await resolveNftLegacyIsStale(connWithSlot(1000n), PERCOLATOR_NFT_PROGRAM_ID)).toBe(true);
    // sticky even if a later probe reads an older slot
    expect(await resolveNftLegacyIsStale(connWithSlot(5n), PERCOLATOR_NFT_PROGRAM_ID)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("unrecoverable legacy NFT (A-2): no burn button", () => {
  const base = { canWrap: false, isWrapped: false, collateralLabel: "1 USDC", busy: null, error: null, onWrap: () => undefined, onSend: () => undefined, onUnwrap: () => undefined };
  it("menu: unrecoverable shows the support line and NO Burn item", () => {
    const { getByTestId, queryByTestId } = render(<PositionNftMenuView {...base} staleNft staleUnrecoverable />);
    fireEvent.click(getByTestId("position-nft-menu-button"));
    expect(getByTestId("position-nft-stale-line").textContent).toBe(NFT_MENU_COPY.unrecoverableBody);
    expect(queryByTestId("position-nft-stale-burn")).toBeNull();
  });
});
