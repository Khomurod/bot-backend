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
  sendBitrixTopicTestPost: vi.fn(),
  // 6. CDL → Bitrix fields (its own card: CdlFieldMapCard.test.jsx).
  getHiringCdl: vi.fn(),
  readHiringCdlBitrixFields: vi.fn(),
  saveHiringCdlMapping: vi.fn(),
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
  api.getHiringCdl.mockResolvedValue({ items: [{ key: "license_number", label: "Licence number" }], mapping: [], recent: [] });
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
  fireEvent.change(await screen.findByLabelText(/^Topic link or number/i), {
    target: { value: "https://t.me/c/777/45" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save topic/i }));
  await waitFor(() => expect(api.updateSafetyApprovals).toHaveBeenCalledWith({ topic: "https://t.me/c/777/45" }));
});

test("Bitrix stage proposals stay off until Safety Approvals is on", async () => {
  render(<SafetyApprovalsTab />);
  expect(await screen.findByLabelText(/Propose Bitrix stage changes/i)).toBeDisabled();
});

test("with Safety Approvals on but no Bitrix topic, the stage switch waits for the topic", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { ...SETTINGS, safetyUserIds: ["900"], enabled: true }, members: MEMBERS, recent: [],
  });
  render(<SafetyApprovalsTab />);
  expect(await screen.findByLabelText(/Propose Bitrix stage changes/i)).toBeDisabled();
  expect(screen.getByText(/Save the Bitrix topic first/i)).toBeTruthy();
});

test("the Bitrix topic is saved as typed and proven with a test message in it", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { ...SETTINGS, safetyUserIds: ["900"], enabled: true, bitrixTopicId: 77 }, members: MEMBERS, recent: [],
  });
  api.sendBitrixTopicTestPost.mockResolvedValue({ ok: true });
  render(<SafetyApprovalsTab />);
  fireEvent.change(await screen.findByLabelText(/Bitrix topic link or number/i), {
    target: { value: "https://t.me/c/777/78" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save Bitrix topic/i }));
  await waitFor(() => expect(api.updateSafetyApprovals).toHaveBeenCalledWith({ bitrixTopic: "https://t.me/c/777/78" }));
  fireEvent.click(screen.getByRole("button", { name: /test message to the Bitrix topic/i }));
  await waitFor(() => expect(api.sendBitrixTopicTestPost).toHaveBeenCalled());
  expect(api.sendSafetyApprovalTestPost).not.toHaveBeenCalled();
});

test("the bot's own Bitrix creations are listed under the switch", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { ...SETTINGS, safetyUserIds: ["900"], enabled: true, bitrixTopicId: 77, stageProposalsEnabled: true },
    members: MEMBERS,
    recent: [],
    crmRecords: [{ id: 3, status: "created", driverName: "Kwame Asante", dealId: 812, contactReused: true, dealReused: false, updatedAt: "2026-11-10T10:00:00Z" }],
  });
  render(<SafetyApprovalsTab />);
  expect(await screen.findByText(/Created — deal #812 \(existing contact\)/)).toBeTruthy();
});

test("with Safety Approvals on, the stage proposals have a switch of their own and a history", async () => {
  api.getSafetyApprovals.mockResolvedValue({
    settings: { ...SETTINGS, safetyUserIds: ["900"], enabled: true, bitrixTopicId: 77 },
    members: MEMBERS,
    recent: [],
    proposals: [{
      id: 1, kind: "move", status: "applied", driverName: "Samuel Phillips",
      fromStageName: "CLEARINGHOUSE CHECK", toStageName: "MVR + PSP CHECK", decidedByName: "Ann",
      createdAt: "2026-10-20T10:00:00Z",
    }],
  });
  render(<SafetyApprovalsTab />);
  expect(await screen.findByText("CLEARINGHOUSE CHECK → MVR + PSP CHECK")).toBeTruthy();
  expect(screen.getByText(/Moved — Ann/)).toBeTruthy();
  const box = screen.getByLabelText(/Propose Bitrix stage changes/i);
  expect(box).not.toBeDisabled();
  fireEvent.click(box);
  await waitFor(() => expect(api.updateSafetyApprovals).toHaveBeenCalledWith({ stageProposalsEnabled: true }));
});
