/**
 * Recruiter KPIs, with the Targets tab that moved here from the RingCentral
 * settings screen (November 2026). The day's numbers say what they are scored
 * against in one line, and that line opens the tab where it is changed.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "../api";
import RecruiterKpiPage from "./RecruiterKpiPage";

vi.mock("../api", () => ({
  getRecruiterStats: vi.fn(),
  syncRecruiterCalls: vi.fn(),
  getRingCentralSettings: vi.fn(),
  updateRingCentralSettings: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getRecruiterStats.mockResolvedValue({
    targets: { talkSeconds: 9000, talkLabel: "2h 30m", outbound: 150, realConversations: 35 },
    thresholds: { nonValuableMaxSeconds: 30, realConversationMinSeconds: 60, strongConversationMinSeconds: 180 },
    recruiters: [],
  });
  api.getRingCentralSettings.mockResolvedValue({
    targetTalkMinutes: 150, targetOutbound: 150, targetRealConversations: 35, timezone: "America/Chicago",
    nonValuableMaxSeconds: 30, realConversationMinSeconds: 60, strongConversationMinSeconds: 180,
  });
});

test("the day opens first, its targets in one line, and that line opens Targets", async () => {
  const onTabChange = vi.fn();
  render(<RecruiterKpiPage tab={null} onTabChange={onTabChange} />);
  expect(await screen.findByText(/calls under 30s do not count/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Change targets" })).toHaveAttribute("href", "#recruiter_kpis/targets");
  await userEvent.click(screen.getByRole("link", { name: "Change targets" }));
  expect(onTabChange).toHaveBeenCalledWith("targets");
});

test("#recruiter_kpis/targets opens the targets form, and no date picker", async () => {
  render(<RecruiterKpiPage tab="targets" onTabChange={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Save targets" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sync now/ })).toBeNull();
  await waitFor(() => expect(api.getRingCentralSettings).toHaveBeenCalled());
});
