"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/* ─── Inline SVG Icons ─── */
const PlayIcon = () => (
  <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor">
    <polygon points="3,1 12,7 3,13" />
  </svg>
);

const PauseIcon = () => (
  <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor">
    <rect x="2" y="1" width="3.5" height="12" rx="0.5" />
    <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" />
  </svg>
);

const VolUpIcon = () => (
  <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2 5h2l3-3v10l-3-3H2V5z" fill="currentColor" stroke="none" />
    <path d="M9.5 4.5a3.5 3.5 0 0 1 0 5" strokeLinecap="round" />
  </svg>
);

const VolDownIcon = () => (
  <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2 5h2l3-3v10l-3-3H2V5z" fill="currentColor" stroke="none" />
  </svg>
);

export function MusicPlayer() {
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [progress, setProgress] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (prefersReduced) {
      el.style.opacity = "1";
    } else {
      gsap.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" });
    }
  }, [prefersReduced]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    setProgress(audio.currentTime / audio.duration);
  }, []);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      if (playing) {
        audio.pause();
        setPlaying(false);
      } else {
        await audio.play();
        setPlaying(true);
      }
    } catch {
      setPlaying(false);
    }
  }, [playing]);

  const volUp = useCallback(() => {
    setVolume((v) => Math.min(1, +(v + 0.1).toFixed(1)));
  }, []);

  const volDown = useCallback(() => {
    setVolume((v) => Math.max(0, +(v - 0.1).toFixed(1)));
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    setProgress(ratio);
  }, []);

  /* shared touch-friendly button style */
  const btn = "flex h-8 w-8 items-center justify-center text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]";
  const btnMuted = "flex h-8 w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]";

  return (
    <div
      ref={containerRef}
      className="fixed bottom-3 right-3 z-[90] sm:bottom-5 sm:right-5 gsap-fade"
      style={{ opacity: 0 }}
    >
      <audio
        ref={audioRef}
        src="/audio/percolator.mp3"
        preload="metadata"
        loop
        onTimeUpdate={handleTimeUpdate}
      />

      {collapsed ? (
        <button
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--accent)] transition-colors hover:border-[var(--accent)]"
          aria-label="Expand music player"
        >
          <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
            <polygon points="2,1 10,6 2,11" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]">
          {/* Play / Pause */}
          <button onClick={togglePlay} className={btn} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>

          {/* Progress bar — hidden on mobile */}
          <div
            className="hidden h-[1px] w-14 cursor-pointer bg-[var(--border)] sm:block"
            onClick={handleSeek}
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-[var(--accent)]"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          {/* Volume down */}
          <button onClick={volDown} className={btnMuted} aria-label="Volume down">
            <VolDownIcon />
          </button>

          {/* Volume level — hidden on mobile */}
          <span className="hidden w-5 text-center text-[8px] text-[var(--text-muted)] sm:inline">
            {Math.round(volume * 100)}
          </span>

          {/* Volume up */}
          <button onClick={volUp} className={btnMuted} aria-label="Volume up">
            <VolUpIcon />
          </button>

          {/* Collapse */}
          <button
            onClick={() => setCollapsed(true)}
            className={btnMuted}
            aria-label="Minimize player"
          >
            <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
