/**
 * v2.2 Earn market in My Markets: CloseSlab can never run (Earn dead-share floor, FC-B5), so the row says rent is not reclaimable and
 * offers settle (with an irreversible, last-price warning) instead of a close. Real v2.2 Earn market bytes (CHILLHOUSE-T).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LP_VAULT_BACKING_EXPIRY_SLOT } from "@/lib/v22/resolved-claims";

const chill = (): Uint8Array =>
  new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/v22-growth/chillhouse-t.market.json"), "utf8")) as { data: string }).data, "base64"));
/** Same market with every sentinel stamp replaced: no Earn floor, so CloseSlab is not blocked by it. */
const noFloor = (): Uint8Array => {
  const d = chill();
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0; i + 8 <= d.length; i++) if (v.getBigUint64(i, true) === LP_VAULT_BACKING_EXPIRY_SLOT) v.setBigUint64(i, 123n, true);
  return d;
};

const h = vi.hoisted(() => ({ complete: false, raw: null as Uint8Array | null, settle: vi.fn(), slot: 0n as bigint | null }));
vi.mock("@/lib/market-completeness", () => ({ isMarketauthComplete: () => h.complete }));
vi.mock("@/components/providers/SlabProvider", () => ({ SlabProvider: ({ children }: { children: unknown }) => children, useSlabState: () => ({ assetProfile: null, raw: h.raw }) }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => h.slot }));
vi.mock("@/components/market/CreatorClaimPanel", () => ({ CreatorClaimPanel: () => null }));
vi.mock("@/components/create/LogoUpload", () => ({ LogoUpload: () => null }));
vi.mock("@/components/limits/CreatorLimits", () => ({ CreatorTranchePanel: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/hooks/useAdminActions", () => ({ useAdminActions: () => ({ loading: null }) }));
vi.mock("@/hooks/useCloseMarket", () => ({ useCloseMarket: () => ({ closeSlab: vi.fn(), settleMarket: h.settle, loading: false, error: null }) }));
vi.mock("@/hooks/useClaimCreatorFees", () => ({ useClaimCreatorFees: () => ({ claim: vi.fn(), busy: false, outcomes: [] }) }));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const WALLET = new PublicKey("EXC8LS3YzsbyadhaQPqaeGjb2ttfGgDLno9jeCFWqqyi");
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: WALLET }) }));
vi.mock("@/lib/priceStore/priceStore", () => ({ subscribeSlab: () => () => {}, getSnapshot: () => ({ priceUsd: null }) }));
vi.mock("@/lib/config", async (orig) => ({ ...(await orig<object>()), getConfig: () => ({ network: "devnet", explorerUrl: "https://explorer.solana.com" }) }));

import { CreatorMarketRow } from "@/components/my-markets/CreatorMarketRow";

const SLAB = new PublicKey("GrKZUtyeaqbg1Q1J1kPWznui92sbLpX5F62LrBVGkifL");
const mkt = (marketauth: PublicKey) =>
  ({
    slabAddress: SLAB, programId: PublicKey.default, label: "USDC", config: undefined,
    configV17: { oracleMode: 3, markEwmaE6: 0n, markEwmaLastSlot: 0n, invert: 0, unitScale: 1_000_000, collateralMint: PublicKey.default, marketauth },
    v17Stats: { oi: { insuranceBalance: 0n, totalLongOiQ: 0n, totalShortOiQ: 0n, assets: [] }, assetSlotLast: null, launch: undefined },
  }) as never;
const detail = { slab_address: SLAB.toBase58(), symbol: "CHILL", name: "Chill", creator_fee_authority: WALLET.toBase58(), creator_fee_claimable_atoms: "0" } as never;
const renderRow = (m: never) => render(<CreatorMarketRow market={m} detail={detail} identity={null} chainCurrentSlot={null} expanded onToggleExpand={() => {}} />);

beforeEach(() => {
  __setDevnetV22ForTest(true);
  h.complete = true; // finished market (marketauth check below decides the close gate)
  h.raw = chill();
  h.slot = 600_000_000n;
  h.settle.mockReset();
  h.settle.mockResolvedValue(null);
  window.localStorage.clear();
});
afterAll(() => __setDevnetV22ForTest(null));

describe("CreatorMarketRow on a v2.2 Earn market", () => {
  it("says rent is not reclaimable, hides close, and offers settle to the market admin", () => {
    renderRow(mkt(WALLET));
    expect(screen.getByTestId("earn-floor-line").textContent).toMatch(/^Rent is not reclaimable on v2\.2 Earn markets/);
    expect(screen.queryByTestId("close-market-button")).toBeNull();
    expect(screen.getByTestId("settle-and-withdraw-button").textContent).toBe("Settle and withdraw everything");
  });
  it("a wallet that is not the market admin sees the line but no settle button", () => {
    renderRow(mkt(PublicKey.default));
    expect(screen.getByTestId("earn-floor-line")).toBeTruthy();
    expect(screen.queryByTestId("settle-and-withdraw-button")).toBeNull();
  });
  it("the dialog says irreversible, last price with its age, no notice to others; confirm settles", () => {
    renderRow(mkt(WALLET));
    fireEvent.click(screen.getByTestId("settle-and-withdraw-button"));
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/This cannot be undone/);
    expect(text).toMatch(/settle at the market's last price \(last updated about \d+ minutes? ago\)/);
    expect(text).toMatch(/Other users are not notified/);
    fireEvent.click(screen.getByText("Settle market"));
    expect(h.settle).toHaveBeenCalledWith(SLAB.toBase58());
  });
  it("CONTROL: a market with no Earn floor keeps its close button and shows no floor note", () => {
    h.raw = noFloor();
    renderRow(mkt(WALLET));
    expect(screen.queryByTestId("earn-floor-note")).toBeNull();
    expect(screen.getByTestId("close-market-button")).toBeTruthy();
  });
  it("while the market bytes are unread nothing is claimed (the close button stays)", () => {
    h.raw = null;
    renderRow(mkt(WALLET));
    expect(screen.queryByTestId("earn-floor-note")).toBeNull();
  });
});
