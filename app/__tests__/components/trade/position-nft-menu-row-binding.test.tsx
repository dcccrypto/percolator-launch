/**
* Audit #40 (menu half): with BOTH positions on one market, the row's
 * ⋯ menu must act only on the row it sits on. Against the CURRENT
 * PositionNftMenu (no row binding) the own-row test fails.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MINT_OWN = new PublicKey("11111111111111111111111111111111");
const MINT_WRAPPED = new PublicKey("So11111111111111111111111111111111111111112");
const PDA_WRAPPED = new PublicKey("SysvarRent111111111111111111111111111111111");

const h = vi.hoisted(() => ({ burnArgs: [] as unknown[], transferArgs: [] as unknown[], hasMinted: true, wrapped: true }));

vi.mock("@/hooks/usePositionNft", () => ({
  usePositionNft: () => ({ hasMintedNft: h.hasMinted, nftMint: null, nftPdaAddress: null, pendingSettlement: false }),
}));
vi.mock("@/hooks/useMintPositionNft", () => ({ useMintPositionNft: () => ({ mint: vi.fn(async () => "sig"), loading: false, error: null }) }));
vi.mock("@/hooks/useBurnPositionNft", () => ({
  useBurnPositionNft: (...args: unknown[]) => {
    h.burnArgs = args;
    return { burn: vi.fn(), loading: false, error: null };
  },
}));
vi.mock("@/hooks/useTransferPositionNft", () => ({
  useTransferPositionNft: (...args: unknown[]) => {
    h.transferArgs = args;
    return { transfer: vi.fn(), loading: false, error: null };
  },
}));
vi.mock("@/hooks/useUserAccount", () => ({
  // The wallet's OWN (unwrapped) open position.
  useUserAccount: () => ({ idx: 0, account: { positionSize: 40_000_000n, capital: 1_000_000_000n } }),
}));
vi.mock("@/hooks/useNftWrappedPosition", () => ({
  // AND a wrapped one on the same market (always-on scan in the container).
  useNftWrappedPosition: () => (h.wrapped ? {
    idx: 0,
    account: { positionSize: -20_000_000n, capital: 500_000_000n },
    nftMint: MINT_WRAPPED,
    nftPda: PDA_WRAPPED,
  } : null),
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ config: { collateralMint: MINT_OWN } }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL" } }) }));
vi.mock("@/components/trade/SendPositionNftModal", () => ({ SendPositionNftModal: () => null, sendNftCopy: () => "" }));

import { PositionNftMenu } from "@/components/trade/PositionNftMenu";

beforeEach(() => {
  h.burnArgs = [];
  h.transferArgs = [];
  h.hasMinted = true;
  h.wrapped = true;
});

describe("PositionNftMenu bound to its row (finding #40)", () => {
  it("own row: offers Wrap only — no Send/Unwrap aimed at the hidden wrapped position", () => {
    render(<PositionNftMenu slabAddress="s" row="own" />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    expect(screen.getByTestId("position-nft-wrap")).toBeInTheDocument();
    expect(screen.queryByTestId("position-nft-send")).toBeNull();
    expect(screen.queryByTestId("position-nft-unwrap")).toBeNull();
  });
  it("wrapped row: offers Send/Unwrap for the wrapped NFT, no Wrap", () => {
    render(<PositionNftMenu slabAddress="s" row="wrapped" />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    expect(screen.getByTestId("position-nft-send")).toBeInTheDocument();
    expect(screen.getByTestId("position-nft-unwrap")).toBeInTheDocument();
    expect(screen.queryByTestId("position-nft-wrap")).toBeNull();
    // Unwrap is aimed at the WRAPPED NFT's mint/pda (the override handed to useBurnPositionNft).
    const override = h.burnArgs[1] as { nftMint: PublicKey; nftPdaAddress: string };
    expect(override.nftMint.equals(MINT_WRAPPED)).toBe(true);
    expect(override.nftPdaAddress).toBe(PDA_WRAPPED.toBase58());
  });
});

describe("the pendingMint trap (#40 consensus: isNftPresent stays unscoped)", () => {
  it("a wrap that first surfaces via the scan still clears the pending state on the own row", async () => {
    h.hasMinted = false;
    h.wrapped = false;
    const view = render(<PositionNftMenu slabAddress="s" row="own" />);
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    fireEvent.click(screen.getByTestId("position-nft-wrap"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("position-nft-wrap-confirm")); // the sheet confirms the mint
    });
    // pendingMint holds: the whole menu unrenders until the NFT is seen on-chain.
    expect(screen.queryByTestId("position-nft-menu-button")).toBeNull();
    h.wrapped = true; // the minted NFT surfaces via the shared scan first, not usePositionNft
    view.rerender(<PositionNftMenu slabAddress="s" row="own" />);
    // The unscoped isNftPresent cleared pendingMint, so the menu is back; a
    // scoped variant would wedge it hidden forever (the #2845 lesson).
    fireEvent.click(screen.getByTestId("position-nft-menu-button"));
    expect(screen.getByTestId("position-nft-wrap")).toBeInTheDocument();
    expect(screen.queryByTestId("position-nft-send")).toBeNull(); // still scoped to the own row
  });
});

describe("the Send override targets the wrapped NFT (audit #40, the headline harm)", () => {
  it("arms the transfer hook with the wrapped NFT's mint on the wrapped row", () => {
    render(<PositionNftMenu slabAddress="s" row="wrapped" />);
    const override = h.transferArgs[1] as { nftMint: { equals(o: unknown): boolean } };
    expect(override.nftMint.equals(MINT_WRAPPED)).toBe(true);
  });
});
