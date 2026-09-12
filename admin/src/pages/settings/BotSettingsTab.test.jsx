/**
 * Settings → Bot Settings.
 *
 * Two screens that used to be top-level sidebar entries are panels here, so
 * what is pinned is what that move can break:
 *
 *   - each panel resolves and mounts from its new path;
 *   - ONLY the chosen one mounts, which is the whole reason for the switch —
 *     Bot Group Access lists every driver group and probes what the bot can
 *     read, and nobody who came for a reaction rule should pay for that;
 *   - a panel that throws does not take the switch down with it, or there is no
 *     way to reach the other without leaving Settings.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import BotSettingsTab from "./BotSettingsTab";
import * as api from "../../api";
import * as reactionsApi from "../../autoReactionsApi";

vi.mock("../../api", () => ({
  getBotUsers: vi.fn().mockResolvedValue([]),
  getGroupAccess: vi.fn().mockResolvedValue([]),
  getBotAccessSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../autoReactionsApi", () => ({
  getAutoReactions: vi.fn().mockResolvedValue([]),
  createAutoReaction: vi.fn(),
  updateAutoReaction: vi.fn(),
  deleteAutoReaction: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

// findBy*, not getBy* after a waitFor on the mock: the panel is lazy, so its
// fetch fires on mount one commit before its text is on screen. Asserting the
// text synchronously passed alone and lost the race in the full suite.
test("opens on Auto Reactions", async () => {
  render(<BotSettingsTab />);
  expect(await screen.findByText(/adds that reaction to every message/i)).toBeTruthy();
  expect(reactionsApi.getAutoReactions).toHaveBeenCalled();
});

test("Group Access mounts when chosen, and not before", async () => {
  render(<BotSettingsTab />);
  await screen.findByText(/adds that reaction to every message/i);
  // The expensive one has not run: it lists every driver group and probes the
  // bot's read access on each.
  expect(api.getGroupAccess).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /Group Access/i }));
  expect(await screen.findByText(/which driver groups the bot can actually read/i)).toBeTruthy();
  expect(api.getGroupAccess).toHaveBeenCalled();
});

test("switching away unmounts the panel that was showing", async () => {
  render(<BotSettingsTab />);
  await screen.findByText(/adds that reaction to every message/i);
  fireEvent.click(screen.getByRole("button", { name: /Group Access/i }));
  await screen.findByText(/which driver groups the bot can actually read/i);
  expect(screen.queryByText(/adds that reaction to every message/i)).toBeNull();
});

test("neither panel brings its own page header — Settings owns the one header", async () => {
  render(<BotSettingsTab />);
  await screen.findByText(/adds that reaction to every message/i);
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: /Group Access/i }));
  await screen.findByText(/which driver groups the bot can actually read/i);
  expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
});
