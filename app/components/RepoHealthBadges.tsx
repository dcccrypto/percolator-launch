"use client";

import { FC } from "react";
import type { RepoCIStatus } from "@/lib/github";

interface Props {
  license: { spdx_id: string } | null | undefined;
  pushedAt: string | undefined;
  ciStatus: RepoCIStatus | undefined;
}

function LicenceBadge({ license }: { license: { spdx_id: string } | null | undefined }) {
  if (license && license.spdx_id && license.spdx_id !== "NOASSERTION") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
        style={{
          fontFamily: "var(--font-mono, 'JetBrains Mono')",
          background: "rgba(74,222,128,0.08)",
          border: "1px solid rgba(74,222,128,0.20)",
          color: "#4ade80",
        }}
      >
        ✓ {license.spdx_id}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
      style={{
        fontFamily: "var(--font-mono, 'JetBrains Mono')",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "var(--text-muted, rgba(255,255,255,0.30))",
      }}
    >
      No licence
    </span>
  );
}

function ActivityBadge({ pushedAt }: { pushedAt: string | undefined }) {
  if (!pushedAt) return null;

  const daysSince =
    (Date.now() - new Date(pushedAt).getTime()) / (1000 * 60 * 60 * 24);

  let text: string;
  let bg: string;
  let border: string;
  let color: string;
  let dot: string;

  if (daysSince < 7) {
    text = "Active";
    dot = "●";
    bg = "rgba(34,211,238,0.08)";
    border = "rgba(34,211,238,0.20)";
    color = "#22d3ee";
  } else if (daysSince < 30) {
    text = "Recent";
    dot = "●";
    bg = "rgba(251,146,60,0.08)";
    border = "rgba(251,146,60,0.20)";
    color = "#fb923c";
  } else if (daysSince < 90) {
    text = "Quiet";
    dot = "○";
    bg = "rgba(251,146,60,0.08)";
    border = "rgba(251,146,60,0.20)";
    color = "#fb923c";
  } else {
    text = "Archived?";
    dot = "○";
    bg = "rgba(255,255,255,0.04)";
    border = "rgba(255,255,255,0.08)";
    color = "var(--text-muted, rgba(255,255,255,0.30))";
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
      style={{
        fontFamily: "var(--font-mono, 'JetBrains Mono')",
        background: bg,
        border: `1px solid ${border}`,
        color,
      }}
    >
      {dot} {text}
    </span>
  );
}

function CIBadge({ ciStatus }: { ciStatus: RepoCIStatus | undefined }) {
  if (!ciStatus || ciStatus.passing === null) return null;

  const passing = ciStatus.passing;

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
      style={{
        fontFamily: "var(--font-mono, 'JetBrains Mono')",
        background: passing
          ? "rgba(74,222,128,0.08)"
          : "rgba(248,113,113,0.08)",
        border: passing
          ? "1px solid rgba(74,222,128,0.20)"
          : "1px solid rgba(248,113,113,0.20)",
        color: passing ? "#4ade80" : "#f87171",
      }}
    >
      {passing ? "✓ CI passing" : "✗ CI failing"}
    </span>
  );
}

export const RepoHealthBadges: FC<Props> = ({
  license,
  pushedAt,
  ciStatus,
}) => {
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      <LicenceBadge license={license} />
      <ActivityBadge pushedAt={pushedAt} />
      <CIBadge ciStatus={ciStatus} />
    </div>
  );
};
