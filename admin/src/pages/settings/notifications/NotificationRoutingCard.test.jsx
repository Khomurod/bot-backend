/**
 * The destination screen, on the one interaction that has to be exactly right:
 * accepting a correction the server offered.
 *
 * A dropped minus sign is the failure that started all of this — 101 staff
 * alerts discarded over months. The server now catches it and hands back the
 * corrected id AND the field it belongs to. Applying it to the wrong field
 * would reroute every defaulted category while leaving the broken one broken.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NotificationRoutingCard from "./NotificationRoutingCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
  testNotificationChat: vi.fn(),
  previewNotification: vi.fn(),
}));

const DATA = {
  settings: { defaultChatId: "-100111", categoryChatIds: {}, repeatAfterHours: 168 },
  categories: [
    {
      key: "fuel", label: "Fuel risks", what: "A truck may be running low on fuel.",
      severity: "warning", humanActionUsually: true,
    },
    {
      key: "retention", label: "Driver retention", what: "A driver may be a retention risk.",
      severity: "warning", humanActionUsually: true,
    },
  ],
  queue: { delivered24h: 3, pending: 0, abandoned: 0 },
};

const flash = vi.fn();

async function open(data = DATA) {
  api.getNotificationSettings.mockResolvedValue(data);
  render(<NotificationRoutingCard flash={flash} />);
  await waitFor(() => expect(screen.getByText("Fuel risks")).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });

test("each category says what lands there and whether somebody must act", async () => {
  await open();
  expect(screen.getByText(/A truck may be running low on fuel/)).toBeInTheDocument();
  expect(screen.getAllByText("needs a person")).toHaveLength(2);
});

test("a category with no group of its own says it uses the default", async () => {
  await open();
  expect(screen.getAllByText("Goes to the default group.")).toHaveLength(2);
});

test("with NO default group, the screen says nothing will be sent", async () => {
  await open({ ...DATA, settings: { ...DATA.settings, defaultChatId: "" } });
  expect(screen.getByText(/Nothing is being sent anywhere/)).toBeInTheDocument();
  expect(screen.getAllByText(/No default group — these will not be sent/)).toHaveLength(2);
});

test("a correction for the DEFAULT is applied to the default", async () => {
  await open();
  api.updateNotificationSettings.mockRejectedValueOnce(
    Object.assign(new Error("The default group does not match any known chat"), {
      suggestion: "-1005052301861", field: "defaultChatId",
    })
  );
  const input = screen.getByPlaceholderText("e.g. -1001234567890");
  fireEvent.change(input, { target: { value: "1005052301861" } });
  fireEvent.blur(input);

  await waitFor(() => expect(screen.getByText("-1005052301861")).toBeInTheDocument());
  api.updateNotificationSettings.mockResolvedValueOnce(DATA.settings);
  fireEvent.click(screen.getByText("Use it"));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
    { defaultChatId: "-1005052301861" }
  ));
});

test("a correction for a CATEGORY is applied to that category, not the default", async () => {
  await open();
  api.updateNotificationSettings.mockRejectedValueOnce(
    Object.assign(new Error("Fuel risks does not match any known chat"), {
      suggestion: "-100999", field: "categoryChatIds.fuel",
    })
  );
  const [fuelInput] = screen.getAllByPlaceholderText("Same as the default group");
  fireEvent.change(fuelInput, { target: { value: "100999" } });
  fireEvent.blur(fuelInput);

  await waitFor(() => expect(screen.getByText("-100999")).toBeInTheDocument());
  api.updateNotificationSettings.mockResolvedValueOnce(DATA.settings);
  fireEvent.click(screen.getByText("Use it"));

  await waitFor(() => expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
    { categoryChatIds: { fuel: "-100999" } }
  ));
  // The whole point: the default is untouched, so every other category keeps
  // going where it was going.
  expect(api.updateNotificationSettings).not.toHaveBeenCalledWith(
    expect.objectContaining({ defaultChatId: expect.anything() })
  );
});

test("sending an example reports where it landed", async () => {
  await open();
  api.previewNotification.mockResolvedValue({ delivered: true });
  fireEvent.click(screen.getAllByText("Send an example")[0]);
  await waitFor(() => expect(api.previewNotification).toHaveBeenCalledWith("fuel"));
  await waitFor(() => expect(flash).toHaveBeenCalledWith("success", expect.stringMatching(/check the chat/)));
});

test("a delivery queue that gave up is shown, not buried", async () => {
  await open({ ...DATA, queue: { delivered24h: 3, pending: 1, abandoned: 2 } });
  expect(screen.getByText(/2 gave up after retrying/)).toBeInTheDocument();
});
