"use client";

import { FC } from "react";
import type { RepoCIStatus } from "@/lib/github";

/** Badge colours from a theme token, so they follow light / dark mode. The text mixes in 20% of
 *  --text: the plain light-mode --long / --short / --warning are under 4.5:1 at 11px. */
function tone(color: string) {
  return {
    background: `color-mix(in srgb, ${color} 8%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
    color: `color-mix(in srgb, ${color} 80%, var(--text))`,
  };
}
const NEUTRAL = { background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" };

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
        style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')", ...tone("var(--long)") }}
      >
        ✓ {license.spdx_id}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
      style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')", ...NEUTRAL }}
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
  let style: { background: string; border: string; color: string };
  let dot: string;

  if (daysSince < 7) {
    text = "Active";
    dot = "●";
    style = tone("var(--accent-text)");
  } else if (daysSince < 30) {
    text = "Recent";
    dot = "●";
    style = tone("var(--warning)");
  } else if (daysSince < 90) {
    text = "Quiet";
    dot = "○";
    style = tone("var(--warning)");
  } else {
    text = "Archived?";
    dot = "○";
    style = NEUTRAL;
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]"
      style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')", ...style }}
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
      style={{ fontFamily: "var(--font-mono, 'JetBrains Mono')", ...tone(passing ? "var(--long)" : "var(--short)") }}
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
