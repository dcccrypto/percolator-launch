/**
 * #3603: cross-device resume (/create?resume=<slab>, #3267) classified every v2.2 launch as "not an initialised
 * market": the card checked the bytes with the installed SDK's isV17Account, which accepts wrapper VERSION 18 only,
 * and a v2.2 market is VERSION 19. The check now goes through lib/v22/layout. Real v2.2 market bytes, nothing mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { classifyResumeSlab } from "@/components/create/ResumeFromChainCard";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { V22_SLAB, v22MarketBytes } from "@/__tests__/helpers/v22-fixtures";
import { V22_COPY } from "@/lib/v22/copy";
import { unsupportedLayoutMessage } from "@/lib/v22/layout";
import { LAYOUT_V22 } from "@/lib/v22/sdk";

// Only for the card render below: the wallet and the one chain read. classifyResumeSlab is pure.
const io = vi.hoisted(() => ({ data: null as Uint8Array | null, wallet: null as unknown, fail: false }));
// Stable objects: the card's read effect depends on the connection's identity.
const ioConn = vi.hoisted(() => ({
  connection: { getAccountInfo: async () => { if (io.fail) throw new Error("rpc down"); return io.data ? { data: Buffer.from(io.data) } : null; } },
}));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: io.wallet }),
  useConnectionCompat: () => ioConn,
}));
import { ResumeFromChainCard } from "@/components/create/ResumeFromChainCard";

afterEach(() => {
  __setDevnetV22ForTest(null);
  io.fail = false;
  io.data = null;
  cleanup();
});
const notFinished = () => false;

describe("#3603: resuming a v2.2 launch from another browser", () => {
  it("a v2.2 market is read as the creator's launch, not 'not an initialised market'", () => {
    __setDevnetV22ForTest(true);
    const bytes = v22MarketBytes();
    const creator = parseWrapperConfigV17(bytes, V17_HEADER_LEN).marketauth;
    const r = classifyResumeSlab(bytes, V22_SLAB, creator, notFinished);
    expect(r.kind).toBe("ready");
    // The insurance balance is read at the v2.2 offset, not v2.1's (the u128 at group + insurance in LAYOUT_V22).
    const at = LAYOUT_V22.marketGroupOff + LAYOUT_V22.group.insurance;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const insurance = dv.getBigUint64(at, true) | (dv.getBigUint64(at + 8, true) << 64n);
    if (r.kind === "ready") expect(r.insuranceAtoms).toBe(insurance);
  });

  const withVersion = (v: number) => {
    const bytes = v22MarketBytes();
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(8, v, true);
    return bytes;
  };

  it("a wrapper VERSION this build can't decode is 'unsupported' (newer), not 'nothing to continue' or 'try again'", () => {
    __setDevnetV22ForTest(true);
    expect(classifyResumeSlab(withVersion(99), V22_SLAB, V22_SLAB, notFinished)).toEqual({ kind: "unsupported", newer: true });
  });

  it("an OLDER wrapper VERSION (17) is 'unsupported' (older): retrying a read can never fix it", () => {
    __setDevnetV22ForTest(true);
    expect(classifyResumeSlab(withVersion(17), V22_SLAB, V22_SLAB, notFinished)).toEqual({ kind: "unsupported", newer: false });
  });

  it("flag off: unchanged (no VERSION table, so never 'unsupported')", () => {
    __setDevnetV22ForTest(false);
    expect(classifyResumeSlab(withVersion(17), V22_SLAB, V22_SLAB, notFinished).kind).not.toBe("unsupported");
    expect(classifyResumeSlab(withVersion(99), V22_SLAB, V22_SLAB, notFinished).kind).not.toBe("unsupported");
  });

  it("the card says an older launch can't be continued here, calmly, with no 'try again'", async () => {
    __setDevnetV22ForTest(true);
    io.wallet = V22_SLAB;
    io.data = withVersion(17);
    render(createElement(ResumeFromChainCard, { slab: V22_SLAB.toBase58(), onVerified: () => {} }));
    const card = await screen.findByText(/older version/);
    expect(card.textContent).toBe(V22_COPY.layout.olderResume);
    expect(screen.getByTestId("resume-chain-card").getAttribute("data-state")).toBe("unsupported");
    expect(screen.getByTestId("resume-chain-card").textContent).not.toMatch(/try again|Couldn't read/i);
  });

  it("the card shows the calm newer-version copy for a newer launch", async () => {
    __setDevnetV22ForTest(true);
    io.wallet = V22_SLAB;
    io.data = withVersion(99);
    render(createElement(ResumeFromChainCard, { slab: V22_SLAB.toBase58(), onVerified: () => {} }));
    const { title, body } = unsupportedLayoutMessage();
    expect((await screen.findByTestId("resume-chain-card")).textContent).toContain(`${title}. ${body}`);
    expect(screen.getByTestId("resume-chain-card").textContent).not.toMatch(/Couldn't read/);
  });

  it("CONTROL: a failed read is still 'Couldn't read… try again'", async () => {
    __setDevnetV22ForTest(true);
    io.wallet = V22_SLAB;
    io.data = null;
    io.fail = true;
    render(createElement(ResumeFromChainCard, { slab: V22_SLAB.toBase58(), onVerified: () => {} }));
    expect((await screen.findByText(/Couldn't read this launch/)).textContent).toMatch(/Try again in a moment/);
    expect(screen.getByTestId("resume-chain-card").getAttribute("data-state")).toBe("unreadable");
  });

  it("CONTROL: bytes that aren't a wrapper market are still 'not-a-market'", () => {
    __setDevnetV22ForTest(true);
    expect(classifyResumeSlab(new Uint8Array(4_000), V22_SLAB, V22_SLAB, notFinished).kind).toBe("not-a-market");
  });
});
