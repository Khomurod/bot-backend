/**
 * Settings screens that put what needs a person first (November 2026,
 * docs/redesign/density.md A5). Each one hides nothing for good — what is
 * folded opens from a control on the same screen:
 *
 *   - Group Access: groups the bot cannot read first; the readable ones are one
 *     line; the saved super admin is one line with Change.
 *   - Auto Reactions: the rules first; the add form opens from a button.
 *   - Safety Approvals: once on and complete, the setup is one line with
 *     "Edit setup", and the switch stays in view.
 *   - Retired Leftovers: features with nothing left are one "Already clean"
 *     line.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../api";
import GroupAccessPanel from "./bot/GroupAccessPanel";
import AutoReactionsPanel from "./bot/AutoReactionsPanel";
import SafetyApprovalsTab from "./SafetyApprovalsTab";
import RetiredLeftoversTab from "./RetiredLeftoversTab";

vi.mock("../../api", () => ({
  getGroupAccess: vi.fn(),
  getBotAccessSettings: vi.fn(),
  updateBotAccessSettings: vi.fn(),
  requestGroupAdmin: vi.fn(),
  recheckGroupAccess: vi.fn(),
  getBotUsers: vi.fn(),
  getAutoReactions: vi.fn(),
  createAutoReaction: vi.fn(),
  updateAutoReaction: vi.fn(),
  deleteAutoReaction: vi.fn(),
  getSafetyApprovals: vi.fn(),
  validateSafetyApprovalChat: vi.fn(),
  updateSafetyApprovals: vi.fn(),
  sendSafetyApprovalTestPost: vi.fn(),
  getRetiredLeftovers: vi.fn(),
  purgeRetiredConfig: vi.fn(),
  dropRetiredTables: vi.fn(),
}));

const group = (id, name, level) => ({
  group_id: id, driver_name: name, group_type: "driver", unit_number: String(id),
  bot_member_status: level === "ok" ? "administrator" : "member", reading_level: level, reading_label: level,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getGroupAccess.mockResolvedValue({
    groups: [group(1, "Alex Turner", "ok"), group(2, "Bekzod Rahimov", "ok"), group(3, "Carlos Mendez", "warn")],
    summary: {}, lastChecked: null,
  });
  api.getBotAccessSettings.mockResolvedValue({ settings: { super_admin_telegram_id: "2117", super_admin_label: "Owner" } });
  api.getAutoReactions.mockResolvedValue({ rules: [{ id: 1, username: "dispatch_tom", emoji: "👍", enabled: true }], allowed_emojis: ["👍", "🔥"] });
  api.getBotUsers.mockResolvedValue({ users: [] });
});

test("Group Access lists the problem first and folds the readable groups into one line", async () => {
  render(<GroupAccessPanel />);
  expect(await screen.findByText("Carlos Mendez")).toBeTruthy();
  expect(screen.queryByText("Alex Turner")).toBeNull();
  const more = screen.getByRole("button", { name: /2 groups reading normally — show them/ });
  fireEvent.click(more);
  expect(screen.getByText("Alex Turner")).toBeTruthy();
  // The counts and the export still cover every group in the filter.
  expect(screen.getByText(/reading$/).closest("div").textContent).toMatch(/2 reading/);
  expect(screen.getByRole("button", { name: /Download no-access list \(1\)/ })).toBeTruthy();
});

test("Group Access: a saved super admin is one line, and Change opens the form", async () => {
  render(<GroupAccessPanel />);
  expect(await screen.findByText(/Owner \(2117\)/)).toBeTruthy();
  expect(screen.queryByPlaceholderText("e.g. 123456789")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  expect(screen.getByPlaceholderText("e.g. 123456789")).toHaveValue("2117");
});

test("Group Access: with no super admin saved, the form is open", async () => {
  api.getBotAccessSettings.mockResolvedValueOnce({ settings: null });
  render(<GroupAccessPanel />);
  expect(await screen.findByPlaceholderText("e.g. 123456789")).toBeTruthy();
});

test("Auto Reactions shows the rules first; the form opens from Add a rule", async () => {
  render(<AutoReactionsPanel />);
  expect(await screen.findByText("Active rules")).toBeTruthy();
  expect(screen.queryByText("Add a reaction rule")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
  expect(screen.getByText("Add a reaction rule")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add reaction rule" })).toBeTruthy();
});

test("Safety Approvals, on and complete: one setup line, the switch in view, Edit opens the steps", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { enabled: true, chatId: "-100777", chatTitle: "Recruiting", chatValidatedAt: "2026-10-16T10:00:00Z", topicId: 45, safetyUserIds: ["900"] },
    members: [{ id: "900", name: "Avery Davis" }], recent: [],
  });
  render(<SafetyApprovalsTab />);
  expect(await screen.findByText(/are posted in topic #45/)).toBeTruthy();
  expect(screen.getByLabelText(/Post Safety's decisions/)).toBeChecked();
  expect(screen.queryByText("1. The recruiting group")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit setup" }));
  expect(screen.getByText("1. The recruiting group")).toBeTruthy();
});

test("Safety Approvals not yet on: the steps are open, as before", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { enabled: false, chatId: "", safetyUserIds: [] }, members: [], recent: [],
  });
  render(<SafetyApprovalsTab />);
  expect(await screen.findByText("1. The recruiting group")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit setup" })).toBeNull();
});

test("Retired Leftovers: only what has something left is a card; the clean ones are one line", async () => {
  api.getRetiredLeftovers.mockResolvedValue({
    groups: [
      { key: "route", label: "Route Control", removed_at: "2026-10", note: "Routes.", tables_present: 1, total_rows: 0, tables: [{ table: "routes", present: true, rows: 0 }] },
      { key: "fuel", label: "Fuel", removed_at: "2026-10", note: "Fuel.", tables_present: 0, total_rows: 0, tables: [] },
      { key: "qbq", label: "QBQ", removed_at: "2026-09", note: "QBQ.", tables_present: 0, total_rows: 0, tables: [] },
    ],
    rbac: { roles: [], permissions: [], accounts: [] },
  });
  render(<RetiredLeftoversTab />);
  expect(await screen.findByText("Route Control")).toBeTruthy();
  const clean = screen.getByText(/Already clean \(2\)/).closest("details");
  expect(clean.open).toBe(false);
  expect(clean.textContent).toMatch(/Fuel/);
  expect(clean.textContent).toMatch(/QBQ/);
});
