/**
 * Auto Reactions and Bot Group Access as Settings tabs.
 *
 * THE PROPERTY CODEX FOUND MISSING. These were first written as two panels
 * behind one "Bot Settings" tab with a single page key. `#group_access` then
 * resolved to that key and opened the OTHER screen — silently, and
 * indistinguishably from `#auto_reactions`. A link that resolves and lands
 * somewhere wrong is worse than one that does not resolve, because nothing
 * tells the person it happened.
 *
 * So: one key per screen, and `initialTab` really decides. Also pinned is that
 * opening one does not load the other — Bot Group Access lists every driver
 * group and probes what the bot can read, and nobody who came for an emoji rule
 * should pay for that.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "../SettingsPage";
import { LEGACY_PAGE_KEYS, PAGE_KEYS, resolvePageKey } from "../../navigation/pageKeys";
import { PAGE_COMPONENTS } from "../../App";
import * as api from "../../api";
import * as reactionsApi from "../../autoReactionsApi";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal();
  const stubbed = {};
  for (const name of Object.keys(actual)) {
    stubbed[name] = typeof actual[name] === "function"
      ? vi.fn().mockResolvedValue([])
      : actual[name];
  }
  return stubbed;
});

vi.mock("../../autoReactionsApi", () => ({
  getAutoReactions: vi.fn().mockResolvedValue([]),
  createAutoReaction: vi.fn(),
  updateAutoReaction: vi.fn(),
  deleteAutoReaction: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

test("the two screens have a page key each, and neither shares one", () => {
  expect(PAGE_KEYS).toContain("settings_reactions");
  expect(PAGE_KEYS).toContain("settings_access");
  expect(PAGE_KEYS).not.toContain("settings_bot");
});

test("each legacy hash lands on the screen it named, not on its neighbour", () => {
  expect(resolvePageKey("auto_reactions")).toBe("settings_reactions");
  expect(resolvePageKey("group_access")).toBe("settings_access");
  // The two must not collapse onto one destination — that collapse IS the bug.
  expect(LEGACY_PAGE_KEYS.auto_reactions).not.toBe(LEGACY_PAGE_KEYS.group_access);
});

test("Settings opened on `reactions` shows Auto Reactions and does NOT load Group Access", async () => {
  render(<SettingsPage initialTab="reactions" />);
  expect(await screen.findByText(/adds that reaction to every message/i)).toBeTruthy();
  expect(reactionsApi.getAutoReactions).toHaveBeenCalled();
  expect(api.getGroupAccess).not.toHaveBeenCalled();
});

test("Settings opened on `access` shows Group Access and does NOT load Auto Reactions", async () => {
  render(<SettingsPage initialTab="access" />);
  expect(await screen.findByText(/which driver groups the bot can actually read/i)).toBeTruthy();
  expect(api.getGroupAccess).toHaveBeenCalled();
  expect(reactionsApi.getAutoReactions).not.toHaveBeenCalled();
});

test("the page map opens each key on its own tab", () => {
  // Reading the element's props rather than rendering: what is asserted is the
  // wiring, and rendering App here would drag in the whole shell.
  expect(PAGE_COMPONENTS.settings_reactions.props.initialTab).toBe("reactions");
  expect(PAGE_COMPONENTS.settings_access.props.initialTab).toBe("access");
});

test("neither panel brings its own page header — Settings owns the one header", async () => {
  render(<SettingsPage initialTab="access" />);
  await screen.findByText(/which driver groups the bot can actually read/i);
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(1);
});
