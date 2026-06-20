import { useEffect, useState } from "react";

/**
 * Tracks document visibility (tab foreground/background).
 *
 * Use the returned `visible` as an effect *dependency* (not an inline
 * `if (document.hidden) return` inside the loop) so the effect tears the
 * loop down when the tab is hidden and recreates it when it comes back.
 * An inline early-return pauses but never resumes, because the effect
 * never re-runs on visibility change.
 *
 * When visible, behavior is byte-for-byte identical; when hidden, the
 * guarded loop stops, dropping idle/background CPU+GPU toward zero.
 */
export function usePageVisible() {
  const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
