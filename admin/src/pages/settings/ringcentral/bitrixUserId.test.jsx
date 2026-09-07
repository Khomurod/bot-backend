/**
 * cleanBitrixUserId — read an id out of whatever an operator pasted, and
 * REFUSE anything that is not a positive integer.
 *
 * The refusal is the point: before it, a pasted profile URL or a "#17" was
 * silently coerced to null by the server, and the save then succeeded while
 * clearing the mapping — the "it won't save" bug this replaces.
 */
import { expect, test } from "vitest";
import { cleanBitrixUserId } from "./bitrixUserId";

test("a plain positive integer passes through", () => {
  expect(cleanBitrixUserId("17")).toEqual({ value: "17", cleared: false, ok: true });
  expect(cleanBitrixUserId("  42 ")).toEqual({ value: "42", cleared: false, ok: true });
});

test("a pasted Bitrix profile URL yields just the id", () => {
  expect(cleanBitrixUserId("https://wenze.bitrix24.com/company/personal/user/17/").value).toBe("17");
  expect(cleanBitrixUserId("/company/personal/user/104/").value).toBe("104");
  expect(cleanBitrixUserId("/company/personal/user/17/").ok).toBe(true);
});

test("a leading # is tolerated", () => {
  expect(cleanBitrixUserId("#17")).toEqual({ value: "17", cleared: false, ok: true });
});

test("an empty field is cleared on purpose, not an error", () => {
  expect(cleanBitrixUserId("")).toEqual({ value: "", cleared: true, ok: true });
  expect(cleanBitrixUserId("   ")).toEqual({ value: "", cleared: true, ok: true });
  expect(cleanBitrixUserId(null)).toEqual({ value: "", cleared: true, ok: true });
});

test("anything not ultimately a positive integer is refused, text kept intact", () => {
  for (const bad of ["abc", "Tom Robinson", "0", "-3", "1.5", "17abc", "user 17"]) {
    const r = cleanBitrixUserId(bad);
    expect(r.ok, `${bad} should be refused`).toBe(false);
    expect(r.value).toBe(String(bad).trim());
  }
});
