/**
 * The Communications area's shared formatters.
 *
 * These replaced three near-copies that had drifted, so what is pinned here is
 * where they USED to disagree: whether the truncation marker counts toward the
 * limit, whether an empty body renders as nothing or as a placeholder, and
 * whether a multi-line message is allowed to break a table row.
 */
import { expect, test } from "vitest";
import { absoluteTime, preview, relativeTime, truncate } from "./format";

test("truncate counts the marker toward the limit", () => {
  // The pre-move broadcast copy returned 63 characters for truncate(s, 60),
  // overrunning the column it was sized for.
  expect(truncate("x".repeat(100), 60)).toHaveLength(60);
  expect(truncate("x".repeat(100), 60).endsWith("...")).toBe(true);
});

test("truncate leaves a value that already fits completely alone", () => {
  expect(truncate("short", 60)).toBe("short");
  expect(truncate("x".repeat(60), 60)).toBe("x".repeat(60));
});

test("truncate handles null and undefined without throwing", () => {
  expect(truncate(null, 10)).toBe("");
  expect(truncate(undefined, 10)).toBe("");
});

test("preview collapses whitespace so a multi-line message stays on one row", () => {
  expect(preview("line one\n\n  line two\ttab")).toBe("line one line two tab");
});

test("preview names an empty body instead of rendering a blank cell", () => {
  // A media-only broadcast has no text, and a blank cell reads as a bug.
  expect(preview("")).toBe("(media message without text)");
  expect(preview("   \n  ")).toBe("(media message without text)");
  expect(preview(null)).toBe("(media message without text)");
  expect(preview("", 80, "(no text)")).toBe("(no text)");
});

test("preview obeys the same marker-inclusive limit as truncate", () => {
  expect(preview("y".repeat(400))).toHaveLength(160);
  expect(preview("y".repeat(400), 80, "(no text)")).toHaveLength(80);
});

test("absoluteTime refuses a missing or unparseable value rather than showing Invalid Date", () => {
  expect(absoluteTime(null)).toBe("—");
  expect(absoluteTime("")).toBe("—");
  expect(absoluteTime("not a date")).toBe("—");
});

test("absoluteTime renders a real clock time, not a relative one", () => {
  const out = absoluteTime("2026-09-12T20:15:00Z");
  expect(out).toMatch(/2026/);
  expect(out).not.toMatch(/ago/);
});

test("relativeTime is the relative form, and the two are not the same function", () => {
  const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  expect(relativeTime(iso)).not.toBe(absoluteTime(iso));
});
