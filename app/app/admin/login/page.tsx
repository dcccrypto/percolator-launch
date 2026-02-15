"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const card = "rounded-none bg-[var(--panel-bg)] border border-[var(--border)] p-8";
const labelStyle = "block text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)] mb-1.5";
const inputStyle =
  "w-full rounded-none border border-[var(--border)] bg-[#0D0D14] px-3 py-2.5 text-[13px] text-white placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push("/admin");
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className={`${card} w-full max-w-[400px]`}>
        <div className="mb-6">
          <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] mb-1">
            Percolator
          </div>
          <h1 className="text-lg font-bold text-white">Admin Access</h1>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className={labelStyle}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputStyle}
              placeholder="admin@percolator.com"
              required
            />
          </div>

          <div>
            <label className={labelStyle}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputStyle}
              placeholder="Enter password"
              required
            />
          </div>

          {error && (
            <div className="text-[12px] text-[var(--short)]">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-none bg-[var(--accent)] px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.15em] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
