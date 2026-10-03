/**
 * SimUsdcBalance treated every getAccount failure as "no token account" and showed 0.00. A
 * failed read (429, network) now shows "Could not fetch balance"; only a missing account is 0.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ getAccount: vi.fn() }));
vi.mock("@solana/spl-token", async (io) => ({
  ...(await io<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddress: vi.fn(async () => new PublicKey("11111111111111111111111111111111")),
  getAccount: h.getAccount,
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ rpcUrl: "http://localhost:8899" }) }));

import { TokenAccountNotFoundError } from "@solana/spl-token";
import { SimUsdcBalance } from "@/components/playground/SimUsdcBalance";

const pk = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

describe("SimUsdcBalance", () => {
  beforeEach(() => {
    h.getAccount.mockReset();
  });

  it("a failed read shows an error, not 0.00", async () => {
    h.getAccount.mockImplementation(async () => { throw new Error("429 Too Many Requests"); });
    const onBalance = vi.fn();
    render(<SimUsdcBalance publicKey={pk} onBalance={onBalance} />);
    expect(await screen.findByText("Could not fetch balance")).toBeInTheDocument();
    expect(screen.queryByText("0.00")).toBeNull();
    expect(onBalance).not.toHaveBeenCalled();
  });

  it("no token account is a balance of 0", async () => {
    h.getAccount.mockImplementation(async () => { throw new TokenAccountNotFoundError(); });
    render(<SimUsdcBalance publicKey={pk} />);
    expect(await screen.findByText("0.00")).toBeInTheDocument();
  });

  it("shows the balance it read", async () => {
    h.getAccount.mockResolvedValue({ amount: 1_234_560_000n });
    render(<SimUsdcBalance publicKey={pk} />);
    expect(await screen.findByText("1,234.56")).toBeInTheDocument();
  });
});
