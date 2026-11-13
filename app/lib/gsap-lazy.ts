/**
 * gsap on demand. A static `import gsap from "gsap"` in an always-mounted component (Header, MusicPlayer, Tooltip)
 * put gsap (~27 KB gzip) in the first-load JS of every page, although each only animates after hydration. `withGsap`
 * runs the callback synchronously once gsap is loaded (so later animations behave exactly as before) and, before
 * that, as soon as the chunk arrives — unless the returned cancel was called first (effect cleanup). `onLoadError`
 * runs instead if the chunk cannot be loaded, for callers whose animation completes an action (a toast's dismiss).
 */
type Gsap = typeof import("gsap").default;

let loaded: Gsap | null = null;
let loading: Promise<Gsap> | null = null;

function loadGsap(): Promise<Gsap> {
  loading ??= import("gsap").then((m) => (loaded = m.default));
  return loading;
}

export function withGsap(run: (gsap: Gsap) => void, onLoadError?: () => void): () => void {
  if (loaded) {
    run(loaded);
    return () => {};
  }
  let cancelled = false;
  loadGsap().then(
    (g) => {
      if (!cancelled) run(g);
    },
    () => {
      loading = null; // chunk failed to load: the next call retries
      if (!cancelled) onLoadError?.();
    },
  );
  return () => {
    cancelled = true;
  };
}
