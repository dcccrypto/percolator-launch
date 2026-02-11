"use client";

import { useState } from "react";
import Link from "next/link";
import { ScrollReveal } from "@/components/ui/ScrollReveal";

const card = "rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6";
const h2Style = "text-lg font-bold text-white mb-4";
const textMuted = "text-[13px] leading-relaxed text-[var(--text-secondary)]";
const labelStyle = "block text-[11px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)] mb-1.5";
const inputStyle =
  "w-full rounded-sm border border-[var(--border)] bg-[#0D0D14] px-3 py-2.5 text-[13px] text-white placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors";
const textareaStyle =
  "w-full rounded-sm border border-[var(--border)] bg-[#0D0D14] px-3 py-2.5 text-[13px] text-white placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors resize-none";

const SEVERITY_OPTIONS = [
  { value: "low", label: "Low", color: "var(--text-muted)", desc: "Minor visual glitch or cosmetic issue" },
  { value: "medium", label: "Medium", color: "var(--warning)", desc: "Feature not working as expected" },
  { value: "high", label: "High", color: "#FF6B35", desc: "Core functionality broken" },
  { value: "critical", label: "Critical", color: "var(--short)", desc: "Funds at risk, data loss, or security issue" },
];

const PAGE_OPTIONS = [
  "Homepage",
  "Markets",
  "Trade",
  "Create Market",
  "Portfolio",
  "Devnet Faucet",
  "Guide",
  "Other",
];

