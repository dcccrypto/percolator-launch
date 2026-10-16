/**
 * UX WP-7 screenshots (AC5) from the REAL components: progress (landing, plain labels), almost
 * ready (connecting), almost ready (slow + Try now), ready to trade, pool unsupported (reason ABOVE
 * the disabled launch button). With UX_SHOTS_OUT set the markup is written for
 * scripts/ux-shots/shoot-html.mjs; the assertions run either way.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null, connected: false }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { LaunchSuccess } from "@/components/create/LaunchSuccess";
import { LaunchProgress } from "@/components/create/LaunchProgress";
import { HoldToLaunch } from "@/components/create/HoldToLaunch";
import { KEEPER_REGISTER_COPY } from "@/lib/keeper-register-client";
import { UNSUPPORTED_POOL_COPY, WIZARD_STEP_COPY } from "@/lib/wizard-copy";

async function snap(name: string, el: HTMLElement) {
  const out = process.env.UX_SHOTS_OUT;
  if (!out) return;
  const fs = await import("node:fs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/${name}.html`, el.outerHTML);
}
const success = (over: Record<string, unknown>) =>
  render(<LaunchSuccess tokenSymbol="WIF" tradingFeeBps={5} maxLeverage={5} marketAddress="7A2g9aUDHgJdeg5E53TqcXrVsKGpiaPbKDrJXRi7dfC1" txSigs={[]} onDeployAnother={() => {}} onRetryKeeperRegistration={() => {}} {...over} />);

describe("WP-7 screens", () => {
  it("progress: plain labels in landing order", async () => {
    const labels = [WIZARD_STEP_COPY.createMarket, WIZARD_STEP_COPY.priceSource, WIZARD_STEP_COPY.earnVault, WIZARD_STEP_COPY.creatorStake, WIZARD_STEP_COPY.stakePool];
    const { container } = render(
      <LaunchProgress state={{ step: 2, loading: true, error: null, slabAddress: null, txSigs: [], stepLabel: labels[2], phase: "landing", landingIndex: 3, landingTotal: 5, landingLabels: labels } as never} onReset={() => {}} />,
    );
    expect(container.textContent).not.toMatch(/slab|crank|LP\b|keeper/i);
    await snap("progress", container.firstElementChild as HTMLElement);
  });
  it("market created: actions with the connecting line (no button), then failed with Retry; never 'Ready to trade' before", async () => {
    const a = success({ priceFeedRequired: true, keeperDelegated: false, keeperPhase: "connecting", keeperMessage: KEEPER_REGISTER_COPY.connecting });
    expect(a.container.textContent).toContain("Market created");
    expect(a.container.textContent).not.toContain("Ready to trade");
    expect(a.getByTestId("launch-go-to-market")).toBeTruthy();
    expect(a.queryByTestId("launch-price-retry")).toBeNull();
    await snap("market-created-connecting", a.container.firstElementChild as HTMLElement);
    a.unmount();
    const b = success({ priceFeedRequired: true, keeperDelegated: false, keeperPhase: "failed", keeperMessage: KEEPER_REGISTER_COPY.serverTrouble });
    expect(b.getByTestId("launch-price-retry").textContent).toBe("Retry");
    await snap("market-created-failed", b.container.firstElementChild as HTMLElement);
  });
  it("ready to trade", async () => {
    const r = success({ priceFeedRequired: true, keeperDelegated: true });
    expect(r.container.textContent).toContain("Ready to trade");
    await snap("ready", r.container.firstElementChild as HTMLElement);
  });
  it("pool unsupported: the reason is a line ABOVE the disabled button, never its label", async () => {
    const h = render(<HoldToLaunch onLaunch={() => {}} disabled disabledReason={UNSUPPORTED_POOL_COPY} />);
    expect(h.getByTestId("wizard-launch-blocked").textContent).toBe(UNSUPPORTED_POOL_COPY);
    expect(h.getByTestId("wizard-launch").textContent).not.toContain(UNSUPPORTED_POOL_COPY);
    await snap("pool-unsupported", h.container.firstElementChild as HTMLElement);
  });
});
