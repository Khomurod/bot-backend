/**
 * The light / dark choice.
 *
 * A person's pick is pinned on <html> and remembered on this device; no pick
 * means "follow the operating system". Storage can be unavailable (a private
 * window, blocked site data) and that must never break the panel — the theme
 * still switches for this visit.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyTheme, effectiveTheme, storedTheme } from "./theme";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
  test("a pick is pinned on <html> and remembered", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(storedTheme()).toBe("dark");
    expect(effectiveTheme()).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(storedTheme()).toBe("light");
  });

  test("no pick follows the operating system", () => {
    applyTheme(null);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedTheme()).toBe(null);
    window.matchMedia = vi.fn(() => ({ matches: true }));
    expect(effectiveTheme()).toBe("dark");
    window.matchMedia = vi.fn(() => ({ matches: false }));
    expect(effectiveTheme()).toBe("light");
  });

  test("a stored value that is not a theme is ignored", () => {
    window.localStorage.setItem("wz-theme", "purple");
    expect(storedTheme()).toBe(null);
  });

  test("unavailable storage never throws and the theme still switches", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => applyTheme("dark")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(storedTheme()).toBe(null);
  });
});
