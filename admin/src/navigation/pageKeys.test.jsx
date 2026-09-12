/**
 * The page vocabulary, and the agreement nothing used to check.
 *
 * The sidebar's item list and App.jsx's page map are the same twenty-odd keys
 * authored twice. Before this file, a typo in either raised nothing: the map
 * lookup missed, the `|| groups` fallback fired, and clicking "Fuel Monitor"
 * opened Driver Groups. `vite build` passed, `lint:undef` passed, and the only
 * way to find it was to click every item.
 *
 * The three lists are held to each other here. Everything else in this file is
 * about what happens to a key that is NOT live — a hash somebody bookmarked
 * before a page moved.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_PAGE_KEY,
  LEGACY_PAGE_KEYS,
  PAGE_KEYS,
  hashForPageKey,
  isLivePageKey,
  pageKeyFromHash,
  resolvePageKey,
} from "./pageKeys";
import { NAV_SECTIONS } from "../components/AdminSidebar";
import { PAGE_COMPONENTS } from "../App";

describe("the three lists agree", () => {
  test("every sidebar item names a live page key", () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        expect(PAGE_KEYS, `sidebar item ${section.label} / ${item.label}`)
          .toContain(item.key);
      }
    }
  });

  test("every sidebar item has something to render", () => {
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        expect(Object.keys(PAGE_COMPONENTS), `sidebar item ${item.key}`)
          .toContain(item.key);
      }
    }
  });

  test("the page map and the vocabulary hold exactly the same keys", () => {
    expect([...Object.keys(PAGE_COMPONENTS)].sort()).toEqual([...PAGE_KEYS].sort());
  });

  test("no key is reachable only through the map — every one is in the sidebar", () => {
    // A page with no nav item is a page nobody can open: page state is
    // in-memory and the sidebar is the only thing that sets it, apart from a
    // hash the person has to already know.
    const navKeys = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.key));
    expect([...navKeys].sort()).toEqual([...PAGE_KEYS].sort());
  });

  test("no key appears in two sections, and no section is empty", () => {
    const navKeys = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.key));
    expect(new Set(navKeys).size).toBe(navKeys.length);
    for (const section of NAV_SECTIONS) {
      expect(section.items.length, `section ${section.label}`).toBeGreaterThan(0);
    }
  });

  test("the five sections are in the order somebody reads them", () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      "Operations", "Groups", "Communications", "Recruiting", "Settings",
    ]);
  });
});

describe("resolvePageKey", () => {
  test("a live key is returned unchanged", () => {
    for (const key of PAGE_KEYS) expect(resolvePageKey(key)).toBe(key);
  });

  test("every legacy key lands on a live page", () => {
    for (const [old, moved] of Object.entries(LEGACY_PAGE_KEYS)) {
      expect(PAGE_KEYS, `${old} -> ${moved}`).toContain(moved);
      expect(resolvePageKey(old)).toBe(moved);
    }
  });

  test("the five retired messaging keys all open Communications", () => {
    for (const old of ["broadcast", "questions", "scheduled", "bot_messages", "manager"]) {
      expect(resolvePageKey(old)).toBe("communications");
    }
  });

  test("a live key wins over a legacy one of the same name", () => {
    // So that re-using a retired name for a new page can never be shadowed by
    // its own history. `settings` is retired today; if it ever came back as a
    // live key, this is the rule that would make it win.
    for (const old of Object.keys(LEGACY_PAGE_KEYS)) {
      expect(isLivePageKey(old), `${old} must not be live while retired`).toBe(false);
    }
  });

  test("anything unrecognised opens the default page, never nothing", () => {
    for (const junk of ["", "   ", null, undefined, "nope", "../etc/passwd", 7, {}]) {
      expect(resolvePageKey(junk)).toBe(DEFAULT_PAGE_KEY);
    }
  });

  test("surrounding whitespace is tolerated", () => {
    expect(resolvePageKey("  fuel_monitor  ")).toBe("fuel_monitor");
  });
});

describe("hash round-trip", () => {
  test("no hash at all means no opinion", () => {
    // null, not the default — the caller decides, and a path-based public page
    // must not be overridden by an empty hash.
    expect(pageKeyFromHash("")).toBeNull();
    expect(pageKeyFromHash("#")).toBeNull();
    expect(pageKeyFromHash(null)).toBeNull();
  });

  test("a hash names its page, with or without the #", () => {
    expect(pageKeyFromHash("#route_control")).toBe("route_control");
    expect(pageKeyFromHash("route_control")).toBe("route_control");
  });

  test("a tab hint after the page is ignored, not treated as junk", () => {
    // `#communications/scheduled` is a page and a hint at a tab within it.
    // Reading the whole thing as one key would fall back to Driver Groups.
    expect(pageKeyFromHash("#communications/scheduled")).toBe("communications");
    expect(pageKeyFromHash("#settings_ai/anything/deeper")).toBe("settings_ai");
  });

  test("a bookmarked hash from before a page moved still opens its content", () => {
    expect(pageKeyFromHash("#broadcast")).toBe("communications");
    expect(pageKeyFromHash("#settings")).toBe("settings_integrations");
  });

  test("every live key survives a round trip through the hash", () => {
    for (const key of PAGE_KEYS) {
      expect(pageKeyFromHash(hashForPageKey(key))).toBe(key);
    }
  });
});
