/**
 * Every `api.<name>` a screen calls must exist on the façade.
 *
 * `lint:imports` checks named imports, but a screen that does
 * `import * as api from "../api"` and then calls `api.somethingGone()` passes
 * it, passes the build, and fails only at runtime — as a TypeError the screen
 * usually catches and shows as an error. That is exactly how the Driver
 * Groups popup's "Driver Username" picker stayed broken: it called
 * `api.getGroupMembers`, which no API module exported, and every open of the
 * popup showed an error instead of the group's members.
 */
import { expect, test, vi } from "vitest";
import * as api from "./api";
import { getGroupMembers } from "./api/groups";

const sources = import.meta.glob(["./**/*.{js,jsx}", "!./**/*.test.{js,jsx}"], {
  query: "?raw", import: "default", eager: true,
});

test("every api.<name> a screen uses is exported by the façade", () => {
  const missing = [];
  let checkedFiles = 0;
  for (const [file, source] of Object.entries(sources)) {
    if (!/import \* as api from ["'][./]+api["']/.test(source)) continue;
    checkedFiles += 1;
    // Not preceded by a dot, slash or word character: `https://api.groq.com`
    // in a help text is a host name, not a call.
    for (const [, name] of source.matchAll(/(?<![\w./-])api\.([A-Za-z_$][\w$]*)/g)) {
      if (!(name in api)) missing.push(`${file}: api.${name}`);
    }
  }
  // The scan must actually find the screens, or it proves nothing.
  expect(checkedFiles).toBeGreaterThan(30);
  expect([...new Set(missing)]).toEqual([]);
});

test("getGroupMembers reads the members list the server returns", async () => {
  const members = [{ telegram_user_id: "42", username: "driver_one", display_name: "Driver One" }];
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ members }) });
  vi.stubGlobal("fetch", fetchMock);
  try {
    expect(await getGroupMembers(7)).toEqual(members);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/groups\/7\/members$/);
  } finally {
    vi.unstubAllGlobals();
  }
});
