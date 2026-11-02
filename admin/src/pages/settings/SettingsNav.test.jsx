/**
 * Settings' own navigation: nineteen sections under five groups, every one of
 * them reachable, and the choice is the PAGE's (and so the address's) — the
 * navigation only reports it.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsNav, { itemIsVisible } from "./SettingsNav";
import { SETTINGS_GROUPS, SETTINGS_SECTION_KEYS, settingsSectionLabel } from "./sections";

describe("Settings sections", () => {
  test("five groups, nineteen sections, each key once, in this order", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Fleet", "Recruiting", "AI", "Telegram", "System"]);
    expect(SETTINGS_SECTION_KEYS).toEqual([
      "location", "samsara", "samsara_video", "board",
      "ringcentral", "rc_connection", "bitrix", "metacrm", "safety",
      "ai", "ai_tasks", "ai_questions", "ai_terms",
      "notifications", "access", "reactions",
      "admins", "grossrace", "leftovers",
    ]);
    expect(new Set(SETTINGS_SECTION_KEYS).size).toBe(SETTINGS_SECTION_KEYS.length);
  });

  test("no group is a heading over a single entry (November 2026)", () => {
    for (const group of SETTINGS_GROUPS) expect(group.sections.length).toBeGreaterThanOrEqual(3);
  });

  test("maintenance is last, so it is never where a person lands first", () => {
    expect(SETTINGS_SECTION_KEYS[0]).toBe("location");
    expect(SETTINGS_SECTION_KEYS.at(-1)).toBe("leftovers");
  });

  test("every section has a label", () => {
    for (const key of SETTINGS_SECTION_KEYS) expect(settingsSectionLabel(key)).toBeTruthy();
    expect(settingsSectionLabel("nope")).toBeNull();
  });
});

describe("SettingsNav", () => {
  test("lists every section under its group, marks the open one, reports a click", async () => {
    const onChange = vi.fn();
    render(<SettingsNav value="board" onChange={onChange} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    for (const group of SETTINGS_GROUPS) {
      expect(within(nav).getByText(group.label)).toBeTruthy();
      for (const section of group.sections) {
        expect(within(nav).getByRole("button", { name: section.label })).toBeTruthy();
      }
    }
    expect(within(nav).getByRole("button", { name: "Dispatcher Board" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(nav).getByRole("button", { name: "AI Providers" }));
    expect(onChange).toHaveBeenCalledWith("ai");
  });

  test("the phone picker offers the same sections and reports a choice", async () => {
    const onChange = vi.fn();
    render(<SettingsNav value="board" onChange={onChange} />);
    const picker = screen.getByRole("combobox", { name: "Section" });
    expect(picker).toHaveValue("board");
    expect(within(picker).getAllByRole("option").map((o) => o.value)).toEqual([...SETTINGS_SECTION_KEYS]);
    await userEvent.selectOptions(picker, "leftovers");
    expect(onChange).toHaveBeenCalledWith("leftovers");
  });
});

describe("the active section stays in view in a list that scrolls by itself", () => {
  const box = { top: 140, bottom: 876 };
  test("an item inside the list and the window is left alone", () => {
    expect(itemIsVisible({ top: 300, bottom: 330 }, box, 768)).toBe(true);
  });

  test("an item inside the list but below the window is not visible (the nav is not stuck yet)", () => {
    expect(itemIsVisible({ top: 800, bottom: 830 }, box, 768)).toBe(false);
  });

  test("a quarter-pixel past the edge is still visible", () => {
    expect(itemIsVisible({ top: 735.1, bottom: 768.1 }, { top: 31.9, bottom: 767.9 }, 768)).toBe(true);
  });

  test("an item scrolled out of the list is not visible", () => {
    expect(itemIsVisible({ top: 100, bottom: 130 }, box, 768)).toBe(false);
  });

  test("opened by its address out of sight, the active item is scrolled into view; in view, it is not", () => {
    const scroll = vi.fn();
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const proto = Element.prototype;
    const had = "scrollIntoView" in proto;
    proto.scrollIntoView = scroll;
    try {
      rect.mockImplementation(function measure() {
        return this.getAttribute?.("aria-current") === "page" ? { top: 900, bottom: 930 } : { top: 0, bottom: 760 };
      });
      const { rerender } = render(<SettingsNav value="leftovers" onChange={() => {}} />);
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });

      scroll.mockClear();
      rect.mockImplementation(() => ({ top: 10, bottom: 40 }));
      rerender(<SettingsNav value="location" onChange={() => {}} />);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
      if (!had) delete proto.scrollIntoView;
    }
  });
});
