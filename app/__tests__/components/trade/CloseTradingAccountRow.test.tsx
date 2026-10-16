/**
 * #3426: the "Close account" action appears only for the connected wallet's own EMPTY, non-LP, non-wrapped
 * trading account, shows the account's own lamports, and asks before sending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair, PublicKey } from "@solana/web3.js";

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
const closeAccount = vi.fn();
vi.mock("@/hooks/useCloseTradingAccount", () => ({ useCloseTradingAccount: () => ({ closeAccount, loading: false, error: null }) }));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { CloseTradingAccountRow } from "@/components/trade/CloseTradingAccountRow";
import { CLOSE_ACCOUNT_COPY } from "@/lib/close-trading-account";
import { parsePortfolio } from "@/lib/v22/layout";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { OFF, emptied, layoutFor, setU128, walletOf, type Fx } from "../../helpers/close-account-fixtures";

const PK = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");

describe.each<{ fx: Fx; flag: boolean }>([{ fx: "v21", flag: false }, { fx: "v22", flag: true }])("CloseTradingAccountRow ($fx, flag $flag)", ({ fx, flag }) => {
  let getAccountInfo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    __setDevnetV22ForTest(flag);
    getAccountInfo = vi.fn().mockResolvedValue({ lamports: 49_230_280 });
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: { getAccountInfo } } as never);
  });
  afterEach(() => {
    cleanup();
    __setDevnetV22ForTest(null);
  });

  const mount = (data: Buffer, wallet: PublicKey = walletOf(data), onClosed?: (l: number) => void) => {
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet } as never);
    return render(<CloseTradingAccountRow slabAddress="Slab" portfolioPk={PK} portfolio={parsePortfolio(data)} onClosed={onClosed} />);
  };

  it("shows the line with the account's own SOL and a Close account button for an empty own account", async () => {
    mount(emptied(fx));
    expect((await screen.findByTestId("close-account-line")).textContent).toBe(CLOSE_ACCOUNT_COPY.line("0.049"));
    expect(screen.getByTestId("close-account-open").textContent).toBe("Close account");
    expect(getAccountInfo).toHaveBeenCalledWith(PK, "confirmed");
  });

  it("the figure follows the lamports read, not a constant", async () => {
    getAccountInfo.mockResolvedValue({ lamports: 55_000_000 });
    mount(emptied(fx));
    expect((await screen.findByTestId("close-account-line")).textContent).toContain("~0.055 SOL");
  });

  it("is absent until the lamports are known", () => {
    getAccountInfo.mockReturnValue(new Promise(() => {}));
    mount(emptied(fx));
    expect(screen.queryByTestId("close-account")).toBeNull();
  });

  it("nothing is sent until the user confirms; the confirm step says what happens", async () => {
    const onClosed = vi.fn();
    closeAccount.mockResolvedValue({ signature: "s", lamports: 49_230_280 });
    mount(emptied(fx), undefined, onClosed);
    fireEvent.click(await screen.findByTestId("close-account-open"));
    expect(closeAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId("close-account-confirm-text").textContent).toMatch(/get the account rent \(~0\.049 SOL\) back\. Trading here again sets up a new account \(~0\.0\d+ SOL\)\./);
    fireEvent.click(screen.getByTestId("close-account-cancel"));
    expect(closeAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("close-account-open"));
    fireEvent.click(screen.getByTestId("close-account-confirm"));
    await waitFor(() => expect(onClosed).toHaveBeenCalledWith(49_230_280));
    expect(closeAccount).toHaveBeenCalledTimes(1);
    expect(closeAccount.mock.calls[0][0].equals(PK)).toBe(true);
  });

  it.each([
    ["capital left", (d: Buffer) => setU128(d, OFF.capital, 1n)],
    ["pnl left", (d: Buffer) => setU128(d, OFF.pnl, 1n)],
    ["an open leg", (d: Buffer) => { d[layoutFor(fx).legsOff + layoutFor(fx).leg.active] = 1; return d; }],
    ["the LP account", (d: Buffer) => { d[layoutFor(fx).matcherConfigOff + 96] |= 1; return d; }],
  ])("is absent for %s", async (_n, edit) => {
    mount(edit(emptied(fx)));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("close-account")).toBeNull();
    expect(getAccountInfo).not.toHaveBeenCalled();
  });

  it("is absent for another wallet's account and for an NFT-wrapped one", async () => {
    mount(emptied(fx), Keypair.generate().publicKey);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("close-account")).toBeNull();
    cleanup();
    const wrapped = emptied(fx);
    const original = new PublicKey(wrapped.subarray(80, 112));
    Keypair.generate().publicKey.toBuffer().copy(wrapped, 116);
    mount(wrapped, original);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("close-account")).toBeNull();
  });
});
