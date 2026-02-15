"use client";

import { useState, useCallback } from "react";

interface UseLogoUploadResult {
  uploading: boolean;
  error: string | null;
  logoUrl: string | null;
  uploadLogo: (slabAddress: string, file: File) => Promise<string | null>;
  updateLogoUrl: (slabAddress: string, url: string) => Promise<boolean>;
}

export function useLogoUpload(): UseLogoUploadResult {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  const uploadLogo = useCallback(async (slabAddress: string, file: File): Promise<string | null> => {
    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("logo", file);

      const response = await fetch(`/api/markets/${slabAddress}/logo/upload`, {
        method: "POST",
        body: formData,
        headers: {
          "x-api-key": process.env.NEXT_PUBLIC_API_KEY || "",
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to upload logo");
      }

      const data = await response.json();
      setLogoUrl(data.logo_url);
      return data.logo_url;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      console.error("Logo upload error:", err);
      return null;
    } finally {
      setUploading(false);
    }
  }, []);

  const updateLogoUrl = useCallback(async (slabAddress: string, url: string): Promise<boolean> => {
    setUploading(true);
    setError(null);

    try {
      const response = await fetch(`/api/markets/${slabAddress}/logo`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.NEXT_PUBLIC_API_KEY || "",
        },
        body: JSON.stringify({ logo_url: url }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to update logo URL");
      }

      const data = await response.json();
      setLogoUrl(data.market.logo_url);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      console.error("Logo URL update error:", err);
      return false;
    } finally {
      setUploading(false);
    }
  }, []);

  return {
    uploading,
    error,
    logoUrl,
    uploadLogo,
    updateLogoUrl,
  };
}
