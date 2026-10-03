/**
 * GH#2804: a deposit whose confirmation timed out may still land. The panel must keep the submit
 * disabled, show the explorer link, watch the signature (checkSignatureLanded), and resolve when it
 * lands or is dropped — never invite a second deposit or promise an update nothing delivers.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

const H = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({ connected: true })),
  useConnectionCompat: () => ({ connection: { tag: "conn" } }),
}));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick, ...rest }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest["data-testid"]}>
      {children}
    </button>
  ),
}));
// Only the network read is stubbed; timedOutSignature and the rest of lib/tx are the real code.
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  checkSignatureLanded: H.check,
}));

import { DepositWithdrawPanel } from "../../../components/earn/DepositWithdrawPanel";

const SIG = bs58.encode(new Uint8Array(64).fill(9));
const timeoutErr = () => new Error(`Confirmation timeout (90s) — tx may still land. Check explorer: ${SIG}`);

function renderPanel(onDeposit: (a: bigint) => Promise<void>, onRefresh = vi.fn()) {
  render(
    <DepositWithdrawPanel
      userBalance={100_000_000n}
      userLpBalance={0n}
      vaultBalance={0n}
      lpSupply={0n}
      vaultAvailable
      decimals={6}
      collateralSymbol="USDC"
      loading={false}
      cooldownElapsed
      onDeposit={onDeposit}
      onWithdraw={vi.fn(async () => undefined)}
      onRefresh={onRefresh}
    />,
  );
  return { onRefresh };
}

const submit = () => screen.getByTestId("earn-deposit-submit") as HTMLButtonElement;

async function depositTen() {
  fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "10" } });
  await act(async () => {
    fireEvent.click(submit());
  });
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("Earn deposit after a confirmation timeout (GH#2804)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    H.check.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps submit disabled and links the explorer while it watches, then resolves when it lands", async () => {
    H.check.mockResolvedValueOnce("unknown").mockResolvedValueOnce("landed");
    const onDeposit = vi.fn(async () => { throw timeoutErr(); });
    const { onRefresh } = renderPanel(onDeposit);

    await depositTen();

    const pending = screen.getByTestId("earn-tx-pending");
    expect(pending.getAttribute("data-state")).toBe("watching");
    expect(screen.getByTestId("earn-tx-explorer").getAttribute("href")).toContain(`/tx/${SIG}`);
    expect(screen.queryByText(/We'll update this when it lands/)).toBeNull();
    expect(screen.queryByTestId("earn-error")).toBeNull();
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe("Confirming…");
    // A second click sends nothing.
    fireEvent.click(submit());
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(H.check).toHaveBeenCalledWith({ tag: "conn" }, SIG);

    await advance(4_000); // second poll -> landed

    expect(screen.queryByTestId("earn-tx-pending")).toBeNull();
    expect(screen.getByText("Deposit successful!")).toBeTruthy();
    expect((screen.getByTestId("earn-deposit-input") as HTMLInputElement).value).toBe("");
    expect(onRefresh).toHaveBeenCalled();
    expect(onDeposit).toHaveBeenCalledTimes(1);
  });

  it("re-enables the form with a plain line once the deposit is dropped", async () => {
    H.check.mockResolvedValue("not-found");
    renderPanel(vi.fn(async () => { throw timeoutErr(); }));

    await depositTen();
    expect(submit().disabled).toBe(true);

    await advance(20_000);
    expect(submit().disabled).toBe(true); // a short not-found run is not a drop

    await advance(12_000);
    expect(screen.queryByTestId("earn-tx-pending")).toBeNull();
    expect(screen.getByTestId("earn-error").textContent).toContain("This deposit didn't go through. Nothing was sent.");
    expect(submit().disabled).toBe(false);
    expect((screen.getByTestId("earn-deposit-input") as HTMLInputElement).value).toBe("10");
  });

  it("after the watch window without a verdict: usable again, explorer link kept, no outcome claimed", async () => {
    H.check.mockResolvedValue("unknown");
    renderPanel(vi.fn(async () => { throw timeoutErr(); }));

    await depositTen();
    await advance(124_000);

    const pending = screen.getByTestId("earn-tx-pending");
    expect(pending.getAttribute("data-state")).toBe("undetermined");
    expect(pending.textContent).toContain("Check the explorer before trying again");
    expect(screen.getByTestId("earn-tx-explorer").getAttribute("href")).toContain(SIG);
    expect(submit().disabled).toBe(false);
  });

  it("CONTROL: any other failure keeps today's behaviour (error line, no watch)", async () => {
    renderPanel(vi.fn(async () => { throw new Error("User rejected the request"); }));

    await depositTen();

    expect(screen.queryByTestId("earn-tx-pending")).toBeNull();
    expect(H.check).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false);
  });

  it("stops watching when the panel unmounts", async () => {
    H.check.mockResolvedValue("unknown");
    renderPanel(vi.fn(async () => { throw timeoutErr(); }));

    await depositTen();
    const calls = H.check.mock.calls.length;
    cleanup();
    await advance(20_000);
    expect(H.check.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});
