/**
 * Settings → Notifications.
 *
 * The routing card moved here from Telegram Groups; the control-channel card
 * ("Answering Wenze in Telegram") moved on again in November 2026, to Settings
 * → AI → Wenze's Questions (WenzeQuestionsTab.test.jsx). What is worth pinning
 * is what a move breaks:
 *
 *   - the routing card is actually on the tab (its own test covers what it
 *     does; none notices if nothing renders it, which is how a card can get
 *     orphaned by a reorganisation);
 *   - the tab says where the moved card went, rather than just not having it;
 *   - the tab carries its own banner. The card reports through a `flash`
 *     callback rather than rendering its own message, so a host that forgets
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
  getMessageGroupSettings: vi.fn(),
  updateMessageGroupSettings: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  api.getNotificationSettings.mockResolvedValue(ROUTING);
  api.getMessageGroupSettings.mockResolvedValue({
    mileageBonus: { groupId: "-100500", fromEnv: false, configured: true },
    roadBonus: { groupId: "", fromEnv: false, configured: false },
  });
});

test("renders the routing card, and not the control channel that moved on", async () => {
  render(<NotificationsTab />);
  expect(await screen.findByText(/Fuel risks/i)).toBeTruthy();
  expect(screen.queryByText(/Answering Wenze in Telegram/i)).toBeNull();
  expect(api.getControlSettings).not.toHaveBeenCalled();
});

test("holds the bonus groups too, and says where the control channel went", async () => {
  // "Where the Bot Posts" since November 2026: Notifications and Bonus Groups
  // were two sections answering the same question.
  render(<NotificationsTab />);
  expect(await screen.findByLabelText(/Mileage Bonus Telegram Group ID/)).toHaveValue("-100500");
  expect(screen.getByRole("button", { name: "Save bonus groups" })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Wenze's Questions/i })).toHaveAttribute("href", "#settings/ai_questions");
});

test("the per-kind overrides are collapsed while none is set", async () => {
  render(<NotificationsTab />);
  const summary = await screen.findByText(/Send some kinds of notice to a different group/);
  expect(summary.closest("details").open).toBe(false);
  expect(summary.textContent).toMatch(/1 kinds, all to the default group/);
});

test("a card's message has somewhere to appear", async () => {
  // The host owns the banner. Without one, every "Saved." and every error from
  // the card is swallowed and the save looks like it did nothing.
  api.updateNotificationSettings.mockResolvedValue({ ...ROUTING.settings, defaultChatId: "-100222" });
  render(<NotificationsTab />);
  // The routing card's default group: the first such field (the bonus groups,
  // below it, use the same placeholder).
  const [field] = await screen.findAllByPlaceholderText("e.g. -1001234567890");
  fireEvent.change(field, { target: { value: "-100222" } });
  fireEvent.blur(field);
  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenCalledWith({ defaultChatId: "-100222" }));
  await waitFor(() => expect(screen.getByText(/Saved\./i)).toBeTruthy());
});
