/**
 * Samsara, in two sections since November 2026: the connection, safety events
 * and video recovery (one settings row, one Save) — and the driver-group music
 * overlay, with its own Save, under Samsara Video & Music. On one screen they
 * had two Save buttons and nothing said which saved what.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../api";
import SamsaraTab from "./SamsaraTab";

vi.mock("../../api", () => ({
  getSamsaraSettings: vi.fn(),
  updateSamsaraSettings: vi.fn(),
  testSamsaraConnection: vi.fn(),
  getSamsaraVideoRecovery: vi.fn(),
  getSafetyEventSettings: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getSamsaraSettings.mockResolvedValue({
    settings: {
      enabled: true, apiBase: "https://api.samsara.com", apiKeySet: false, speedingEventsEnabled: true,
      maxVideoMegabytes: 25, videoRecoveryEnabled: true, videoRecoveryInitialDelaySeconds: 300,
      videoRetrievalEnabled: true, videoRecoveryRetryIntervalSeconds: 300, videoRecoveryMaxAttempts: 12,
      videoRetrievalWindowBeforeSeconds: 10, videoRetrievalWindowAfterSeconds: 10,
    },
    recovery: { inProgress: 0 },
  });
  api.getSamsaraVideoRecovery.mockResolvedValue([]);
});

test("Samsara has one Save, and points at the music section instead of carrying it", async () => {
  render(<SamsaraTab />);
  expect(await screen.findByRole("button", { name: "Save Samsara settings" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^Save/ })).toHaveLength(1);
  expect(screen.queryByText("Active music")).toBeNull();
  expect(api.getSafetyEventSettings).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Samsara Video & Music" })).toHaveAttribute("href", "#settings/samsara_video");
});

test("a first read that fails offers Retry instead of a spinner that never ends", async () => {
  const good = await api.getSamsaraSettings();
  api.getSamsaraSettings.mockReset();
  api.getSamsaraSettings.mockRejectedValueOnce(new Error("Server unreachable")).mockResolvedValue(good);
  render(<SamsaraTab />);
  const retry = await screen.findByRole("button", { name: /Retry|Try again/i });
  expect(screen.queryByText("Loading…")).toBeNull();
  fireEvent.click(retry);
  await waitFor(() => expect(api.getSamsaraSettings).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: /Retry|Try again/i })).toBeNull());
});
