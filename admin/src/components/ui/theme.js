/**
 * Light / dark theme — the person's own choice, remembered on this device.
 *
 * `null` means "follow the operating system" (the CSS media query decides);
 * "light" or "dark" is pinned as `data-theme` on <html>. index.html applies the
 * stored choice before the first paint, so a page never flashes the wrong
 * theme. Storage can be unavailable (private window, blocked site data): every
 * read and write is guarded, and the panel still renders in the system theme.
 */
const KEY = "wz-theme";

export function storedTheme() {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme() {
  try {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The theme on screen now. */
export function effectiveTheme() {
  return storedTheme() || systemTheme();
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  try {
    if (theme === "light" || theme === "dark") window.localStorage.setItem(KEY, theme);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

/**
 * Calls `onChange(theme)` whenever the operating system switches between light
 * and dark, so the switch's label stays true while no choice is stored.
 * Returns the unsubscribe function.
 */
export function watchSystemTheme(onChange) {
  try {
    const query = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (!query) return () => {};
    const listener = (event) => onChange(event.matches ? "dark" : "light");
    if (query.addEventListener) {
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    }
    if (query.addListener) {
      query.addListener(listener);
      return () => query.removeListener(listener);
    }
  } catch {
    /* no media queries: nothing to follow */
  }
  return () => {};
}
