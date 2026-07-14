"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { MarketLogo } from "@/components/market/MarketLogo";
import { useWalletCompat } from "@/hooks/useWalletCompat";

interface LogoUploadProps {
  /** Upload by slab address (market must exist) */
  slabAddress?: string;
  /** Upload by mint address (no market required — for faucet) */
  mintAddress?: string;
  /**
   * Mainnet contract address of the token this market prices — when set and
   * no logo has been manually uploaded yet, the preview shows the token's
   * real DEX logo (GeckoTerminal → DexScreener) instead of just initials, so
   * "Upload Logo" reads as optional rather than mandatory for tokens that
   * already have a known logo.
   */
  mainnetCa?: string | null;
  symbol?: string;
}

export const LogoUpload: FC<LogoUploadProps> = ({ slabAddress, mintAddress, mainnetCa, symbol }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const wallet = useWalletCompat();

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

      // Market (slab) logos are gated by a per-market wallet ownership proof
      // (see app/api/markets/[slab]/logo/route.ts) — sign it up front so a
      // wallet that can't (no connection, or signMessage unsupported) fails
      // fast with an actionable message instead of a confusing 400/401 from
      // the server. The mintAddress (faucet) path is unauthenticated and
      // untouched — out of scope here.
      let deployer: string | undefined;
      let signature: string | undefined;
      if (slabAddress) {
        if (!wallet.publicKey || !wallet.signMessage) {
          setError("Connect the creator wallet to upload a logo.");
          return;
        }
        try {
          const unixMinute = Math.floor(Date.now() / 60_000);
          const proofMsg = new TextEncoder().encode(`market-logo:${slabAddress}:${unixMinute}`);
          const sig = await wallet.signMessage(proofMsg);
          deployer = wallet.publicKey.toBase58();
          signature = Buffer.from(sig).toString("base64");
        } catch (sigErr) {
          setError(sigErr instanceof Error ? sigErr.message : "Wallet signature declined");
          return;
        }
      }

      setPreview(URL.createObjectURL(file));
      setError(null);
      setUploading(true);

      try {
        const form = new FormData();
        form.append("logo", file);
        if (deployer && signature) {
          form.append("deployer", deployer);
          form.append("signature", signature);
        }

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
    [endpoint, slabAddress, wallet]
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
      <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">
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
            <MarketLogo logoUrl={logoUrl} mainnetCa={mainnetCa} symbol={symbol} size="lg" />
          )}
        </div>

        <div className="flex-1">
          {logoUrl ? (
            <div>
              <p className="text-[11px] text-[var(--accent)]">Logo uploaded</p>
              <button
                onClick={() => { setLogoUrl(null); setError(null); }}
                className="mt-1 text-[10px] text-[var(--text-secondary)] underline hover:text-[var(--text)]"
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
                className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)] disabled:opacity-40"
              >
                {uploading ? "Uploading..." : "Upload Logo"}
              </button>
              <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
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
