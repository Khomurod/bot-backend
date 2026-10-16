/**
 * Settings → Safety Approvals.
 *
 * The switch is the guard: it stays disabled until the group, the topic and
 * at least one Safety person are saved (the server refuses it too). And the
 * Safety picker saves exactly the people ticked. Names are made up.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SafetyApprovalsTab from "./SafetyApprovalsTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getSafetyApprovals: vi.fn(),
  validateSafetyApprovalChat: vi.fn(),
  updateSafetyApprovals: vi.fn(),
  sendSafetyApprovalTestPost: vi.fn(),
}));

const switchBox = () => screen.getByLabelText(/Post Safety's decisions/i);
const SETTINGS = {
  enabled: false, chatId: "-100777", chatTitle: "Recruiting", chatValidatedAt: "2026-10-16T10:00:00Z",
  topicId: 45, safetyUserIds: [],
};
const MEMBERS = [
  { id: "900", name: "Avery Davis", username: "adavis" },
  { id: "500", name: "Kim Rowe", username: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getSafetyApprovals.mockResolvedValue({ settings: SETTINGS, members: MEMBERS, recent: [] });
  api.updateSafetyApprovals.mockResolvedValue({});
});

test("the switch stays off until a Safety person is saved", async () => {
  render(<SafetyApprovalsTab />);
  expect(await screen.findByLabelText(/Post Safety's decisions/i)).toBeDisabled();
  expect(screen.getByText(/at least one Safety person first/i)).toBeTruthy();
});

test("ticking a person and saving sends exactly that person", async () => {
  render(<SafetyApprovalsTab />);
  fireEvent.click(await screen.findByLabelText(/Avery Davis/));
  fireEvent.click(screen.getByRole("button", { name: /Save Safety people/i }));
  await waitFor(() => expect(api.updateSafetyApprovals).toHaveBeenCalledWith({ safetyUserIds: ["900"] }));
});

test("with everything saved, the switch turns it on", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { ...SETTINGS, safetyUserIds: ["900"] }, members: MEMBERS, recent: [],
  });
  render(<SafetyApprovalsTab />);
  await waitFor(() => expect(switchBox()).not.toBeDisabled());
  fireEvent.click(switchBox());
  await waitFor(() => expect(api.updateSafetyApprovals).toHaveBeenCalledWith({ enabled: true }));
});

test("a group the bot cannot read says so", async () => {
  api.validateSafetyApprovalChat.mockResolvedValue({
    ok: true, seesEverything: false, message: "The bot can reach this group but cannot see its messages.",
  });
  render(<SafetyApprovalsTab />);
  fireEvent.click(await screen.findByRole("button", { name: /Validate group/i }));
  await waitFor(() => expect(screen.getByText(/cannot see its messages/)).toBeTruthy());
});

test("the topic link is saved as typed; the server reads it", async () => {
  render(<SafetyApprovalsTab />);
  fireEvent.change(await screen.findByLabelText(/Topic link or number/i), {
    target: { value: "https://t.me/c/777/45" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save topic/i }));
  await waitFor(() => expect(api.updateSafetyApprovals).toHaveBeenCalledWith({ topic: "https://t.me/c/777/45" }));
});
