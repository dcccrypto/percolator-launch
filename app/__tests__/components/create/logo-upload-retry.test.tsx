/**
 * LogoUpload never cleared its hidden file input. A browser fires `change` only when the chosen
 * file differs from the input's current one, so after a declined signature (or a failed
 * upload) picking the same image again did nothing. The input is now cleared on every pick.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const signMessage = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: new PublicKey("11111111111111111111111111111111"), signMessage }),
}));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));

import { LogoUpload } from "@/components/create/LogoUpload";

const fileInput = (c: HTMLElement) => c.querySelector('input[type="file"]') as HTMLInputElement;
const pick = async (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
  });
};

describe("LogoUpload retry after a declined signature", () => {
  it("clears the picker, so the same image can be picked again", async () => {
    signMessage.mockRejectedValueOnce(new Error("User rejected the request."));
    const { container } = render(<LogoUpload slabAddress="5iGg1DPyoyWEzFCvbd26CVgPG2X9FgKaJrHaaGUWJyLr" />);
    const input = fileInput(container);
    const logo = new File(["png"], "logo.png", { type: "image/png" });
    // jsdom can't hold a picked file in a file input's value; stand in for one.
    Object.defineProperty(input, "value", { value: "C:\\fakepath\\logo.png", writable: true, configurable: true });

    await pick(input, logo);
    expect(screen.getByText("User rejected the request.")).toBeInTheDocument();
    // Cleared: a browser will fire `change` again for the same file.
    expect(input.value).toBe("");
  });

  it("also clears it on a rejected file type", async () => {
    const { container } = render(<LogoUpload slabAddress="5iGg1DPyoyWEzFCvbd26CVgPG2X9FgKaJrHaaGUWJyLr" />);
    const input = fileInput(container);
    Object.defineProperty(input, "value", { value: "C:\\fakepath\\notes.txt", writable: true, configurable: true });
    await pick(input, new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(screen.getByText("Only PNG, JPEG, WebP, or GIF allowed.")).toBeInTheDocument();
    expect(input.value).toBe("");
  });
});
