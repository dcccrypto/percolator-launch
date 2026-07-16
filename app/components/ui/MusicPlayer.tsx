"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
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

/** Routes where the floating player should be hidden on mobile (<640px)
 *  to avoid overlaying critical interactive UI (e.g. trade margin inputs,
 *  stake pool cards that scroll under the player at 370-640px widths). */
const HIDE_ON_MOBILE_ROUTES = ["/trade", "/stake"];

/**
 * Routes where the floating player should move to top-right instead of
 * bottom-right to avoid visually overlapping main content.
 * e.g. /stake pool cards extend close to the right viewport edge at ~1024–1376px
 * and the bottom-right player collides with the rightmost pool card.
 */
const MOVE_TO_TOP_ROUTES = ["/stake"];

/**
 * Routes where the player must move to the bottom-LEFT at lg+ breakpoints
 * to avoid overlapping a right-side panel.
 * /trade: 3-column layout has a fixed 340px right STATS column — player at
 * bottom-right bleeds over Oracle/Stats cells and is mis-read as lw-charts
 * toolbar (GH#1662). Shift to bottom-left at ≥1024px so it sits below the
 * chart, clear of the right panel entirely.
 */
const MOVE_TO_BOTTOM_LEFT_ROUTES_LG = ["/trade"];

/**
 * Match a pathname against a route prefix using exact-or-child semantics:
 * - exact: pathname === route  (e.g. "/trade" matches "/trade")
 * - child: pathname.startsWith(route + "/")  (e.g. "/trade/BTC-PERP" matches "/trade")
 * This prevents false positives like "/trader" matching the prefix "/trade".
 */
function matchesRoute(pathname: string | null | undefined, route: string): boolean {
  if (!pathname) return false;
  return pathname === route || pathname.startsWith(route + "/");
}

/** localStorage key remembering that the user expanded the player. */
const PLAYER_EXPANDED_KEY = "pco-player-expanded";

export function MusicPlayer() {
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [progress, setProgress] = useState(0);
  // Collapsed by default: expanded, the floating pill sits over interactive
  // content (on /trade it covers the OTHER MARKETS table header; on /markets
  // the table edge), and an unlabeled transport strip reads as broken UI to
  // anyone who doesn't know it's a radio. Start as one small labeled button;
  // remember the user's expand across pages (effect below — reading
  // localStorage in the initializer would risk an SSR hydration mismatch).
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(PLAYER_EXPANDED_KEY) === "1") setCollapsed(false);
    } catch {
      // localStorage unavailable — stay collapsed
    }
  }, []);

  const expand = useCallback(() => {
    setCollapsed(false);
    try { localStorage.setItem(PLAYER_EXPANDED_KEY, "1"); } catch {}
  }, []);

  const collapse = useCallback(() => {
    setCollapsed(true);
    try { localStorage.removeItem(PLAYER_EXPANDED_KEY); } catch {}
  }, []);

  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  const pathname = usePathname();

  /* Suppress OS-level media transport overlay.
   * The hidden <audio> element triggers the browser/OS media session API which
   * surfaces native play/pause/skip controls independently of DOM controls.
   * (1) disableRemotePlayback prevents AirPlay/Chromecast picker triggering OS controls.
   * (2) Clearing mediaSession.metadata + nulling all action handlers suppresses the OS overlay. */
  useEffect(() => {
    // disableRemotePlayback is a standard HTMLMediaElement property but is not in
    // React's JSX types, so we set it imperatively.
    if (audioRef.current) {
      (audioRef.current as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    }

    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = null;
    (
      [
        "play",
        "pause",
        "stop",
        "seekbackward",
        "seekforward",
        "previoustrack",
        "nexttrack",
      ] as MediaSessionAction[]
    ).forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        // Older browsers may not support all actions — ignore
      }
    });
  }, []);

  /* Determine if the player should be hidden on mobile for this route */
  const hideOnMobile = HIDE_ON_MOBILE_ROUTES.some((r) => matchesRoute(pathname, r));

  /* Determine if the player should move to top-right to avoid content overlap */
  const moveToTop = MOVE_TO_TOP_ROUTES.some((r) => matchesRoute(pathname, r));

  /* Determine if the player should move to bottom-left at lg+ to avoid right panel overlap */
  const moveToBottomLeftLg = MOVE_TO_BOTTOM_LEFT_ROUTES_LG.some((r) => matchesRoute(pathname, r));

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
      className={`fixed z-[90] gsap-fade${hideOnMobile ? " hidden sm:block" : ""}${
        moveToTop
          ? " top-[80px] right-3 sm:top-[72px] sm:right-5"
          : moveToBottomLeftLg
          ? " bottom-3 right-3 sm:bottom-5 sm:right-5 lg:bottom-5 lg:right-auto lg:left-5"
          : " bottom-[72px] right-3 md:bottom-3 sm:right-5"
      }`}
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
          onClick={expand}
          title="Lo-fi radio"
          className="flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--accent)] transition-colors hover:border-[var(--accent)]"
          aria-label="Open lo-fi radio player"
        >
          {/* Music note — a play triangle here read as a mystery control;
              the note says "this is a radio" before the user commits a click. */}
          <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <path d="M5.5 2.5l6-1.2v7.2a2 2 0 1 1-1-1.73V3.5l-4 .8v6.2a2 2 0 1 1-1-1.73V2.5z" />
          </svg>
        </button>
      ) : (
        <div className="flex items-center rounded-sm border border-[var(--border)] bg-[var(--panel-bg)]" title="Lo-fi radio">
          {/* Play / Pause */}
          <button onClick={togglePlay} className={btn} aria-label={playing ? "Pause lo-fi radio" : "Play lo-fi radio"}>
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
            onClick={collapse}
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
