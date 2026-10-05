"use client";

import { type FC } from "react";
import { MOVE_COPY } from "@/lib/v21/move/copy";
import { useMoveFlow, stepHref } from "@/hooks/useMoveFlow";
import { MovePlanView } from "./MovePlanView";
import { successorFor } from "@/lib/v21/move/successors";
import { MarketExecutorHost } from "./MarketExecutorHost";

export const MoveFlow: FC = () => {
  const f = useMoveFlow();
  if (!f.enabled) return null;
  const body = (() => {
    if (f.state === "connect") return <p data-testid="move-connect">{MOVE_COPY.connect}</p>;
    if (f.state === "loading" || (f.state === "ready" && !f.plan)) return <p data-testid="move-loading">{MOVE_COPY.loading}</p>;
    if (f.state === "error") return <p role="alert" data-testid="move-error">{MOVE_COPY.scanFailed}</p>;
    if (!f.plan || f.summary === null) return null;
    if (f.summary === "nothing-to-move") return <p data-testid="move-nothing">{MOVE_COPY.nothing}</p>;
    const plan = f.plan;
    return (
      <MovePlanView
        plan={plan}
        summary={f.summary}
        v21Live={f.v21Live}
        running={f.running}
        hrefFor={(s) => {
          const sym = plan.markets.find((m) => m.slab === s.slab)?.symbol ?? "";
          return stepHref(s.kind, s.slab, successorFor(f.successors, null, sym)?.v21Slab ?? null, s.handoff);
        }}
        onRun={() => void f.run()}
        onRunStep={(s) => void f.run({ slab: s.slab, kind: s.kind })}
        error={f.lastError}
        onRescan={() => void f.rescan()}
      />
    );
  })();
  return (
    <main className="mx-auto max-w-2xl px-4 py-8" data-testid="move-flow">
      <h1 className="text-lg font-medium text-[var(--text)]">{MOVE_COPY.title}</h1>
      <p className="mb-5 mt-1 text-[12px] text-[var(--text-secondary)]">{MOVE_COPY.intro}</p>
      <div className="text-[12px] text-[var(--text-secondary)]">{body}</div>
      {f.hostSlab && <MarketExecutorHost slab={f.hostSlab} onBridge={f.onBridge} />}
    </main>
  );
};
