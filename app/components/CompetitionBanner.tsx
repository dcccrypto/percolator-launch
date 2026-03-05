"use client";

import { useEffect, useState } from "react";

/** S2 sprint end: March 21, 2026 23:59:59 UTC */
const COMPETITION_END = new Date("2026-03-21T23:59:59Z").getTime();

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

function calcTimeLeft(): TimeLeft {
  const diff = COMPETITION_END - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor((diff % 86_400_000) / 3_600_000),
    minutes: Math.floor((diff % 3_600_000) / 60_000),
    seconds: Math.floor((diff % 60_000) / 1_000),
    expired: false,
  };
}

function Digit({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <span
        className="text-2xl sm:text-3xl font-bold tabular-nums leading-none"
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--text)",
          minWidth: "2.5ch",
          textAlign: "center",
        }}
      >
        {String(value).padStart(2, "0")}
      </span>
      <span
        className="text-[10px] uppercase tracking-widest mt-1"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

function Separator() {
  return (
    <span
      className="text-xl sm:text-2xl font-bold self-start mt-0.5"
      style={{ color: "var(--text-muted)", opacity: 0.4 }}
    >
      :
    </span>
  );
}

export default function CompetitionBanner() {
  const [time, setTime] = useState<TimeLeft>(calcTimeLeft);

  useEffect(() => {
    const id = setInterval(() => setTime(calcTimeLeft()), 1_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="relative overflow-hidden border mb-8"
      style={{
        background:
          "linear-gradient(135deg, rgba(153,69,255,0.08) 0%, rgba(153,69,255,0.02) 100%)",
        borderColor: "rgba(153,69,255,0.25)",
      }}
    >
      {/* Accent line */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(153,69,255,0.6), transparent)",
        }}
      />

      <div className="px-5 py-5 sm:px-6 sm:py-6">
        {/* Top row: badges */}
        <div className="flex items-center gap-2 mb-3">
          <span
            className="text-[10px] font-mono font-bold px-2 py-0.5 tracking-widest"
            style={{
              background: "var(--accent)",
              color: "#fff",
            }}
          >
            BETA
          </span>
          <span
            className="text-[10px] font-mono px-2 py-0.5 tracking-wider border"
            style={{
              color: "var(--accent)",
              borderColor: "rgba(153,69,255,0.3)",
              background: "rgba(153,69,255,0.06)",
            }}
          >
            S2 DEVNET COMPETITION
          </span>
        </div>

        {/* Title */}
        <h2
          className="text-sm sm:text-base font-semibold mb-1"
          style={{ color: "var(--text)", fontFamily: "var(--font-display)" }}
        >
          {time.expired
            ? "Competition Ended"
            : "Devnet Trading Competition — Sprint 2"}
        </h2>
        <p
          className="text-xs font-mono mb-4"
          style={{ color: "var(--text-secondary)" }}
        >
          {time.expired
            ? "Final rankings are locked. Stay tuned for S3."
            : "Trade to climb the leaderboard. Top performers earn early access + rewards."}
        </p>

        {/* Countdown */}
        {!time.expired && (
          <div className="flex items-center gap-2 sm:gap-3">
            <Digit value={time.days} label="Days" />
            <Separator />
            <Digit value={time.hours} label="Hrs" />
            <Separator />
            <Digit value={time.minutes} label="Min" />
            <Separator />
            <Digit value={time.seconds} label="Sec" />

            <span
              className="ml-auto text-[10px] font-mono hidden sm:block"
              style={{ color: "var(--text-muted)" }}
            >
              Ends Mar 21, 2026
            </span>
          </div>
        )}

        {time.expired && (
          <div
            className="text-xs font-mono px-3 py-2 inline-block border"
            style={{
              color: "var(--text-muted)",
              borderColor: "var(--border)",
              background: "var(--panel-bg)",
            }}
          >
            ✓ COMPETITION COMPLETE — RANKINGS FINAL
          </div>
        )}
      </div>
    </div>
  );
}
