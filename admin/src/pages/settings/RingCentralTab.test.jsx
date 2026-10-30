/**
 * Settings → RingCentral: a settings read that fails is said, with a retry,
 * and the form is NOT drawn — it used to be drawn against no settings and
 * throw ("This section has a bug"), like Settings → Location Providers did.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RingCentralTab from "./RingCentralTab";
import { ApiError } from "../../api/apiError";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getRingCentralSettings: vi.fn(),
  getRecruiters: vi.fn(),
  updateRingCentralSettings: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

test("the settings cannot be read: the failure and a retry, never the form", async () => {
  api.getRingCentralSettings.mockRejectedValueOnce(new ApiError("Database unavailable", { status: 503, code: "DB_UNAVAILABLE" }));
  api.getRecruiters.mockResolvedValueOnce([]);
  render(<RingCentralTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByLabelText("Shared Client ID")).not.toBeInTheDocument();
  expect(api.updateRingCentralSettings).not.toHaveBeenCalled();
});

test("the recruiters cannot be read: the same, rather than a half-drawn tab", async () => {
  api.getRingCentralSettings.mockResolvedValueOnce({ enabled: false });
  api.getRecruiters.mockRejectedValueOnce(new ApiError("Server error", { status: 500 }));
  render(<RingCentralTab />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByLabelText("Shared Client ID")).not.toBeInTheDocument();
});

test("an answer with no settings in it is a failure too", async () => {
  api.getRingCentralSettings.mockResolvedValueOnce(undefined);
  api.getRecruiters.mockResolvedValueOnce([]);
  render(<RingCentralTab />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/did not send the RingCentral settings/);
});
