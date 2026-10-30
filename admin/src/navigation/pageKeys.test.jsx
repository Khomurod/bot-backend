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
  hashForRoute,
  resolveRoute,
  routeFromHash,
} from "./pageKeys";
import { NAV_SECTIONS } from "../components/AdminSidebar";
import { PAGE_COMPONENTS } from "../App";
import { COMMUNICATIONS_TAB_KEYS } from "../pages/CommunicationsPage";
import { SETTINGS_SECTION_KEYS } from "../pages/settings/sections";

/** The tab keys of each page a legacy key may land inside. */
const TABS_OF = { communications: COMMUNICATIONS_TAB_KEYS, settings: SETTINGS_SECTION_KEYS };

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

  test("the five groups are in the order somebody reads them", () => {
    // Business work first, the system after it, configuration last —
    // docs/redesign/structure.md.
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      "Drivers", "Recruiting", "Communications", "Monitoring", "Administration",
    ]);
  });

  test("one entry per page: no two sidebar entries open the same page", () => {
    // Six entries used to open the one Settings page on different tabs, and
    // the highlight stayed on whichever was clicked while the tab moved on.
    const components = Object.values(PAGE_COMPONENTS).map((render) => render({}).type);
    expect(new Set(components).size).toBe(components.length);
  });
});

describe("resolveRoute", () => {
  test("a live key is returned unchanged", () => {
    for (const key of PAGE_KEYS) expect(resolveRoute(key).page).toBe(key);
  });

  test("every legacy key lands on a live page, and on a tab that page really has", () => {
    for (const [old, moved] of Object.entries(LEGACY_PAGE_KEYS)) {
      const route = resolveRoute(old);
      expect(PAGE_KEYS, `${old} -> ${moved}`).toContain(route.page);
      if (route.tab) {
        expect(TABS_OF[route.page], `${old} -> ${moved}`).toContain(route.tab);
      }
    }
  });

  test("the five retired messaging keys each open their own tab of Messages", () => {
    expect(resolveRoute("broadcast")).toEqual({ page: "communications", tab: "send" });
    expect(resolveRoute("questions")).toEqual({ page: "communications", tab: "surveys" });
    expect(resolveRoute("scheduled")).toEqual({ page: "communications", tab: "scheduled" });
    expect(resolveRoute("bot_messages")).toEqual({ page: "communications", tab: "history" });
    expect(resolveRoute("manager")).toEqual({ page: "communications", tab: "edit_by_link" });
  });

  test("every old Settings entry opens its own section, never just the first one", () => {
    expect(resolveRoute("settings_integrations")).toEqual({ page: "settings", tab: "location" });
    expect(resolveRoute("settings_board")).toEqual({ page: "settings", tab: "board" });
    expect(resolveRoute("settings_ai")).toEqual({ page: "settings", tab: "ai" });
    expect(resolveRoute("settings_notifications")).toEqual({ page: "settings", tab: "notifications" });
    expect(resolveRoute("settings_reactions")).toEqual({ page: "settings", tab: "reactions" });
    expect(resolveRoute("settings_access")).toEqual({ page: "settings", tab: "access" });
  });

  test("a live key wins over a legacy one of the same name", () => {
    // So that re-using a retired name for a new page can never be shadowed by
    // its own history — `settings` was retired, and came back as a live key in
    // October 2026.
    for (const old of Object.keys(LEGACY_PAGE_KEYS)) {
      expect(PAGE_KEYS.includes(old), `${old} must not be live while retired`).toBe(false);
    }
  });

  test("anything unrecognised opens the default page, never nothing", () => {
    for (const junk of ["", "   ", null, undefined, "nope", "../etc/passwd", 7, {}]) {
      expect(resolveRoute(junk).page).toBe(DEFAULT_PAGE_KEY);
    }
  });

  test("surrounding whitespace is tolerated", () => {
    expect(resolveRoute("  home_time  ").page).toBe("home_time");
  });
});

describe("hash round-trip", () => {
  test("no hash at all means no opinion", () => {
    // null, not the default — the caller decides, and a path-based public page
    // must not be overridden by an empty hash.
    expect(routeFromHash("")).toBeNull();
    expect(routeFromHash("#")).toBeNull();
    expect(routeFromHash(null)).toBeNull();
  });

  test("a hash names its page, with or without the #", () => {
    expect(routeFromHash("#live_locations").page).toBe("live_locations");
    expect(routeFromHash("live_locations").page).toBe("live_locations");
  });

  test("the second half of the hash is the tab, and anything deeper is ignored", () => {
    // Reading the whole thing as one key would fall back to Driver Groups.
    expect(routeFromHash("#communications/scheduled")).toEqual({ page: "communications", tab: "scheduled" });
    expect(routeFromHash("#settings/board/anything")).toEqual({ page: "settings", tab: "board" });
    expect(routeFromHash("#home_time")).toEqual({ page: "home_time", tab: null });
  });

  test("a legacy key's own tab is replaced by the one its content moved to", () => {
    expect(routeFromHash("#settings_ai/anything")).toEqual({ page: "settings", tab: "ai" });
  });

  test("a bookmarked hash from before a page moved still opens its content", () => {
    expect(routeFromHash("#broadcast").page).toBe("communications");
    expect(routeFromHash("#settings_board")).toEqual({ page: "settings", tab: "board" });
  });

  test("every live key survives a round trip through the hash", () => {
    for (const key of PAGE_KEYS) {
            expect(routeFromHash(hashForRoute(key, "x"))).toEqual({ page: key, tab: "x" });
    }
  });

  test("a legacy key's address is the address of where it went", () => {
    // What App rewrites an old bookmark to, in place.
    expect(hashForRoute("settings_board")).toBe("#settings/board");
    expect(hashForRoute("broadcast")).toBe("#communications/send");
    expect(hashForRoute("groups")).toBe("#groups");
  });
});
