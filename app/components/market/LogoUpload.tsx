"use client";

import { FC, useState, useRef, ChangeEvent } from "react";
import { useLogoUpload } from "@/hooks/useLogoUpload";
import { useToast } from "@/hooks/useToast";

interface LogoUploadProps {
  slabAddress: string;
  currentLogoUrl?: string | null;
  onSuccess?: (logoUrl: string) => void;
  size?: "sm" | "md" | "lg";
}

export const LogoUpload: FC<LogoUploadProps> = ({
  slabAddress,
  currentLogoUrl,
  onSuccess,
  size = "md",
}) => {
  const { uploading, error, uploadLogo } = useLogoUpload();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentLogoUrl || null);
  const [isDragging, setIsDragging] = useState(false);

  const sizeClasses = {
    sm: "h-16 w-16",
    md: "h-24 w-24",
    lg: "h-32 w-32",
  };

  const handleFileSelect = async (file: File) => {
    // Validate file type
    const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml"];
    if (!allowedTypes.includes(file.type)) {
      toast("Invalid file type. Please upload PNG, JPG, GIF, WEBP, or SVG.", "error");
      return;
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      toast("File too large. Maximum size is 5MB.", "error");
      return;
    }

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    // Upload file
    const logoUrl = await uploadLogo(slabAddress, file);
    if (logoUrl) {
      toast("Logo uploaded successfully!", "success");
      onSuccess?.(logoUrl);
    } else if (error) {
      toast(error, "error");
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Preview / Upload Area */}
      <div
        className={`relative ${sizeClasses[size]} rounded-sm border-2 transition-all ${
          isDragging
            ? "border-[var(--accent)] bg-[var(--accent)]/10"
            : "border-[var(--border)] bg-[var(--bg-elevated)]"
        } ${uploading ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
      >
        {preview ? (
          <img
            src={preview}
            alt="Market logo"
            className="h-full w-full object-contain rounded-sm"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-2">
            <div className="text-center">
              <svg
                className="mx-auto h-8 w-8 text-[var(--text-dim)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                />
              </svg>
              <p className="mt-1 text-[9px] text-[var(--text-dim)]">
                {size === "sm" ? "+" : "Click or drop"}
              </p>
            </div>
          </div>
        )}

        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-sm">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          </div>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/gif,image/webp,image/svg+xml"
        onChange={handleFileChange}
        className="hidden"
        disabled={uploading}
      />

      {/* Instructions */}
      <div className="text-center">
        <p className="text-[10px] text-[var(--text-dim)]">
          PNG, JPG, GIF, WEBP, or SVG (max 5MB)
        </p>
        {error && (
          <p className="mt-1 text-[10px] text-[var(--short)]">{error}</p>
        )}
      </div>
    </div>
  );
};
