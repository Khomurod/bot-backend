/**
 * Settings → Notifications.
 *
 * These two cards MOVED here from Telegram Groups, so what is worth pinning is
 * what a move breaks:
 *
 *   - both are actually on the tab (each has its own test for what it does;
 *     none of them notices if nothing renders it, which is how a card can get
 *     orphaned by a reorganisation);
 *   - the tab carries its own banner. Both cards report through a `flash`
 *     callback rather than rendering their own message, so a host that forgets
 *     to wire one swallows every "Saved." and every error — the save appears to
 *     do nothing at all.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NotificationsTab from "./NotificationsTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
  previewNotification: vi.fn(),
  sendNotificationTest: vi.fn(),
  getControlSettings: vi.fn(),
  updateControlSettings: vi.fn(),
  addControlOperator: vi.fn(),
  removeControlOperator: vi.fn(),
  forgetControlAnswer: vi.fn(),
}));

// The shapes each card's own test uses. Inventing a flatter one here would
// test a server that does not exist.
const ROUTING = {
  settings: { defaultChatId: "-100111", categoryChatIds: {}, repeatAfterHours: 168 },
  categories: [{
    key: "fuel", label: "Fuel risks", what: "A truck may be running low on fuel.",
    severity: "warning", humanActionUsually: true,
  }],
  queue: { delivered24h: 3, pending: 0, abandoned: 0 },
};

const CONTROL = {
  settings: { enabled: true, maxQuestionsPerPass: 5, repeatAfterHours: 72, clarifyLimit: 1 },
  operators: [{ telegramUserId: "2117922421", label: "Owner", enabled: true }],
  replies: { available: true, total: 4, refused: 1, last7d: 3 },
  knowledge: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getNotificationSettings.mockResolvedValue(ROUTING);
  api.getControlSettings.mockResolvedValue(CONTROL);
});

test("renders both cards — neither was left behind on the old tab", async () => {
  render(<NotificationsTab />);
  // Each card has its own test for what it DOES; none of them notices if
  // nothing renders it, which is how a card gets orphaned by a reorganisation.
  expect(await screen.findByText(/Fuel risks/i)).toBeTruthy();
  expect(await screen.findByText(/Answering Wenze in Telegram/i)).toBeTruthy();
});

test("says where the per-workflow group ids went, rather than just not having them", async () => {
  render(<NotificationsTab />);
  expect(screen.getByText(/Telegram Groups/i)).toBeTruthy();
});

test("a card's message has somewhere to appear", async () => {
  // The host owns the banner. Without one, every "Saved." and every error from
  // these two is swallowed and the save looks like it did nothing.
  api.updateControlSettings.mockResolvedValue({ ...CONTROL.settings, enabled: false });
  render(<NotificationsTab />);
  const toggle = await screen.findByRole("checkbox", { name: /Ask questions in Telegram/i });
  fireEvent.click(toggle);
  await waitFor(() => expect(api.updateControlSettings).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/Saved\./i)).toBeTruthy());
});
