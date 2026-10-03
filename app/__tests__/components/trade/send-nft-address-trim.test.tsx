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

  // The zero-width cases must reach base58 decoding: a 43-character address leaves room for one
  // extra character inside the 32-44 length window, so the length check cannot be what rejects it.
  // (The 44-character DEST above plus U+200B is 45 characters and would be rejected by length alone.)
  const SHORT = "So11111111111111111111111111111111111111112";

  it("accepts the 43-character control address unmodified", () => {
    expect(SHORT).toHaveLength(43);
    const onConfirm = sendTo(SHORT);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].toBase58()).toBe(SHORT);
  });

  it.each([
    ["inside", SHORT.slice(0, 20) + "\u200B" + SHORT.slice(20)],
    ["leading", "\u200B" + SHORT],
    ["trailing", SHORT + "\u200B"],
  ])("rejects a zero-width space %s the address at base58 decoding (trim does not strip it)", (_where, input) => {
    expect(input).toHaveLength(44);
    expect(input.trim()).toHaveLength(44);
    const onConfirm = sendTo(input);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Not a valid Solana pubkey.")).toBeInTheDocument();
  });

  it("still rejects a non-address", () => {
    const onConfirm = sendTo("not-a-wallet-address-at-all-xxxxxxxxx");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
