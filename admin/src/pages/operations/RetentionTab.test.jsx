/**
 * The retention list, on the two things it must show and the one it must not.
 *
 * MUST SHOW: the reasons, and the thing to do about them. A score alone tells a
 * dispatcher nothing they can act on, and a list of names with numbers beside
 * them is the exact artefact this feature was designed not to become.
 *
 * MUST NOT: any control that touches a driver's employment, or any place to
 * record an opinion of one.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RetentionTab from "./RetentionTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getRetention: vi.fn(),
  acknowledgeRetention: vi.fn(),
}));

const URGENT = {
  id: 3, driverName: "Sam Rivera", groupId: 7, level: "urgent", score: 10,
  signals: [
    { key: "home_request_unanswered", detail: "1 home time request expired without an answer" },
    { key: "road_clock_over", detail: "3 weeks past the road allowance" },
    { key: "bonus_unpaid", detail: "$300 of earned bonus has not been paid or posted" },
  ],
  actions: ["Answer their home time request and give them a date they can hold you to"],
  acknowledgedAt: null,
};

const flash = vi.fn();

async function open(over = {}) {
  api.getRetention.mockResolvedValue({
    assessments: over.assessments ?? [URGENT],
    summary: over.summary ?? { urgent: 1, watch: 2, acknowledged: 0 },
  });
  render(<RetentionTab flash={flash} />);
  await waitFor(() => expect(screen.getByText(/Drivers who may be about to leave/)).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  api.acknowledgeRetention.mockResolvedValue({});
});

test("every reason is shown, not just a verdict", async () => {
  await open();
  expect(screen.getByText(/1 home time request expired without an answer/)).toBeInTheDocument();
  expect(screen.getByText(/3 weeks past the road allowance/)).toBeInTheDocument();
  expect(screen.getByText(/\$300 of earned bonus/)).toBeInTheDocument();
});

test("the thing to DO is the strongest element on the row", async () => {
  await open();
  const action = screen.getByText(/Answer their home time request/);
  expect(action).toBeInTheDocument();
  expect(action.closest("strong")).toBeTruthy();
});

test("the screen states what it is not, in words", async () => {
  await open();
  expect(screen.getByText(/something the company did, or something the driver said/i)).toBeInTheDocument();
  expect(screen.getByText(/no action on this page changes anybody's employment/i)).toBeInTheDocument();
});

test("THE ONLY CONTROL IS AN ACKNOWLEDGEMENT", async () => {
  await open();
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons).toEqual(["We know"]);
});

test("acknowledging says so, and says Wenze will go quiet until it gets worse", async () => {
  await open({
    assessments: [{ ...URGENT, acknowledgedAt: "2026-09-11T00:00:00Z", acknowledgedBy: "boss" }],
  });
  expect(screen.getByText(/Acknowledged by boss/)).toBeInTheDocument();
  expect(screen.getByText(/until it gets worse/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Un-acknowledge" })).toBeInTheDocument();
});

test("clicking it calls through and reloads", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "We know" }));
  await waitFor(() => expect(api.acknowledgeRetention).toHaveBeenCalledWith(3, true));
  await waitFor(() => expect(api.getRetention).toHaveBeenCalledTimes(2));
});

test("an empty list says nobody is flagged and when it looks again", async () => {
  await open({ assessments: [], summary: { urgent: 0, watch: 0, acknowledged: 0 } });
  expect(screen.getByText(/Nobody is flagged/)).toBeInTheDocument();
  expect(screen.getByText(/every four hours/)).toBeInTheDocument();
});

test("a failed load flashes rather than rendering a reassuring empty page", async () => {
  api.getRetention.mockRejectedValue(new Error("service unavailable"));
  render(<RetentionTab flash={flash} />);
  await waitFor(() => expect(flash).toHaveBeenCalledWith("error", "service unavailable"));
  expect(screen.queryByText(/Nobody is flagged/)).toBeNull();
});
