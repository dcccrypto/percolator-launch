/**
 * The app renders OUTSIDE PrivyProvider (PrivyBridgeHost.tsx, #3530), so only the provider-side files
 * may import runtime values from the Privy SDK; everything else reads Privy through the bridge
 * (usePrivyBridge). A direct SDK hook elsewhere crashes at render (the Account and Security window did).
 * `import type` is fine: it is erased at build.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const INSIDE_PROVIDER = new Set([
  "components/providers/PrivyProviderClient.tsx",
  "components/providers/PrivyBridgeState.tsx",
  "components/providers/SentryUserContext.tsx",
]);
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

// Any quoted reference to the SDK left after removing type-only statements: static and dynamic
// imports, re-exports, side-effect imports and require all count. Comments name it in backticks.
const usesSdkAtRuntime = (src: string): boolean =>
  /["']@privy-io\/react-auth(\/[^"']*)?["']/.test(src.replace(/^\s*(import|export)\s+type\b[^;]*;/gm, ""));

it("no Privy SDK runtime import outside the provider files", () => {
  const offenders = ["app", "components", "hooks", "lib"]
    .flatMap((d) => walk(join(ROOT, d)))
    .map((p) => relative(ROOT, p).replace(/\\/g, "/"))
    .filter((rel) => !INSIDE_PROVIDER.has(rel))
    .filter((rel) => usesSdkAtRuntime(readFileSync(join(ROOT, rel), "utf8")));
  expect(offenders).toEqual([]);
});

it("CONTROL: runtime forms are caught, type-only imports are not", () => {
  expect(usesSdkAtRuntime(readFileSync(join(ROOT, "components/providers/PrivyBridgeState.tsx"), "utf8"))).toBe(true);
  expect(usesSdkAtRuntime('const m = await import("@privy-io/react-auth");')).toBe(true);
  expect(usesSdkAtRuntime('export { usePrivy } from "@privy-io/react-auth";')).toBe(true);
  expect(usesSdkAtRuntime('import {\n  usePrivy,\n} from "@privy-io/react-auth/solana";')).toBe(true);
  expect(usesSdkAtRuntime('import type { User } from "@privy-io/react-auth";\nimport type {\n  A,\n} from "@privy-io/react-auth/solana";')).toBe(false);
});
