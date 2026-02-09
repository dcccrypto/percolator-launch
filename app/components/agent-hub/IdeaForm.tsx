"use client";

import { useState } from "react";
import { mutate } from "swr";

export default function IdeaForm() {
  const [handle, setHandle] = useState("");
  const [idea, setIdea] = useState("");
  const [contact, setContact] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [errorMsg, setErrorMsg] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim() || !idea.trim()) return;

    setStatus("sending");
    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handle.trim(),
          idea: idea.trim(),
          contact: contact.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit");
      }

      setStatus("sent");
      setIdea("");
      setContact("");
      mutate("/api/ideas");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err: unknown) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <section className="w-full max-w-4xl mx-auto px-4 mb-16">
      <h2 className="text-sm font-mono text-[#00FFB2] mb-3 uppercase tracking-widest">
        &gt; submit idea
      </h2>
      <form
        onSubmit={submit}
        className="rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-6 space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <input
            type="text"
            placeholder="your handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={30}
            required
            className="bg-white/[0.05] border border-white/[0.06] rounded-lg px-4 py-2.5 text-[#F0F4FF] placeholder-[#5a6382] outline-none focus:border-[#00FFB2]/40 transition-colors"
          />
          <input
            type="text"
            placeholder="contact (optional — twitter, email)"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={100}
            className="bg-white/[0.05] border border-white/[0.06] rounded-lg px-4 py-2.5 text-[#F0F4FF] placeholder-[#5a6382] outline-none focus:border-[#00FFB2]/40 transition-colors"
          />
        </div>
        <textarea
          placeholder="describe your idea for Percolator..."
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          maxLength={500}
          required
          rows={3}
          className="w-full bg-white/[0.05] border border-white/[0.06] rounded-lg px-4 py-2.5 text-[#F0F4FF] placeholder-[#5a6382] outline-none focus:border-[#00FFB2]/40 transition-colors resize-none"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={status === "sending"}
            className="bg-[#00FFB2] text-[#06080d] font-bold rounded-xl px-6 py-2.5 hover:brightness-110 disabled:opacity-50 transition-all"
          >
            {status === "sending" ? "Submitting..." : "Submit"}
          </button>
          {status === "sent" && (
            <span className="text-[#00FFB2] text-sm font-mono">
              ✓ idea submitted
            </span>
          )}
          {status === "error" && (
            <span className="text-red-400 text-sm font-mono">{errorMsg}</span>
          )}
        </div>
      </form>
    </section>
  );
}
