import { useCallback, useEffect, useState } from "react";

/**
 * Full screen for the whole page, and whether it is on right now.
 *
 * The state follows the browser, not the button: Esc, F11 or the browser's own
 * exit all fire `fullscreenchange`, so the button never claims the wrong mode.
 * The `webkit` names cover Safari, which shipped them first.
 */

function fullscreenElement() {
  if (typeof document === "undefined") return null;
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

export default function useFullscreen() {
  const [active, setActive] = useState(() => Boolean(fullscreenElement()));
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const supported = Boolean(root && (root.requestFullscreen || root.webkitRequestFullscreen));

  useEffect(() => {
    const sync = () => setActive(Boolean(fullscreenElement()));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const toggle = useCallback(async () => {
    try {
      if (fullscreenElement()) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        const el = document.documentElement;
        await (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
      }
    } catch {
      // Refused (no user gesture, or blocked by the browser): nothing changes,
      // and the state stays whatever `fullscreenchange` last said.
    }
  }, []);

  return { active, supported, toggle };
}
