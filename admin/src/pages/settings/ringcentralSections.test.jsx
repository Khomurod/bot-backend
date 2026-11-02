/**
 * "RingCentral & Bitrix24" became three Settings sections and a Recruiter KPIs
 * tab in November 2026. What the split must not break, pinned here:
 *
 *   - a read that fails is said, with a retry, and NO form is drawn — a form
 *     drawn from defaults could save them over the stored values (this was
 *     the old screen's own test, carried to each part);
 *   - the connection and the targets edit ONE settings row from two places,
 *     so each Save sends only its own fields — never a stale copy of the
 *     other's;
 *   - the recruiters come first, the add forms open from buttons;
 *   - the Bitrix readout that repeated the form is gone.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../../api/apiError";
import * as api from "../../api";
import RcConnectionTab from "./RcConnectionTab";
import RecruitersTab from "./RecruitersTab";
import BitrixTab from "./BitrixTab";
import RecruiterTargetsTab from "../recruiting/RecruiterTargetsTab";

vi.mock("../../api", () => ({
  getRingCentralSettings: vi.fn(),
  updateRingCentralSettings: vi.fn(),
  testRingCentral: vi.fn(),
  getRecruiters: vi.fn(),
  getBitrixUsers: vi.fn(),
  createRecruiterConnectLink: vi.fn(),
  createRecruiter: vi.fn(),
  getBitrixSettings: vi.fn(),
  diagnoseBitrix: vi.fn(),
  automapRecruiterBitrixUsers: vi.fn(),
}));

const SETTINGS = {
  enabled: true, apiBase: "https://platform.ringcentral.com", pollMinutes: 10, timezone: "America/Chicago",
  nonValuableMaxSeconds: 30, realConversationMinSeconds: 60, strongConversationMinSeconds: 180,
  targetTalkMinutes: 150, targetOutbound: 150, targetRealConversations: 35,
  clientIdSet: true, clientIdMasked: "••••abcd", clientSecretSet: false, jwtTokenSet: false, fromEnv: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getRingCentralSettings.mockResolvedValue(SETTINGS);
  api.updateRingCentralSettings.mockImplementation(async (p) => ({ ...SETTINGS, ...p }));
  api.getRecruiters.mockResolvedValue([]);
  api.getBitrixSettings.mockResolvedValue({
    configured: true, assigneeWaitMs: 25000, webhookHost: "x.bitrix24.com", entity: "lead", sourceId: "WEB",
  });
});

test("Connection: a failed read is said with a retry, and no form is drawn", async () => {
  api.getRingCentralSettings.mockRejectedValueOnce(new ApiError("Database unavailable", { status: 503, code: "DB_UNAVAILABLE" }));
  render(<RcConnectionTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByLabelText("Shared Client ID")).not.toBeInTheDocument();
  expect(api.updateRingCentralSettings).not.toHaveBeenCalled();
});

test("Connection: an answer with no settings in it is a failure too", async () => {
  api.getRingCentralSettings.mockResolvedValueOnce(undefined);
  render(<RcConnectionTab />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/did not send the RingCentral settings/);
});

test("Connection: Save sends the connection's fields and none of the targets", async () => {
  render(<RcConnectionTab />);
  fireEvent.change(await screen.findByLabelText("Shared Client ID"), { target: { value: "new-id" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.updateRingCentralSettings).toHaveBeenCalledTimes(1));
  const payload = api.updateRingCentralSettings.mock.calls[0][0];
  expect(payload).toEqual({ enabled: true, apiBase: "https://platform.ringcentral.com", pollMinutes: 10, clientId: "new-id" });
  expect(await screen.findByText("RingCentral connection saved.")).toBeTruthy();
});

test("Targets: Save sends the targets and thresholds and none of the connection", async () => {
  const onSaved = vi.fn();
  render(<RecruiterTargetsTab onSaved={onSaved} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save targets" }));
  await waitFor(() => expect(api.updateRingCentralSettings).toHaveBeenCalledTimes(1));
  expect(api.updateRingCentralSettings.mock.calls[0][0]).toEqual({
    timezone: "America/Chicago",
    targetTalkMinutes: 150, targetOutbound: 150, targetRealConversations: 35,
    nonValuableMaxSeconds: 30, realConversationMinSeconds: 60, strongConversationMinSeconds: 180,
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

test("Targets: a failed read is said with a retry, and no form is drawn", async () => {
  api.getRingCentralSettings.mockRejectedValueOnce(new ApiError("Server error", { status: 500 }));
  render(<RecruiterTargetsTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save targets" })).toBeNull();
});

test("Recruiters: a failed read is said, rather than an empty list that reads as none", async () => {
  api.getRecruiters.mockRejectedValueOnce(new ApiError("Server error", { status: 500 }));
  render(<RecruitersTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByText(/No recruiters yet/)).toBeNull();
});

test("Recruiters: the list first; Invite and Add manually open from buttons", async () => {
  render(<RecruitersTab />);
  expect(await screen.findByText(/No recruiters yet/)).toBeTruthy();
  expect(screen.queryByText("Invite A Recruiter To Connect RingCentral")).toBeNull();
  expect(screen.queryByText("Add Recruiter & Number Manually")).toBeNull();
  // It needs the recruiters, not the shared credentials.
  expect(api.getRingCentralSettings).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Invite a recruiter" }));
  expect(screen.getByText("Invite A Recruiter To Connect RingCentral")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add manually" }));
  expect(screen.getByText("Add Recruiter & Number Manually")).toBeTruthy();
  expect(screen.queryByText("Invite A Recruiter To Connect RingCentral")).toBeNull();
});

test("Bitrix24: the connection form, without the readout that repeated it", async () => {
  render(<BitrixTab />);
  expect(await screen.findByText("Bitrix24 — who a lead is assigned to")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Recruiters & Numbers/ })).toHaveAttribute("href", "#settings/ringcentral");
  expect(screen.queryByText("Portal")).toBeNull();
  // "Creates" and "Source ID" are the form's own labels, once each — no
  // second, read-only copy underneath.
  expect(screen.getAllByText("Creates")).toHaveLength(1);
  expect(screen.getAllByText("Source ID")).toHaveLength(1);
});
