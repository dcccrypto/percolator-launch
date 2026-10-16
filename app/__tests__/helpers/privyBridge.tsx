import type { ReactNode } from "react";
import { usePrivyBridgeState } from "@/components/providers/PrivyBridgeState";
import { PrivyAvailableContext, PrivyLoginContext, PrivySessionHeadersContext } from "@/hooks/usePrivySafe";
import { PrivyBridgeContext } from "@/hooks/usePrivyBridge";

/**
 * Test stand-ins for the Privy bridge host: the production `usePrivyBridgeState()` (the real hook
 * code, over the test's mocked Privy SDK hooks) published into the contexts the app reads. Use as
 * RTL's `wrapper` where a Privy consumer used to be rendered directly under a mocked SDK.
 *
 * `PrivyStateProvider` publishes only `PrivyBridgeContext` (for tests that mock `@/hooks/usePrivySafe`).
 * `PrivyFullBridgeProvider` publishes all of them (availability, connect action, session headers).
 */
export function PrivyStateProvider({ children }: { children: ReactNode }) {
  const { privy } = usePrivyBridgeState();
  return <PrivyBridgeContext.Provider value={privy}>{children}</PrivyBridgeContext.Provider>;
}

export function PrivyFullBridgeProvider({ children }: { children: ReactNode }) {
  const { privy, connect, sessionHeaders } = usePrivyBridgeState();
  return (
    <PrivyAvailableContext.Provider value={true}>
      <PrivyLoginContext.Provider value={connect}>
        <PrivySessionHeadersContext.Provider value={sessionHeaders}>
          <PrivyBridgeContext.Provider value={privy}>{children}</PrivyBridgeContext.Provider>
        </PrivySessionHeadersContext.Provider>
      </PrivyLoginContext.Provider>
    </PrivyAvailableContext.Provider>
  );
}
