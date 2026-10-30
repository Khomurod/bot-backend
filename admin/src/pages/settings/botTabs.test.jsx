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
 * So: one key per screen — since October 2026 a Settings SECTION key, the
 * second half of `#settings/<key>` — and that key really decides. Also pinned is that
 * opening one does not load the other — Bot Group Access lists every driver
 * group and probes what the bot can read, and nobody who came for an emoji rule
 * should pay for that.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SettingsPage from "../SettingsPage";
import { LEGACY_PAGE_KEYS, resolveRoute } from "../../navigation/pageKeys";
import { SETTINGS_SECTION_KEYS } from "./sections";
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

test("the two screens have a section key each, and neither shares one", () => {
  expect(SETTINGS_SECTION_KEYS).toContain("reactions");
  expect(SETTINGS_SECTION_KEYS).toContain("access");
  expect(SETTINGS_SECTION_KEYS).not.toContain("bot");
});

test("each legacy hash lands on the screen it named, not on its neighbour", () => {
  expect(resolveRoute("auto_reactions")).toEqual({ page: "settings", tab: "reactions" });
  expect(resolveRoute("group_access")).toEqual({ page: "settings", tab: "access" });
  expect(resolveRoute("settings_reactions")).toEqual({ page: "settings", tab: "reactions" });
  expect(resolveRoute("settings_access")).toEqual({ page: "settings", tab: "access" });
  // The two must not collapse onto one destination — that collapse IS the bug.
  expect(LEGACY_PAGE_KEYS.auto_reactions).not.toBe(LEGACY_PAGE_KEYS.group_access);
});

test("Settings opened on `reactions` shows Auto Reactions and does NOT load Group Access", async () => {
  render(<SettingsPage tab="reactions" />);
  expect(await screen.findByText(/adds that reaction to every message/i)).toBeTruthy();
  expect(reactionsApi.getAutoReactions).toHaveBeenCalled();
  expect(api.getGroupAccess).not.toHaveBeenCalled();
});

test("Settings opened on `access` shows Group Access and does NOT load Auto Reactions", async () => {
  render(<SettingsPage tab="access" />);
  expect(await screen.findByText(/which driver groups the bot can actually read/i)).toBeTruthy();
  expect(api.getGroupAccess).toHaveBeenCalled();
  expect(reactionsApi.getAutoReactions).not.toHaveBeenCalled();
});

test("neither panel brings its own page header — Settings owns the one header", async () => {
  render(<SettingsPage tab="access" />);
  await screen.findByText(/which driver groups the bot can actually read/i);
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(1);
});
