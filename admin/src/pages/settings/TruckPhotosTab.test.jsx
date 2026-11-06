/**
 * Settings → Truck Photos.
 *
 * The switch is the guard: it stays disabled until a test message has reached
 * the recipient (the server refuses it too), and a person who has not pressed
 * Start is told so in words. The recipient is numbers only. Names are made up.
 */
import React from "react";
import { expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TruckPhotosTab from "./TruckPhotosTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getTruckPhotos: vi.fn(),
  updateTruckPhotos: vi.fn(),
  sendTruckPhotoTestMessage: vi.fn(),
}));

const SETTINGS = {
  enabled: false, recipientTelegramId: null, recipientVerifiedAt: null, lookbackHours: 3, maxPhotosPerPdf: 60,
};
const switchBox = () => screen.getByLabelText(/Make PDFs from truck photos/i);

beforeEach(() => {
  vi.clearAllMocks();
  api.getTruckPhotos.mockResolvedValue({ settings: SETTINGS, recent: [] });
  api.updateTruckPhotos.mockImplementation(async (patch) => ({ ...SETTINGS, ...patch }));
});

test("off by default, and the switch is disabled until the recipient was reached", async () => {
  render(<TruckPhotosTab />);
  expect(await screen.findByLabelText(/Make PDFs from truck photos/i)).toBeDisabled();
  expect(switchBox()).not.toBeChecked();
  expect(screen.getByText(/send them a test message first/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Send test message/i })).toBeDisabled();
});

test("the recipient is numbers only, and saving sends exactly that id", async () => {
  render(<TruckPhotosTab />);
  const input = await screen.findByLabelText(/Recipient's Telegram user ID/i);
  fireEvent.change(input, { target: { value: "-12a34 567" } });
  expect(input).toHaveValue("1234567");
  fireEvent.click(screen.getByRole("button", { name: /Save recipient/i }));
  await waitFor(() => expect(api.updateTruckPhotos).toHaveBeenCalledWith({ recipientTelegramId: "1234567" }));
});

test("a person who has not pressed Start is told so, and the switch stays off", async () => {
  api.getTruckPhotos.mockResolvedValue({ settings: { ...SETTINGS, recipientTelegramId: "1234567" }, recent: [] });
  api.sendTruckPhotoTestMessage.mockResolvedValue({
    ok: false, reason: "not_started",
    message: "This person has not pressed Start on the bot yet. Ask them to open @WenzeBot in Telegram and press Start.",
  });
  render(<TruckPhotosTab />);
  fireEvent.click(await screen.findByRole("button", { name: /Send test message/i }));
  expect(await screen.findByText(/has not pressed Start on the bot yet/)).toBeTruthy();
  expect(switchBox()).toBeDisabled();
});

test("once the test message arrived, the switch turns it on", async () => {
  api.getTruckPhotos.mockResolvedValue({ settings: { ...SETTINGS, recipientTelegramId: "1234567" }, recent: [] });
  api.sendTruckPhotoTestMessage.mockResolvedValue({
    ok: true, settings: { ...SETTINGS, recipientTelegramId: "1234567", recipientVerifiedAt: "2026-11-06T15:00:00Z" },
  });
  render(<TruckPhotosTab />);
  fireEvent.click(await screen.findByRole("button", { name: /Send test message/i }));
  await waitFor(() => expect(switchBox()).not.toBeDisabled());
  fireEvent.click(switchBox());
  await waitFor(() => expect(api.updateTruckPhotos).toHaveBeenCalledWith({ enabled: true }));
});

test("the look-back is saved as a number of hours", async () => {
  render(<TruckPhotosTab />);
  const input = await screen.findByLabelText(/Hours before the word/i);
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(api.updateTruckPhotos).toHaveBeenCalledWith({ lookbackHours: 5 }));
});

test("the latest hand-overs say what happened, and a refused save shows the server's words", async () => {
  api.getTruckPhotos.mockResolvedValue({
    settings: SETTINGS,
    recent: [{
      id: 1, kind: "outbound", status: "sent", groupName: "Avery Davis 562", triggeredByName: "Kim Rowe",
      photoCount: 42, excludedCount: 2, parts: 1, reason: null, aiAssisted: true, createdAt: "2026-11-06T15:00:00Z",
    }],
  });
  api.updateTruckPhotos.mockRejectedValue(new Error("How far back to look must be a whole number of hours from 1 to 24."));
  render(<TruckPhotosTab />);
  expect(await screen.findByText(/Avery Davis 562 \(Kim Rowe\)/)).toBeTruthy();
  expect(screen.getByText(/42 \(2 left out\)/)).toBeTruthy();
  expect(screen.getByText(/Sent \(AI checked\)/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Hours before the word/i), { target: { value: "7" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  expect(await screen.findByText(/whole number of hours from 1 to 24/)).toBeTruthy();
});

test("a failed read shows the failure, not a form drawn from defaults", async () => {
  api.getTruckPhotos.mockRejectedValue(new Error("the database could not be reached"));
  render(<TruckPhotosTab />);
  await waitFor(() => expect(screen.queryByLabelText(/Make PDFs from truck photos/i)).toBeNull());
  expect(await screen.findByText(/the database could not be reached/)).toBeTruthy();
});
