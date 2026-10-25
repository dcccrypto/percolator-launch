/**
 * Regression: with a Privy app id every page used to be client-rendered whole, because
 * PrivyProvider's internal tree shifts the React useId of every descendant, so server markup and
 * client markup disagreed (label/input ids on /stake). The app now renders OUTSIDE PrivyProvider
 * (PrivyBridgeHost mounts it as a sibling after hydration), so the server renders real content and
 * the client hydrates it with identical ids and no warnings.
 */
import { act, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useId, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn() }));

// Like the real PrivyProvider, the mock puts its own components next to the app inside its tree,
// which forks the tree and shifts the useId of everything under it.
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="privy-internal">
      <span />
      <span />
      {children}
    </div>
  ),
  usePrivy: () => ({ ready: true, authenticated: false, user: null, logout: vi.fn(), exportWallet: vi.fn(), getAccessToken: async () => null }),
  useIdentityToken: () => ({ identityToken: null }),
  useLogin: () => ({ login: vi.fn() }),
  useConnectWallet: () => ({ connectWallet: vi.fn() }),
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  toSolanaWalletConnectors: () => [],
  useFundWallet: () => ({ fundWallet: vi.fn() }),
  useWallets: () => ({ ready: true, wallets: [] }),
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import { PrivyBridgeHost } from "@/components/providers/PrivyBridgeHost";
import { PrivyProvider } from "@privy-io/react-auth";
import { useAsyncUtilTimeout } from "../helpers/async-budget";

// Scoped waitFor budget for this suite only (see helpers/async-budget.ts).
useAsyncUtilTimeout();

/** A /stake-like page: several sibling fields, each with a useId label/input pair. */
function Field({ name }: { name: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id}>{name}</label>
      <input id={id} defaultValue="" />
    </div>
  );
}
function Page() {
  return (
    <main>
      <h1>Stake</h1>
      <section>
        <Field name="Amount" />
        <Field name="Pool" />
      </section>
      <footer>
        <Field name="Memo" />
      </footer>
    </main>
  );
}

const ids = (root: ParentNode) => Array.from(root.querySelectorAll("input")).map((i) => i.id);

describe("Privy deployments render on the server and hydrate cleanly", () => {
  let errors: unknown[][];
  let spies: Array<ReturnType<typeof vi.spyOn>>;
  beforeEach(() => {
    errors = [];
    spies = [
      vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a)),
      vi.spyOn(console, "warn").mockImplementation((...a) => void errors.push(a)),
    ];
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  it("server HTML holds the real page, not an empty shell", () => {
    const html = renderToString(
      <PrivyBridgeHost appId="app">
        <Page />
      </PrivyBridgeHost>,
    );
    expect(html).toContain("<h1>Stake</h1>");
    expect(html).toContain("Amount");
    expect(html).not.toContain("privy-internal"); // PrivyProvider is client-only
  });

  it("hydrates the server markup with no mismatch warnings, the same useIds, then mounts Privy as a sibling", async () => {
    const html = renderToString(
      <PrivyBridgeHost appId="app">
        <Page />
      </PrivyBridgeHost>,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const serverIds = ids(container);
    expect(serverIds).toHaveLength(3);
    const serverInputs = Array.from(container.querySelectorAll("input"));

    await act(async () => {
      hydrateRoot(
        container,
        <PrivyBridgeHost appId="app">
          <Page />
        </PrivyBridgeHost>,
      );
    });
    await waitFor(() => expect(container.querySelector('[data-testid="privy-internal"]')).not.toBeNull());

    expect(ids(container)).toEqual(serverIds); // same useIds after hydration and after Privy mounted
    // Hydrated in place: the very same DOM nodes, not re-created.
    expect(Array.from(container.querySelectorAll("input"))).toEqual(serverInputs);
    const hydrationMessages = errors.filter((e) => /hydrat|did not match|useId|mismatch/i.test(String(e[0])));
    expect(hydrationMessages).toEqual([]);
    // Privy is a sibling of the app, never its ancestor.
    const internal = container.querySelector('[data-testid="privy-internal"]')!;
    expect(internal.contains(container.querySelector("main"))).toBe(false);
    document.body.removeChild(container);
  });

  it("NEGATIVE CONTROL: wrapping the app inside PrivyProvider shifts the ids (the old structure)", () => {
    const withoutProvider = renderToString(<Page />);
    const inside = renderToString(
      <PrivyProvider appId="app">
        <Page />
      </PrivyProvider>,
    );
    const pick = (html: string) => Array.from(html.matchAll(/<input id="([^"]+)"/g)).map((m) => m[1]);
    expect(pick(inside)).not.toEqual(pick(withoutProvider));
  });
});
