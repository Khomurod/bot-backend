/**
 * Settings → Location Providers: a settings read that fails is said, with a
 * retry, and the form is NOT drawn. It used to be drawn against no settings and
 * throw ("This section has a bug") — and a form drawn from defaults could save
 * every provider "Enabled" and a blank API base over the stored values.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LocationProvidersTab from "./LocationProvidersTab";
import { ApiError } from "../../api/apiError";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getEldSettings: vi.fn(),
  updateEldSettings: vi.fn(),
  testEldProvider: vi.fn(),
}));

const stored = {
  samsaraEnabled: false, factorEnabled: true, leaderEnabled: false,
  driveHosApiBase: "https://api.drivehos.app",
  samsaraApiKeySet: true, samsaraApiKeyMasked: "••••1234", samsaraFromEnv: false,
  driveHosProviderKeySet: false, factorCompanyKeySet: false, leaderCompanyKeySet: false,
  updatedAt: null,
};

beforeEach(() => vi.clearAllMocks());

test("a failed read shows what went wrong and a retry, never the form", async () => {
  api.getEldSettings.mockRejectedValueOnce(new ApiError("Database unavailable", { status: 503, code: "DB_UNAVAILABLE" }));
  render(<LocationProvidersTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  expect(api.updateEldSettings).not.toHaveBeenCalled();
});

test("an answer with no settings in it is a failure too, not an empty form", async () => {
  api.getEldSettings.mockResolvedValueOnce(undefined);
  render(<LocationProvidersTab />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/did not send the live-location settings/);
  expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
});

test("retry reads again, and the stored values come back into the form", async () => {
  api.getEldSettings
    .mockRejectedValueOnce(new ApiError("Server error", { status: 500 }))
    .mockResolvedValueOnce(stored);
  render(<LocationProvidersTab />);
  const alert = await screen.findByRole("alert");
  fireEvent.click(alert.querySelector("button.btn-primary"));
  expect(await screen.findByRole("button", { name: "Save settings" })).toBeInTheDocument();
  expect(api.getEldSettings).toHaveBeenCalledTimes(2);
  expect(screen.getByText("••••1234")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
