import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { ChainResumeNotice } from "@/components/create/ChainResumeNotice";

describe("the chain-resume refusal notice", () => {
  it("shows the reason, and nothing when there is none", () => {
    const { rerender } = render(<ChainResumeNotice message="This resume was verified for a different market or wallet." />);
    expect(screen.getByTestId("chain-resume-error").textContent).toMatch(/different market or wallet/);
    rerender(<ChainResumeNotice message={null} />);
    expect(screen.queryByTestId("chain-resume-error")).toBeNull();
  });
  it("the wizard renders it in the form view AND in the launch-progress view, so a refused Retry is never dead", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"), "utf8");
    expect(src.match(/<ChainResumeNotice message=\{chainResumeError\} \/>/g)?.length).toBe(2);
    const progress = src.slice(src.indexOf("// Launch progress"), src.indexOf("// Demo launch progress"));
    expect(progress).toContain("<ChainResumeNotice message={chainResumeError} />");
    expect(progress.indexOf("<ChainResumeNotice")).toBeLessThan(progress.indexOf("<LaunchProgress"));
  });
});
