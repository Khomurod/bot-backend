/**
 * The Leads page after the Indeed intake was removed (November 2026).
 *
 * No new Indeed leads arrive, but the ones recorded before stay in `leads`, so
 * the page keeps the Indeed filter and asks the server for exactly those — and
 * when there are none it says why, rather than promising Facebook leads under
 * an Indeed filter. The Gmail script and its setup guide are gone.
 */
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({ getLeads: vi.fn().mockResolvedValue([]) }));

import * as api from "../api";
import LeadsPage from "./LeadsPage";

afterEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps an implementation; put the empty answer back.
  api.getLeads.mockResolvedValue([]);
});

test("the Indeed filter asks for the Indeed leads already recorded", async () => {
  render(<LeadsPage />);
  await waitFor(() => expect(api.getLeads).toHaveBeenCalledWith(""));
  expect(screen.getByText("Facebook leads will appear here as they arrive.")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Indeed" }));
  await waitFor(() => expect(api.getLeads).toHaveBeenLastCalledWith("indeed"));
  expect(await screen.findByText(/No new Indeed leads arrive/)).toBeTruthy();
  expect(screen.queryByText("Facebook leads will appear here as they arrive.")).toBeNull();
});

test("the Gmail script and its setup guide are gone", async () => {
  render(<LeadsPage />);
  await waitFor(() => expect(api.getLeads).toHaveBeenCalled());
  expect(screen.queryByText(/How to connect Indeed/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Copy script/ })).toBeNull();
});

test("an Indeed lead recorded before the removal is listed with its badge", async () => {
  const recorded = {
    id: 7, source: "indeed", full_name: "Dee Example", email: null, phone: "+15550100002",
    job_title: "CDL-A Driver", message: null, bitrix_status: "created",
    created_at: "2026-10-09T12:00:00.000Z",
  };
  api.getLeads.mockImplementation(async (source) => (source === "indeed" ? [recorded] : []));
  render(<LeadsPage />);
  await userEvent.click(await screen.findByRole("button", { name: "Indeed" }));

  const row = (await screen.findByText("Dee Example")).closest("tr");
  expect(row.textContent).toContain("Indeed");
  expect(row.textContent).toContain("CDL-A Driver");
  expect(row.textContent).toContain("In Bitrix24");
  expect(screen.queryByText(/No new Indeed leads arrive/)).toBeNull();
});

