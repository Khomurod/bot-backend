/**
 * The page, tested on the promises it makes to an operator.
 *
 * Four of them, and each has a way of quietly breaking:
 *
 *   A quiet page must say WHY it is quiet. "Nothing needs attention" and "the
 *   sweep stopped running three days ago" look identical and mean opposite
 *   things.
 *
 *   A dismissal needs a reason. The schema enforces it with a CHECK, which
 *   means a UI that lets the button be pressed produces an error nobody outside
 *   Postgres can read.
 *
 *   Being allowed to look is not being allowed to change. A 403 from the apply
 *   route is expected — it is the new permission working — and must be shown as
 *   such rather than as a fault.
 *
 *   A failed refresh must not render as an empty page. Empty data presented as
 *   normal is the failure mode this whole feature exists to remove.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import * as api from "../../api";
import OperationsPage from "../OperationsPage";

const FINDING = {
  id: 11,
  checkKey: "home_time.closable_open_cycle",
  subjectType: "road_history",
  subjectId: "7",
  title: "WENZE UNIT # 27: home stay from 2026-08-25 can be closed",
  severity: "info",
  tier: "auto",
  status: "open",
  actionable: true,
  confidence: 90,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  evidence: { cycleId: 7, evidenceClass: "A", source: "driver_home_status.state_since" },
  proposedChange: {
    table: "driver_road_history",
    id: 7,
    returnToRoadAt: { from: null, to: "2026-08-31T00:00:00Z" },
    homeDays: { from: null, to: 6 },
  },
};

const summary = (overrides = {}) => ({
  findings: { serious: 0, warning: 0, info: 1, total: 1 },
  corrections: { total: 0, live: 0, reverted: 0, bySystem: 0, byAdmin: 0 },
  sweep: { running: true, lastRun: { at: new Date().toISOString() } },
  ...overrides,
});

let spies = [];

function stub(name, impl) {
  const spy = vi.spyOn(api, name).mockImplementation(impl);
  spies.push(spy);
  return spy;
}

beforeEach(() => {
  spies = [];
  stub("getOperationsSummary", async () => summary());
  stub("getOperationsFindings", async () => ({ findings: [FINDING] }));
  stub("getOperationsFinding", async () => ({ finding: FINDING, corrections: [] }));
  stub("getOperationsCorrections", async () => ({ corrections: [] }));
  stub("getOperationsChecks", async () => ({ checks: [] }));
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

async function openTheFinding(user) {
  await screen.findByRole("button", { name: /Home stay never closed/ });
  await user.click(screen.getByRole("button", { name: /Home stay never closed/ }));
  await user.click(await screen.findByRole("button", { name: /home stay from 2026-08-25/i }));
  return screen.findByRole("button", { name: /Close finding details/ });
}

describe("a quiet page explains itself", () => {
  test("no findings reads as agreement, not as absence", async () => {
    spies.forEach((s) => s.mockRestore());
    spies = [];
    stub("getOperationsSummary", async () => summary({
      findings: { serious: 0, warning: 0, info: 0, total: 0 },
    }));
    stub("getOperationsFindings", async () => ({ findings: [] }));

    render(<OperationsPage />);

    expect(await screen.findByText(/Nothing needs attention/)).toBeInTheDocument();
    expect(screen.getByText(/agrees with itself right now/)).toBeInTheDocument();
  });

  test("a stopped sweep is called out, because it looks the same otherwise", async () => {
    spies.forEach((s) => s.mockRestore());
    spies = [];
    stub("getOperationsSummary", async () => summary({ sweep: { running: false, lastRun: null } }));
    stub("getOperationsFindings", async () => ({ findings: [] }));

    render(<OperationsPage />);

    expect(await screen.findByText(/sweep is not running/i)).toBeInTheDocument();
  });

  test("severity tiles are rendered at zero rather than disappearing", async () => {
    spies.forEach((s) => s.mockRestore());
    spies = [];
    stub("getOperationsSummary", async () => summary({
      findings: { serious: 0, warning: 0, info: 0, total: 0 },
    }));
    stub("getOperationsFindings", async () => ({ findings: [] }));

    render(<OperationsPage />);

    expect(await screen.findByText("Serious")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
  });
});

describe("the drawer shows the evidence before the buttons", () => {
  test("the proposed change is explicit before and after", async () => {
    const user = userEvent.setup();
    render(<OperationsPage />);
    await openTheFinding(user);

    expect(screen.getByText("Why we think so")).toBeInTheDocument();
    expect(screen.getByText(/Nothing here is inferred/)).toBeInTheDocument();
    expect(screen.getByText("returnToRoadAt")).toBeInTheDocument();
    expect(screen.getByText("2026-08-31T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("driver_home_status.state_since")).toBeInTheDocument();
  });
});

describe("a dismissal needs a reason", () => {
  test("the button stays disabled until one is given", async () => {
    const user = userEvent.setup();
    const dismiss = stub("dismissOperationsFinding", async () => ({ finding: FINDING }));
    render(<OperationsPage />);
    await openTheFinding(user);

    const button = screen.getByRole("button", { name: "Dismiss" });
    expect(button).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/Reason/), "Already handled by hand.");
    expect(button).toBeEnabled();

    await user.click(button);
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(11, "Already handled by hand."));
  });
});

describe("looking is not changing", () => {
  test("a 403 from apply is explained as a missing permission, not as a fault", async () => {
    const user = userEvent.setup();
    stub("applyFindingCorrection", async () => {
      const err = new Error("Missing permission: operations.corrections.apply");
      err.status = 403;
      throw err;
    });
    render(<OperationsPage />);
    await openTheFinding(user);

    await user.click(screen.getByRole("button", { name: /Apply the correction/ }));

    expect(await screen.findByText(/operations\.corrections\.apply/)).toBeInTheDocument();
  });

  test("a 409 says the evidence moved and reloads instead of offering a retry", async () => {
    const user = userEvent.setup();
    stub("applyFindingCorrection", async () => {
      const err = new Error("the recorded return moment has moved");
      err.status = 409;
      err.detail = "Cycle 7: the recorded return moment has moved";
      throw err;
    });
    render(<OperationsPage />);
    await openTheFinding(user);

    await user.click(screen.getByRole("button", { name: /Apply the correction/ }));

    expect(await screen.findByText(/reloading what is there now/)).toBeInTheDocument();
  });

  test("a report-only finding offers no apply button at all", async () => {
    const user = userEvent.setup();
    spies.forEach((s) => s.mockRestore());
    spies = [];
    const reportOnly = {
      ...FINDING, tier: "warning", actionable: false, proposedChange: null,
    };
    stub("getOperationsSummary", async () => summary());
    stub("getOperationsFindings", async () => ({ findings: [reportOnly] }));
    stub("getOperationsFinding", async () => ({ finding: reportOnly, corrections: [] }));

    render(<OperationsPage />);
    await openTheFinding(user);

    expect(screen.queryByRole("button", { name: /Apply the correction/ })).toBeNull();
    expect(screen.getByText(/here to be read, not acted on/)).toBeInTheDocument();
  });
});

describe("an approval-tier finding", () => {
  test("offers Apply — a decision an administrator can take, not a report", async () => {
    const user = userEvent.setup();
    spies.forEach((s) => s.mockRestore());
    spies = [];
    const approval = {
      ...FINDING, checkKey: "home_time.clock_reset_on_group_change", tier: "approval", actionable: true,
      title: "RUSLAN ABDULLAEV: the road clock restarted on the new chat",
    };
    stub("getOperationsSummary", async () => summary());
    stub("getOperationsFindings", async () => ({ findings: [approval] }));
    stub("getOperationsFinding", async () => ({ finding: approval, corrections: [] }));

    render(<OperationsPage />);
    await user.click(await screen.findByRole("button", { name: /Road clock restarted/ }));
    await user.click(await screen.findByRole("button", { name: /RUSLAN ABDULLAEV: the road clock restarted/ }));
    await screen.findByRole("button", { name: /Close finding details/ });

    expect(screen.getByRole("button", { name: /Apply the correction/ })).toBeInTheDocument();
  });
});

describe("a failed refresh", () => {
  test("shows a banner rather than an empty page", async () => {
    spies.forEach((s) => s.mockRestore());
    spies = [];
    stub("getOperationsSummary", async () => {
      const err = new Error("the database could not be reached");
      err.status = 503;
      err.code = "DB_UNAVAILABLE";
      throw err;
    });
    stub("getOperationsFindings", async () => ({ findings: [] }));

    render(<OperationsPage />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
