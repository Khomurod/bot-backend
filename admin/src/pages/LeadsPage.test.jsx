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

afterEach(() => vi.clearAllMocks());

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
