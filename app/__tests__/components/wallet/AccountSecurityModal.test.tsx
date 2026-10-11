/**
 * Account and Security window (wallet dropdown): signed-in identity, referral code (from
 * /api/playground/me, else a link to the waitlist page), Connect X through Privy, and a
 * confirmed reset of this device's chart settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  user: null as unknown,
  linkTwitter: vi.fn(),
  unlink: vi.fn(),
  linkCallbacks: null as null | { onError?: (code: string) => void },
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ user: h.user }),
  useUnlinkOAuth: () => ({ unlink: h.unlink }),
  useLinkAccount: (cb: { onError?: (code: string) => void }) => {
    h.linkCallbacks = cb;
    return { linkTwitter: h.linkTwitter };
  },
}));

import { AccountSecurityModal, clearChartSettings } from "@/components/wallet/AccountSecurityModal";

const WALLET = "GXjpKbhkJMgJiooFAJAn2LpeByYLD8LsaBJszbqQtxfQ";
const fetchRef = (ref: string | null, ok = true) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ref }), { status: ok ? 200 : 401 })));
const open = () => render(<AccountSecurityModal onClose={() => {}} walletAddress={WALLET} />);

beforeEach(() => {
  h.user = { email: { address: "me@x.io" } };
  h.linkTwitter.mockReset();
  h.unlink.mockReset().mockResolvedValue({});
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("AccountSecurityModal", () => {
  it("shows who is signed in: email, Google and the wallet", async () => {
    h.user = { email: { address: "me@x.io" }, google: { email: "me@gmail.com" } };
    fetchRef(null);
    open();
    const s = within(screen.getByTestId("account-signed-in"));
    expect(s.getByText("me@x.io")).toBeTruthy();
    expect(s.getByText("me@gmail.com")).toBeTruthy();
    expect(s.getByText("GXjp...txfQ")).toBeTruthy();
  });

  it("shows the referral code with copy buttons for the code and the link", async () => {
    fetchRef("PERC7Q");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    open();
    const r = within(screen.getByTestId("account-referral"));
    expect(await r.findByText("PERC7Q")).toBeTruthy();
    fireEvent.click(r.getByText("Copy link"));
    expect(writeText).toHaveBeenCalledWith("https://percolator.trade/r/PERC7Q");
    expect(await r.findByText("Copied")).toBeTruthy();
  });

  it.each([
    ["no code in the session", () => fetchRef(null)],
    ["the request is refused", () => fetchRef(null, false)],
  ])("%s: links to the waitlist page instead", async (_n, setup) => {
    setup();
    open();
    const link = await within(screen.getByTestId("account-referral")).findByRole("link", { name: "waitlist page" });
    expect(link.getAttribute("href")).toBe("https://percolator.trade/waitlist");
  });

  it("Connect X starts Privy's X link flow; a failure before the redirect is shown, a cancel is silent", async () => {
    fetchRef(null);
    open();
    const x = within(screen.getByTestId("account-x"));
    expect(x.getByText("Not connected")).toBeTruthy();
    expect(x.getByRole("img", { name: "X" })).toBeTruthy();
    fireEvent.click(x.getByText("Connect X"));
    expect(h.linkTwitter).toHaveBeenCalledTimes(1);
    act(() => h.linkCallbacks!.onError!("exited_link_flow"));
    expect(x.queryByRole("alert")).toBeNull();
    act(() => h.linkCallbacks!.onError!("failed_to_link_account"));
    expect(x.getByRole("alert").textContent).toBe("Couldn't connect X. Try again later.");
  });

  it("a linked X account shows its handle and disconnects by its subject", async () => {
    h.user = { email: { address: "me@x.io" }, twitter: { subject: "12345", username: "brian", name: null, profilePictureUrl: null } };
    fetchRef(null);
    open();
    const x = within(screen.getByTestId("account-x"));
    expect(x.getByText("@brian")).toBeTruthy();
    expect(x.queryByText("Not connected")).toBeNull();
    fireEvent.click(x.getByText("Disconnect"));
    await waitFor(() => expect(h.unlink).toHaveBeenCalledWith({ provider: "twitter", subject: "12345" }));
  });

  it("Reset chart settings asks first; only the confirm clears and reloads", async () => {
    fetchRef(null);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    localStorage.setItem("perc:chart:style", "candles");
    open();
    const c = within(screen.getByTestId("account-chart-reset"));
    fireEvent.click(c.getByText("Reset"));
    expect(c.getByText(/Delete your chart drawings, indicators and layouts on this device\?/)).toBeTruthy();
    expect(localStorage.getItem("perc:chart:style")).toBe("candles");
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(c.getByText("Cancel"));
    expect(c.queryByText(/Delete your chart drawings, indicators and layouts on this device\?/)).toBeNull();
    fireEvent.click(c.getByText("Reset"));
    fireEvent.click(c.getAllByText("Reset").at(-1)!);
    expect(localStorage.getItem("perc:chart:style")).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("clearChartSettings", () => {
  it("removes only chart and TradingView keys; launch recovery, entry prices and the rest stay", () => {
    const keep = {
      "percolator:in-flight-market:SLAB": "{secret}",
      "perc.keeperProofTx.SLAB": "x",
      "perc:entry:SLAB:0": "1",
      "pco-theme": "dark",
      "perc:watchlist:v1": "[]",
      "privy:token": "t",
    };
    const drop = ["perc:chart:drawings:SLAB", "perc:chart:indicators:SLAB", "perc:chart:style", "perc:tv:charts", "perc:tv:chart:1", "perc:tv:interval"];
    localStorage.clear();
    Object.entries(keep).forEach(([k, v]) => localStorage.setItem(k, v));
    drop.forEach((k) => localStorage.setItem(k, "x"));
    expect(clearChartSettings(localStorage)).toBe(drop.length);
    drop.forEach((k) => expect(localStorage.getItem(k)).toBeNull());
    Object.entries(keep).forEach(([k, v]) => expect(localStorage.getItem(k)).toBe(v));
  });
});