export default function ReportBugPage() {
  const [form, setForm] = useState({
    twitter_handle: "",
    title: "",
    description: "",
    severity: "medium",
    page: "",
    steps_to_reproduce: "",
    expected_behavior: "",
    actual_behavior: "",
    wallet_address: "",
    browser: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const update = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError("");
  };

  const handleSubmit = async () => {
    if (!form.twitter_handle.trim()) return setError("Twitter handle is required");
    if (!form.title.trim()) return setError("Bug title is required");
    if (!form.description.trim()) return setError("Description is required — be as detailed as possible");

    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/bugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          twitter_handle: form.twitter_handle.replace(/^@/, ""),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to submit");
      }

      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to submit bug report");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <div className="relative mx-auto max-w-2xl px-4 py-10">
          <div className={`${card} text-center py-16`}>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-[var(--long)]/30 bg-[var(--long)]/10">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--long)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-white mb-2">Bug Report Submitted</h2>
            <p className={textMuted}>
              Thanks @{form.twitter_handle.replace(/^@/, "")} — we&apos;ll review this and reach out on X if we need more info.
            </p>
            <div className="mt-8 flex items-center justify-center gap-4">
              <button
                onClick={() => {
                  setSubmitted(false);
                  setForm({
                    twitter_handle: form.twitter_handle,
                    title: "",
                    description: "",
                    severity: "medium",
                    page: "",
                    steps_to_reproduce: "",
                    expected_behavior: "",
                    actual_behavior: "",
                    wallet_address: "",
                    browser: "",
                  });
                }}
                className="border border-[var(--border)] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent)]/10"
              >
                Submit Another
              </button>
              <Link
                href="/"
                className="bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                Back to Percolator
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <div className="relative mx-auto max-w-2xl px-4 py-10 space-y-6">
        {/* Header */}
        <ScrollReveal>
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // report
              </div>
              <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                <span className="font-normal text-white/50">Bug </span>Report
              </h1>
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
                Found something broken? Help us fix it. Be as detailed as possible.
              </p>
            </div>
          </div>
        </ScrollReveal>

        {/* Bounty Banner */}
        <div className="rounded-sm border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-white">Bug bounties paid from creator rewards</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                Valid bug reports are eligible for bounties. We allocate a portion of creator rewards to pay community members who help us find and document bugs. The more detailed your report, the higher the bounty.
              </p>
            </div>
          </div>
        </div>

        {/* Identity */}
        <div className={card}>
          <h2 className={h2Style}>Your Info</h2>
          <div className="space-y-4">
            <div>
              <label className={labelStyle}>Twitter / X Handle *</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--text-dim)]">@</span>
                <input
                  type="text"
                  placeholder="your_handle"
                  value={form.twitter_handle}
                  onChange={(e) => update("twitter_handle", e.target.value)}
                  maxLength={30}
                  className={`${inputStyle} pl-7`}
                />
              </div>
              <p className="mt-1 text-[10px] text-[var(--text-dim)]">So we can follow up with you</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelStyle}>Wallet Address</label>
                <input
                  type="text"
                  placeholder="Optional — your Solana wallet"
                  value={form.wallet_address}
                  onChange={(e) => update("wallet_address", e.target.value)}
                  maxLength={50}
                  className={inputStyle}
                />
              </div>
              <div>
                <label className={labelStyle}>Browser</label>
                <input
                  type="text"
                  placeholder="e.g. Chrome 120, Safari, Brave"
                  value={form.browser}
                  onChange={(e) => update("browser", e.target.value)}
                  maxLength={50}
                  className={inputStyle}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Bug Details */}
        <div className={card}>
          <h2 className={h2Style}>Bug Details</h2>
          <div className="space-y-4">
            <div>
              <label className={labelStyle}>Title *</label>
              <input
                type="text"
                placeholder="Short summary — e.g. Trade form crashes when switching markets"
                value={form.title}
                onChange={(e) => update("title", e.target.value)}
                maxLength={120}
                className={inputStyle}
              />
              <p className="mt-1 text-right text-[10px] text-[var(--text-dim)]">{form.title.length}/120</p>
            </div>

            {/* Severity */}
            <div>
              <label className={labelStyle}>Severity *</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SEVERITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => update("severity", opt.value)}
                    className={`rounded-sm border px-3 py-2 text-left transition-all ${
                      form.severity === opt.value
                        ? "border-[var(--accent)] bg-[var(--accent)]/5"
                        : "border-[var(--border)] hover:border-[var(--border-hover)]"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: opt.color }}
                      />
                      <span className="text-[12px] font-medium text-white">{opt.label}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Page */}
            <div>
              <label className={labelStyle}>Which Page?</label>
              <div className="flex flex-wrap gap-2">
                {PAGE_OPTIONS.map((p) => (
                  <button
                    key={p}
                    onClick={() => update("page", form.page === p ? "" : p)}
                    className={`rounded-sm border px-3 py-1.5 text-[11px] font-medium transition-all ${
                      form.page === p
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-white"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-white"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <label className={labelStyle}>Description *</label>
              <textarea
                rows={4}
                placeholder="What happened? Be as specific as possible — include error messages, console output, or anything relevant."
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                maxLength={2000}
                className={textareaStyle}
              />
              <p className="mt-1 text-right text-[10px] text-[var(--text-dim)]">{form.description.length}/2000</p>
            </div>
          </div>
        </div>

        {/* Reproduction */}
        <div className={card}>
          <h2 className={h2Style}>Reproduction</h2>
          <p className={`${textMuted} mb-4`}>
            The more detail here, the faster we can fix it.
          </p>
          <div className="space-y-4">
            <div>
              <label className={labelStyle}>Steps to Reproduce</label>
              <textarea
                rows={3}
                placeholder={"1. Go to /trade/...\n2. Click the deposit button\n3. Enter amount and submit\n4. See error"}
                value={form.steps_to_reproduce}
                onChange={(e) => update("steps_to_reproduce", e.target.value)}
                maxLength={1000}
                className={textareaStyle}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelStyle}>Expected Behavior</label>
                <textarea
                  rows={2}
                  placeholder="What should have happened?"
                  value={form.expected_behavior}
                  onChange={(e) => update("expected_behavior", e.target.value)}
                  maxLength={500}
                  className={textareaStyle}
                />
              </div>
              <div>
                <label className={labelStyle}>Actual Behavior</label>
                <textarea
                  rows={2}
                  placeholder="What actually happened?"
                  value={form.actual_behavior}
                  onChange={(e) => update("actual_behavior", e.target.value)}
                  maxLength={500}
                  className={textareaStyle}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Error + Submit */}
        {error && (
          <div className="rounded-sm border border-[var(--short)]/30 bg-[var(--short)]/5 px-4 py-3 text-[12px] text-[var(--short)]">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] transition-colors hover:text-white"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </Link>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-[var(--accent)] px-6 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? "Submitting..." : "Submit Bug Report"}
          </button>
        </div>
      </div>
    </div>
  );
}
