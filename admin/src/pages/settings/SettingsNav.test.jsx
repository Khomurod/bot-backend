/**
 * Settings' own navigation: thirteen sections under six groups, every one of
 * them reachable, and the choice is the PAGE's (and so the address's) — the
 * navigation only reports it.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsNav from "./SettingsNav";
import { SETTINGS_GROUPS, SETTINGS_SECTION_KEYS, settingsSectionLabel } from "./sections";

describe("Settings sections", () => {
  test("six groups, thirteen sections, each key once, in this order", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      "Integrations", "AI", "Telegram Bot", "Recruiting", "Office Screens", "Maintenance",
    ]);
    expect(SETTINGS_SECTION_KEYS).toEqual([
      "location", "samsara", "board", "ringcentral", "metacrm",
      "ai",
      "notifications", "groups", "access", "reactions",
      "safety",
      "grossrace",
      "leftovers",
    ]);
    expect(new Set(SETTINGS_SECTION_KEYS).size).toBe(SETTINGS_SECTION_KEYS.length);
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
    await userEvent.click(within(nav).getByRole("button", { name: "AI & Autonomy" }));
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
