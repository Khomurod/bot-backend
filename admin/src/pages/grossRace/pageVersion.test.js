/**
 * When a race screen reloads itself for a newer build of the page: only on a
 * real difference, never at a bad moment, never in a loop.
 */
import { describe, expect, test } from "vitest";
import { RELOAD_GAP_MS, chunkOf, lastReloadAt, markReload, noteServed, shouldReload } from "./pageVersion";

const TZ = "America/Chicago";
// Monday 12 October 2026, 2:15 PM in Chicago (CDT, UTC-5).
const AFTERNOON = Date.parse("2026-10-12T19:15:00Z");
const FOUR_PM = Date.parse("2026-10-12T21:00:20Z");
const base = {
  own: "GrossRacePage-old1.js", served: "GrossRacePage-new2.js", confirmations: 2,
  now: AFTERNOON, tz: TZ, celebrating: false, lastReloadAt: 0,
};

function memoryStorage() {
  const held = new Map();
  return { getItem: (k) => (held.has(k) ? held.get(k) : null), setItem: (k, v) => held.set(k, String(v)) };
}

describe("chunkOf", () => {
  test("names the chunk a built page was loaded from", () => {
    expect(chunkOf("https://bot.example/admin/assets/GrossRacePage-BgHoDpj_.js")).toBe("GrossRacePage-BgHoDpj_.js");
    expect(chunkOf("https://bot.example/admin/assets/GrossRacePage-BgHoDpj_.js?v=1#x")).toBe("GrossRacePage-BgHoDpj_.js");
  });

  test("is null outside a build, so dev and tests never reload", () => {
    expect(chunkOf("http://localhost:5173/src/pages/grossRace/GrossRacePage.jsx")).toBeNull();
    expect(chunkOf("file:///repo/admin/src/pages/grossRace/GrossRacePage.jsx")).toBeNull();
    expect(chunkOf(undefined)).toBeNull();
  });
});

describe("shouldReload", () => {
  test("a screen behind the server reloads", () => {
    expect(shouldReload(base)).toBe(true);
  });

  test("the same build, or nothing to compare, does not", () => {
    expect(shouldReload({ ...base, served: base.own })).toBe(false);
    expect(shouldReload({ ...base, served: null })).toBe(false);
    expect(shouldReload({ ...base, own: null })).toBe(false);
    expect(shouldReload({ ...base, served: "index-abcd.js" })).toBe(false);
  });

  test("one answer naming another build is not enough: a deploy switching over can send one", () => {
    expect(shouldReload({ ...base, confirmations: 1 })).toBe(false);
    expect(shouldReload({ ...base, confirmations: 0 })).toBe(false);
    expect(shouldReload({ ...base, confirmations: undefined })).toBe(false);
  });

  test("not while the celebration is on screen, nor during 4:00 PM", () => {
    expect(shouldReload({ ...base, celebrating: true })).toBe(false);
    expect(shouldReload({ ...base, now: FOUR_PM })).toBe(false);
    expect(shouldReload({ ...base, now: FOUR_PM + 60_000 })).toBe(true);
  });

  test("not twice within five minutes", () => {
    expect(shouldReload({ ...base, lastReloadAt: AFTERNOON - 60_000 })).toBe(false);
    expect(shouldReload({ ...base, lastReloadAt: AFTERNOON - RELOAD_GAP_MS })).toBe(true);
  });
});

describe("noteServed counts answers in a row naming the same other build", () => {
  const own = "GrossRacePage-old1.js";
  test("the same other build twice is two", () => {
    const once = noteServed(null, "GrossRacePage-new2.js", own);
    expect(once).toEqual({ name: "GrossRacePage-new2.js", count: 1 });
    expect(noteServed(once, "GrossRacePage-new2.js", own)).toEqual({ name: "GrossRacePage-new2.js", count: 2 });
  });

  test("our own build, nothing, or a different other build starts again", () => {
    const once = noteServed(null, "GrossRacePage-new2.js", own);
    expect(noteServed(once, own, own)).toEqual({ name: null, count: 0 });
    expect(noteServed(once, null, own)).toEqual({ name: null, count: 0 });
    expect(noteServed(once, "GrossRacePage-new3.js", own)).toEqual({ name: "GrossRacePage-new3.js", count: 1 });
  });
});

describe("the last reload is kept per tab", () => {
  test("is remembered", () => {
    const storage = memoryStorage();
    expect(lastReloadAt(storage)).toBe(0);
    markReload(storage, AFTERNOON);
    expect(lastReloadAt(storage)).toBe(AFTERNOON);
  });

  test("storage that throws, or none at all, is never an error", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(lastReloadAt(broken)).toBe(0);
    expect(() => markReload(broken, AFTERNOON)).not.toThrow();
    expect(lastReloadAt(null)).toBe(0);
    expect(() => markReload(null, AFTERNOON)).not.toThrow();
  });
});
