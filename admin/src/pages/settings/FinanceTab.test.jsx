/**
 * Settings → Finance Monitor.
 *
 * The one rule this screen exists to enforce is that capture cannot be switched
 * on against a group nobody validated. Enabling it starts storing payment
 * messages, so a disabled checkbox is not cosmetic here — it is the guard, and
 * the server enforces the same rule underneath (tests/financeSettingsRoute).
 *
 * The second thing worth pinning is what the screen may SHOW. Counts answer
 * "is this capturing, and does it look right" without putting a money code or a
 * driver's name on a settings page, and `ambiguous` / `unparsed` are shown as
 * their own numbers because they are how a person learns what the provisional
 * parser cannot read yet.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FinanceTab from "./FinanceTab";
import * as api from "../../api";

// BY LABEL, NOT BY ROLE. The page has three checkboxes now (capture, keep
// attachments, let AI read them) and `getByRole("checkbox")` would find
// whichever came first — which is how a test quietly starts asserting about a
// different switch than the one it names.
const captureBox = () => screen.getByLabelText(/Record the money codes/i);

vi.mock("../../api", () => ({
  getFinanceStatus: vi.fn(),
  validateFinanceChat: vi.fn(),
  updateFinanceSettings: vi.fn(),
}));

const OFF = {
  settings: {
    enabled: false, chatId: null, chatTitle: null, chatValidatedAt: null,
    duplicateWindowHours: 72,
  },
  capture: { available: true, byStatus: {}, total: 0, codes: 0, duplicates: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getFinanceStatus.mockResolvedValue(OFF);
});

test("capture cannot be switched on until a group has been validated", async () => {
  render(<FinanceTab />);
  const box = await screen.findByLabelText(/Record the money codes/i);
  expect(box).toBeDisabled();
  expect(screen.getByText(/Validate the group first/i)).toBeTruthy();
  expect(api.updateFinanceSettings).not.toHaveBeenCalled();
});

test("validating the chat in the form unlocks it, without a reload", async () => {
  api.validateFinanceChat.mockResolvedValue({ ok: true, chatId: "-100777", chatTitle: "Wenze Finance" });
  render(<FinanceTab />);

  fireEvent.change(await screen.findByLabelText(/Telegram chat ID/i), { target: { value: "-100777" } });
  fireEvent.click(screen.getByRole("button", { name: /Validate group/i }));

  // It proves the chat IN THE FORM, not the one already stored — that is what
  // lets a group be verified before it is committed to.
  await waitFor(() => expect(api.validateFinanceChat).toHaveBeenCalledWith("-100777"));
  await waitFor(() => expect(captureBox()).not.toBeDisabled());
  expect(screen.getByText(/Wenze Finance/)).toBeTruthy();
});

test("a chat that cannot be validated leaves the switch locked and says why", async () => {
  api.validateFinanceChat.mockResolvedValue({
    ok: false, status: "sign_flipped", message: 'Did you mean -100777?',
  });
  render(<FinanceTab />);

  fireEvent.change(await screen.findByLabelText(/Telegram chat ID/i), { target: { value: "100777" } });
  fireEvent.click(screen.getByRole("button", { name: /Validate group/i }));

  await waitFor(() => expect(screen.getByText(/Did you mean -100777\?/)).toBeTruthy());
  expect(captureBox()).toBeDisabled();
});

test("editing the chat id withdraws an earlier validation", async () => {
  api.validateFinanceChat.mockResolvedValue({ ok: true, chatId: "-100777", chatTitle: "Wenze Finance" });
  render(<FinanceTab />);

  fireEvent.change(await screen.findByLabelText(/Telegram chat ID/i), { target: { value: "-100777" } });
  fireEvent.click(screen.getByRole("button", { name: /Validate group/i }));
  await waitFor(() => expect(captureBox()).not.toBeDisabled());

  // Typing a DIFFERENT chat after validating one must not carry the approval
  // over to it — that is how the wrong group gets captured.
  fireEvent.change(screen.getByLabelText(/Telegram chat ID/i), { target: { value: "-100888" } });
  expect(captureBox()).toBeDisabled();
});

test("a stored validation is enough on its own", async () => {
  api.getFinanceStatus.mockResolvedValue({
    ...OFF,
    settings: { ...OFF.settings, chatId: "-100777", chatValidatedAt: "2026-09-01T00:00:00Z" },
  });
  render(<FinanceTab />);
  await waitFor(() => expect(captureBox()).not.toBeDisabled());
  expect(screen.getByText(/Validated /)).toBeTruthy();
});

test("the weekly summary cannot be switched on before capture is", async () => {
  render(<FinanceTab />);
  const weekly = await screen.findByLabelText(/Send the weekly summary/i);
  expect(weekly).toBeDisabled();
  expect(api.updateFinanceSettings).not.toHaveBeenCalled();
});

test("the report history says WHY a week was not sent, in words", async () => {
  api.getFinanceStatus.mockResolvedValue({
    settings: {
      ...OFF.settings, enabled: true, chatId: "-100777",
      chatValidatedAt: "2026-09-01T00:00:00Z", weeklyReportEnabled: true,
    },
    capture: { available: true, byStatus: {}, total: 0, codes: 0, duplicates: 0 },
    reports: [
      { id: 2, periodStart: "2026-09-07T13:00:00Z", status: "sent", totals: { codeCount: 5 } },
      { id: 1, periodStart: "2026-08-31T13:00:00Z", status: "suppressed_backfill", totals: null },
    ],
  });
  render(<FinanceTab />);

  // "Not sent" and "nothing happened that week" are opposite answers, and this
  // screen is the only place a person can tell them apart.
  expect(await screen.findByText(/we were not watching that week/i)).toBeTruthy();
  expect(screen.getByText("Sent")).toBeTruthy();
});

test("the counts are shown separately, and nothing that was said is shown at all", async () => {
  api.getFinanceStatus.mockResolvedValue({
    settings: { ...OFF.settings, enabled: true, chatId: "-100777", chatValidatedAt: "2026-09-01T00:00:00Z" },
    capture: {
      available: true,
      byStatus: { parsed: 4, ambiguous: 2, unparsed: 3, not_moneycode: 11 },
      total: 20, codes: 4, duplicates: 1,
    },
  });
  const { container } = render(<FinanceTab />);
  await screen.findByText("20");

  // Unclear and unreadable are their own numbers, not one "failed" total: they
  // are the input for tightening a parser that has never seen a real message.
  for (const [label, value] of [["Read cleanly", "4"], ["Unclear", "2"], ["Could not read", "3"],
    ["Money codes", "4"], ["Flagged as repeats", "1"]]) {
    const stat = screen.getByText(label).closest(".stat-card");
    expect(stat.textContent).toContain(value);
  }
  expect(container.textContent).not.toMatch(/\d{6,}/);
});
