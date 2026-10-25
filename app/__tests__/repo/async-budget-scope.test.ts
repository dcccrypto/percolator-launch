import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "@testing-library/react";
import { useAsyncUtilTimeout } from "../helpers/async-budget";

const root = join(__dirname, "..");
const PRIVY_SUITES = [
  "PrivyProviderClient.legacy-purge",
  "PrivyBridgeHost.ssr-hydration",
  "PrivyLoginBridge.stale-session.regression",
  "PrivyBridgeHost",
  "PrivyProviderClient.session-headers",
  "PrivyProviderClient",
];

describe("waitFor budget is scoped to the Privy suites, never global", () => {
  it("the shared setup file does not raise the Testing Library budget", () => {
    expect(readFileSync(join(root, "setup.ts"), "utf8")).not.toContain("asyncUtilTimeout");
  });

  it("a suite that does not opt in keeps the 1000 ms default", () => {
    expect(getConfig().asyncUtilTimeout).toBe(1000);
  });

  it("every Privy bridge suite opts in", () => {
    for (const name of PRIVY_SUITES) {
      const src = readFileSync(join(root, "components", `${name}.test.tsx`), "utf8");
      expect(src, name).toContain("useAsyncUtilTimeout();");
    }
  });
});

describe("useAsyncUtilTimeout", () => {
  describe("while a suite has opted in", () => {
    useAsyncUtilTimeout(4321);
    it("raises the budget", () => {
      expect(getConfig().asyncUtilTimeout).toBe(4321);
    });
  });
});
