"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { MarketLogo } from "@/components/market/MarketLogo";

interface LogoUploadProps {
  /** Upload by slab address (market must exist) */
  slabAddress?: string;
  /** Upload by mint address (no market required — for faucet) */
  mintAddress?: string;
  symbol?: string;
}

export const LogoUpload: FC<LogoUploadProps> = ({ slabAddress, mintAddress, symbol }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const endpoint = mintAddress
    ? `/api/tokens/${mintAddress}/logo`
    : slabAddress
      ? `/api/markets/${slabAddress}/logo`
      : null;

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !endpoint) return;

      const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      if (!allowed.includes(file.type)) {
        setError("Only PNG, JPEG, WebP, or GIF allowed.");
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        setError("Max 2MB file size.");
        return;
      }

      setPreview(URL.createObjectURL(file));
      setError(null);
      setUploading(true);

      try {
        const form = new FormData();
        form.append("logo", file);

        const res = await fetch(endpoint, { method: "POST", body: form });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Upload failed");
        }

        setLogoUrl(data.logo_url);
        setPreview(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setPreview(null);
      } finally {
        setUploading(false);
      }
    },
    [endpoint]
  );

  // Cleanup preview URL to prevent memory leaks
  useEffect(() => {
    return () => {
      if (preview) {
        URL.revokeObjectURL(preview);
      }
    };
  }, [preview]);

  if (!endpoint) return null;

  return (
    <div className="mt-4 border border-[var(--border)] bg-[var(--panel-bg)] p-4">
      <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Token Logo
      </p>

      <div className="flex items-center gap-4">
        <div className="shrink-0">
          {preview ? (
            <img
              src={preview}
              alt="Preview"
              className="h-12 w-12 border border-[var(--border)] object-cover"
            />
          ) : (
            <MarketLogo logoUrl={logoUrl} symbol={symbol} size="lg" />
          )}
        </div>

        <div className="flex-1">
          {logoUrl ? (
            <div>
              <p className="text-[11px] text-[var(--accent)]">Logo uploaded</p>
              <button
                onClick={() => { setLogoUrl(null); setError(null); }}
                className="mt-1 text-[10px] text-[var(--text-dim)] underline hover:text-[var(--text-muted)]"
              >
                Replace
              </button>
            </div>
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/30 hover:text-white disabled:opacity-40"
              >
                {uploading ? "Uploading..." : "Upload Logo"}
              </button>
              <p className="mt-1 text-[10px] text-[var(--text-dim)]">
                PNG, JPEG, WebP, or GIF. Max 2MB.
              </p>
            </>
          )}

          {error && (
            <p className="mt-1 text-[10px] text-[var(--short)]">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
};
