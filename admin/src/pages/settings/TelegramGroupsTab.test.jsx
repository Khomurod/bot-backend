/**
 * Settings → Bonus Groups: each bonus category has its own destination, and
 * the two save independently of each other.
 *
 * The driver-raise review's two fields (REQUESTS to dispatch, RESULTS to
 * accounting) were removed with that feature in October 2026; the last test
 * pins that they stay gone.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TelegramGroupsTab from "./TelegramGroupsTab";
import { getMessageGroupSettings, updateMessageGroupSettings } from "../../api";

vi.mock("../../api", () => ({
  getMessageGroupSettings: vi.fn(),
  updateMessageGroupSettings: vi.fn(),
}));

const entry = (groupId) => ({ groupId, fromEnv: false, configured: Boolean(groupId) });

function settings({ mileageBonus = "", roadBonus = "" } = {}) {
  return {
    mileageBonus: entry(mileageBonus),
    roadBonus: entry(roadBonus),
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

const mileageField = () => screen.getByLabelText(/Mileage Bonus Telegram Group ID/);
const roadField = () => screen.getByLabelText(/Road Bonus Telegram Group ID/);

async function open(loaded = settings()) {
  getMessageGroupSettings.mockResolvedValue(loaded);
  updateMessageGroupSettings.mockImplementation(async (payload) => settings(payload));
  render(<TelegramGroupsTab />);
  await waitFor(() => expect(mileageField()).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

test("each category is its own field with its own stored value", async () => {
  await open(settings({ mileageBonus: "-100111", roadBonus: "-100222" }));
  expect(mileageField()).toHaveValue("-100111");
  expect(roadField()).toHaveValue("-100222");
});

test("an unset category is shown as not configured, never pre-filled from another", async () => {
  await open(settings({ mileageBonus: "-100111" }));
  expect(roadField()).toHaveValue("");
  expect(screen.getAllByText(/✕ Not configured/)).toHaveLength(1);
});

test("saving sends every category, trimmed, and leaves the untouched one as it was", async () => {
  await open(settings({ mileageBonus: "-100111" }));
  fireEvent.change(roadField(), { target: { value: " -100222 " } });
  fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

  await waitFor(() => expect(updateMessageGroupSettings).toHaveBeenCalledTimes(1));
  expect(updateMessageGroupSettings).toHaveBeenCalledWith({
    mileageBonus: "-100111",
    roadBonus: "-100222",
  });
  await waitFor(() => expect(screen.getByText(/settings saved/i)).toBeInTheDocument());
  expect(roadField()).toHaveValue("-100222");
});

test("the driver-raise fields are gone", async () => {
  await open();
  expect(screen.queryByText(/Dispatch Rate Review/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Driver Raise Results/)).not.toBeInTheDocument();
});
