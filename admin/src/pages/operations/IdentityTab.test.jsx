/**
 * The Identity tab's one promise: nothing is applied before it has been shown.
 * Preview first, then Apply; and the result says what was created and stamped.
 */
import React from "react";
import { describe, expect, test, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import * as api from "../../api";
import IdentityTab from "./IdentityTab";

const COVERAGE = {
  people: 5, activeDriverGroups: 6, groupsWithoutPerson: 1, openUnits: 3,
  unstamped: { roadHistory: 2, requests: 1, mileage: 0 },
};
const PREVIEW = {
  dryRun: true,
  plan: {
    stats: { groups: 6, people: 5, anchoredClusters: 1, mergeCandidates: 1, contestedUnits: 1, alreadyClaimedGroups: 0 },
    contestedUnits: [{ unitNumber: "001", people: [{ displayName: "OLABODE OLUDAISI" }, { displayName: "STARKS DAYMON" }] }],
  },
};

afterEach(() => vi.restoreAllMocks());

describe("IdentityTab", () => {
  test("shows coverage, refuses to apply before a preview, then applies and reports", async () => {
    vi.spyOn(api, "getIdentityCoverage").mockResolvedValue({ coverage: COVERAGE });
    const preview = vi.spyOn(api, "previewIdentityBackfill").mockResolvedValue(PREVIEW);
    const run = vi.spyOn(api, "runIdentityBackfill").mockResolvedValue({
      applied: { peopleCreated: 5, associationsOpened: 6, unitsOpened: 3 },
      stamped: { driver_road_history: 2, home_time_requests: 1, mileage_bonus_progress: 0 },
    });
    const flash = vi.fn();
    const user = userEvent.setup();
    render(<IdentityTab flash={flash} />);

    await screen.findByText("Groups without a person");
    expect(screen.getByText("5")).toBeInTheDocument();

    const apply = screen.getByRole("button", { name: "Apply backfill" });
    expect(apply).toBeDisabled();
    expect(run).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/shared names reported, not merged/)).toBeInTheDocument();
    expect(screen.getByText(/OLABODE OLUDAISI, STARKS DAYMON/)).toBeInTheDocument();
    expect(apply).toBeEnabled();

    await user.click(apply);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Stamped 3 existing rows/)).toBeInTheDocument();
    expect(flash).toHaveBeenCalledWith("success", expect.stringMatching(/5 people created/));
  });

  test("a refused apply is shown, not swallowed", async () => {
    vi.spyOn(api, "getIdentityCoverage").mockResolvedValue({ coverage: COVERAGE });
    vi.spyOn(api, "previewIdentityBackfill").mockResolvedValue(PREVIEW);
    vi.spyOn(api, "runIdentityBackfill").mockRejectedValue({ detail: "Missing permission: operations.corrections.apply" });
    const flash = vi.fn();
    const user = userEvent.setup();
    render(<IdentityTab flash={flash} />);

    await user.click(await screen.findByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Apply backfill" }));
    await waitFor(() => expect(flash).toHaveBeenCalledWith("error", expect.stringMatching(/Missing permission/)));
  });
});
