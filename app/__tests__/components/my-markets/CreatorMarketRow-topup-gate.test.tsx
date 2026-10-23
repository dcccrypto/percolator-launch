/**
 * "top up insurance" on a creator's market signs TopUpInsurance, which the program gates on asset
 * 0's insurance_authority. The create flow's BindInsuranceAuthority rebinds that to the stake
 * pool's vault_auth PDA, so on a completed market the creator's top-up is always refused
 * (Unauthorized). The row now reads the authority from the drawer's SlabProvider and disables the
 * action when the connected wallet does not hold it.
 */
import fs from "fs";
import path from "path";
import { render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ profile: null as unknown }));
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: unknown }) => children,
  useSlabState: () => ({ assetProfile: h.profile }),
}));

import { InsuranceAuthorityReader } from "@/components/my-markets/CreatorMarketRow";

const PDA = "Cp9DzN98SBhLzWJ2tYvdpe4DrmXsRMvH2mDTK3VGsB1r";
const SRC = fs.readFileSync(path.resolve(__dirname, "../../../components/my-markets/CreatorMarketRow.tsx"), "utf8");

describe("creator row: top up insurance is gated on insurance_authority", () => {
  it("reports asset 0's insurance_authority, and null when no profile is loaded", () => {
    const onRead = vi.fn();
    h.profile = { insuranceAuthority: new PublicKey(PDA) };
    const { unmount } = render(<InsuranceAuthorityReader onRead={onRead} />);
    expect(onRead).toHaveBeenLastCalledWith(PDA);
    unmount();
    h.profile = null;
    render(<InsuranceAuthorityReader onRead={onRead} />);
    expect(onRead).toHaveBeenLastCalledWith(null);
  });

  it("the reader sits inside the drawer's SlabProvider", () => {
    expect(SRC).toMatch(/<SlabProvider slabAddress=\{slab\}>[\s\S]*<InsuranceAuthorityReader onRead=\{setInsuranceAuthority\} \/>[\s\S]*<\/SlabProvider>/);
  });

  it("disables top up unless the wallet holds the authority, INCLUDING while it is still unread, and says why", () => {
    expect(SRC).toMatch(/const canTopUpInsurance = insuranceAuthorityKnown && insuranceAuthority === \(wallet\.publicKey\?\.toBase58\(\) \?\? ""\);/);
    // negative control: the old rule enabled the button for everyone until the read landed
    expect(SRC).not.toMatch(/insuranceAuthority === null \|\| insuranceAuthority ===/);
    expect(SRC).toMatch(/disabled=\{actions\.loading === "topUpInsurance" \|\| !canTopUpInsurance\}/);
    expect(SRC).toContain("This market's insurance is managed by its stake pool. Add to it from Stake.");
  });
});
