"use client";

import { useState, useRef } from "react";
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

const ROLE_OPTIONS = [
  { value: "developer", label: "Developer", desc: "Smart contracts, frontend, backend" },
  { value: "designer", label: "Designer", desc: "UI/UX, branding, visual design" },
  { value: "community", label: "Community", desc: "Moderation, support, growth" },
  { value: "marketing", label: "Marketing", desc: "Content, partnerships, outreach" },
  { value: "trader", label: "Trader", desc: "Market making, testing, feedback" },
  { value: "other", label: "Other", desc: "Something else entirely" },
];

const EXPERIENCE_OPTIONS = [
  { value: "junior", label: "Junior" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "lead", label: "Lead" },
];

const AVAILABILITY_OPTIONS = [
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "freelance", label: "Freelance" },
  { value: "contributor", label: "Contributor" },
];

export default function JoinPage() {
  const [form, setForm] = useState({
    name: "",
    twitter_handle: "",
    discord: "",
    telegram: "",
    email: "",
    desired_role: "",
    experience_level: "",
    about: "",
    portfolio_links: "",
    availability: "",
    solana_wallet: "",
  });

  const [cvFile, setCvFile] = useState<{ name: string; data: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError("");
  };

  const handleFile = (file: File) => {
    const validTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!validTypes.includes(file.type)) {
      setError("Only PDF, DOC, and DOCX files are accepted");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("File must be under 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCvFile({ name: file.name, data: reader.result as string });
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) return setError("Name is required");
    if (!form.twitter_handle.trim()) return setError("Twitter handle is required");
    if (!form.email.trim() || !form.email.includes("@")) return setError("Valid email is required");
    if (!form.desired_role) return setError("Please select a role");
    if (!form.experience_level) return setError("Please select your experience level");
    if (!form.about.trim()) return setError("Tell us about yourself");
    if (!form.availability) return setError("Please select your availability");

    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          twitter_handle: form.twitter_handle.replace(/^@/, ""),
          cv_filename: cvFile?.name ?? null,
          cv_data: cvFile?.data ?? null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to submit");
      }

      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to submit application");
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
            <h2 className="text-lg font-bold text-white mb-2">Application Submitted</h2>
            <p className={textMuted}>
              Thanks {form.name} — we&apos;ll review your application and reach out via @{form.twitter_handle.replace(/^@/, "")} or email.
            </p>
            <div className="mt-8 flex items-center justify-center gap-4">
              <button
                onClick={() => {
                  setSubmitted(false);
                  setForm({
                    name: "",
                    twitter_handle: "",
                    discord: "",
                    telegram: "",
                    email: "",
                    desired_role: "",
                    experience_level: "",
                    about: "",
                    portfolio_links: "",
                    availability: "",
                    solana_wallet: "",
                  });
                  setCvFile(null);
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
      <div className="relative mx-auto max-w-6xl px-4 py-10">
        {/* Header */}
        <ScrollReveal>
          <div className="mb-8">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // careers
            </div>
            <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              <span className="font-bold">Join</span>{" "}
              <span className="font-normal text-white/50">Us</span>
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              Help build the future of perpetual futures on Solana.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* Left: Form */}
          <div className="space-y-6">
            {/* Contact Info */}
            <div className={card}>
              <h2 className={h2Style}>Contact Info</h2>
              <div className="space-y-4">
                <div>
                  <label className={labelStyle}>Name / Alias *</label>
                  <input
                    type="text"
                    placeholder="What should we call you?"
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    maxLength={100}
                    className={inputStyle}
                  />
                </div>
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
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelStyle}>Discord Username</label>
                    <input
                      type="text"
                      placeholder="username"
                      value={form.discord}
                      onChange={(e) => update("discord", e.target.value)}
                      maxLength={50}
                      className={inputStyle}
                    />
                  </div>
                  <div>
                    <label className={labelStyle}>Telegram Handle</label>
                    <input
                      type="text"
                      placeholder="@username"
                      value={form.telegram}
                      onChange={(e) => update("telegram", e.target.value)}
                      maxLength={50}
                      className={inputStyle}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelStyle}>Email *</label>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={(e) => update("email", e.target.value)}
                    maxLength={200}
                    className={inputStyle}
                  />
                </div>
              </div>
            </div>

            {/* Role & Experience */}
            <div className={card}>
              <h2 className={h2Style}>Role & Experience</h2>
              <div className="space-y-4">
                <div>
                  <label className={labelStyle}>Desired Role *</label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {ROLE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => update("desired_role", opt.value)}
                        className={`rounded-sm border px-3 py-2.5 text-left transition-all ${
                          form.desired_role === opt.value
                            ? "border-[var(--accent)] bg-[var(--accent)]/5"
                            : "border-[var(--border)] hover:border-[var(--border-hover)]"
                        }`}
                      >
                        <span className="text-[12px] font-medium text-white">{opt.label}</span>
                        <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={labelStyle}>Experience Level *</label>
                  <div className="flex flex-wrap gap-2">
                    {EXPERIENCE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => update("experience_level", opt.value)}
                        className={`rounded-sm border px-4 py-1.5 text-[11px] font-medium transition-all ${
                          form.experience_level === opt.value
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-white"
                            : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-white"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* About */}
            <div className={card}>
              <h2 className={h2Style}>About You</h2>
              <div className="space-y-4">
                <div>
                  <label className={labelStyle}>Tell Us About Yourself *</label>
                  <textarea
                    rows={5}
                    placeholder="Tell us about yourself, your experience, and why you want to join"
                    value={form.about}
                    onChange={(e) => update("about", e.target.value)}
                    maxLength={3000}
                    className={textareaStyle}
                  />
                  <p className="mt-1 text-right text-[10px] text-[var(--text-dim)]">{form.about.length}/3000</p>
                </div>
                <div>
                  <label className={labelStyle}>Portfolio / Links</label>
                  <textarea
                    rows={3}
                    placeholder="GitHub, portfolio, relevant links"
                    value={form.portfolio_links}
                    onChange={(e) => update("portfolio_links", e.target.value)}
                    maxLength={1000}
                    className={textareaStyle}
                  />
                </div>
                <div>
                  <label className={labelStyle}>CV Upload</label>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileRef.current?.click()}
                    className={`rounded-sm border-2 border-dashed px-4 py-8 text-center cursor-pointer transition-all ${
                      dragOver
                        ? "border-[var(--accent)] bg-[var(--accent)]/5"
                        : cvFile
                        ? "border-[var(--long)]/30 bg-[var(--long)]/5"
                        : "border-[var(--border)] hover:border-[var(--border-hover)]"
                    }`}
                  >
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".pdf,.doc,.docx"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFile(file);
                      }}
                    />
                    {cvFile ? (
                      <div>
                        <p className="text-[13px] text-white font-medium">{cvFile.name}</p>
                        <button
                          onClick={(e) => { e.stopPropagation(); setCvFile(null); }}
                          className="mt-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--short)] transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div>
                        <svg className="mx-auto mb-2 h-6 w-6 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4 4 4M4 20h16" />
                        </svg>
                        <p className="text-[12px] text-[var(--text-muted)]">Drop your CV here or click to browse</p>
                        <p className="mt-1 text-[10px] text-[var(--text-dim)]">PDF, DOC, DOCX — max 5MB</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Availability & Wallet */}
            <div className={card}>
              <h2 className={h2Style}>Availability & Wallet</h2>
              <div className="space-y-4">
                <div>
                  <label className={labelStyle}>Availability *</label>
                  <div className="flex flex-wrap gap-2">
                    {AVAILABILITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => update("availability", opt.value)}
                        className={`rounded-sm border px-4 py-1.5 text-[11px] font-medium transition-all ${
                          form.availability === opt.value
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-white"
                            : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)] hover:text-white"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={labelStyle}>Solana Wallet Address</label>
                  <input
                    type="text"
                    placeholder="Your Solana wallet address"
                    value={form.solana_wallet}
                    onChange={(e) => update("solana_wallet", e.target.value)}
                    maxLength={50}
                    className={inputStyle}
                  />
                  <p className="mt-1 text-[10px] text-[var(--text-dim)]">Optional — for future payments or token grants</p>
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
                className="bg-[var(--accent)] px-8 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {submitting ? "Submitting..." : "Submit Application"}
              </button>
            </div>
          </div>

          {/* Right: Info sidebar */}
          <div className="hidden lg:block space-y-6">
            <div className={card}>
              <h2 className={h2Style}>Why Join?</h2>
              <ul className="space-y-3">
                {[
                  { title: "Early Stage", desc: "Get in on the ground floor of a new DeFi protocol" },
                  { title: "Token Allocation", desc: "Contributors receive token grants and revenue share" },
                  { title: "Fully Remote", desc: "Work from anywhere, async-first culture" },
                  { title: "Ship Fast", desc: "Small team, big impact — no bureaucracy" },
                  { title: "Cutting Edge", desc: "Work with Solana, DeFi, and perpetual futures" },
                ].map((item) => (
                  <li key={item.title} className="flex items-start gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-[var(--accent)]" />
                    <div>
                      <p className="text-[12px] font-medium text-white">{item.title}</p>
                      <p className="text-[11px] text-[var(--text-dim)]">{item.desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className={card}>
              <h2 className={h2Style}>What We Look For</h2>
              <ul className="space-y-2">
                {[
                  "Passion for DeFi and decentralized systems",
                  "Self-starter who thrives in ambiguity",
                  "Strong communication skills",
                  "Ownership mentality — ship and iterate",
                  "Curiosity and willingness to learn",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                    <span className="text-[12px] text-[var(--text-secondary)]">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
