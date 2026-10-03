/**
 * SendPositionNftModal ran its 32-44 length check on the untrimmed input, so a 44-character
 * address pasted with a trailing space or newline was rejected. It now trims first.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SendPositionNftModal } from "@/components/trade/SendPositionNftModal";

// A real 44-character address.
const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function sendTo(input: string) {
  const onConfirm = vi.fn();
  render(
    <SendPositionNftModal positionSummary="SOL long" nftMintShort="Mint…1234" loading={false} error={null}
      onConfirm={onConfirm} onCancel={vi.fn()} />,
  );
  fireEvent.change(screen.getByPlaceholderText("Paste Solana pubkey…"), { target: { value: input } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm & Sign" }));
  return onConfirm;
}

describe("SendPositionNftModal destination", () => {
  it("accepts a 44-character address pasted with surrounding whitespace", () => {
    expect(DEST).toHaveLength(44);
    const onConfirm = sendTo(` ${DEST}\n`);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].toBase58()).toBe(DEST);
  });

  it("rejects an address with a zero-width character inside (trim does not strip it)", () => {
    const onConfirm = sendTo(DEST.slice(0, 20) + "\u200B" + DEST.slice(20));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still rejects a non-address", () => {
    const onConfirm = sendTo("not-a-wallet-address-at-all-xxxxxxxxx");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
