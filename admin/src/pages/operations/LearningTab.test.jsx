/**
 * What Wenze has noticed about its own mistakes.
 *
 * The one thing this screen must say, and must keep saying: AGREEING RECORDS
 * AGREEMENT AND CHANGES NOTHING. An administrator who clicked "good idea"
 * believing the change was made would stop looking for it, and the rule would
 * stay exactly as wrong as it was.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LearningTab from "./LearningTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getLearningSuggestions: vi.fn(),
  decideLearningSuggestion: vi.fn(),
}));

const WAITING = {
  id: 4, kind: "reverted_correction", subjectId: "home_time.close_cycle",
  title: '"home time close cycle" has been undone 3 times',
  suggestion: "Consider switching automatic correction OFF for this check.",
  evidence: { count: 3, reasons: ["wrong return date", "driver was still at home"] },
  status: "proposed",
};

const flash = vi.fn();

async function open(over = {}) {
  api.getLearningSuggestions.mockResolvedValue({
    suggestions: over.suggestions ?? [WAITING],
    summary: over.summary ?? { proposed: 1, accepted: 0, dismissed: 0 },
  });
  render(<LearningTab flash={flash} />);
  await waitFor(() => expect(screen.getByText(/its own mistakes/)).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  api.decideLearningSuggestion.mockResolvedValue({});
});

test("THE SCREEN SAYS AGREEING CHANGES NOTHING", async () => {
  await open();
  expect(screen.getByText(/does not change anything on its own/i)).toBeInTheDocument();
  expect(screen.getByText(/still done by hand/i)).toBeInTheDocument();
});

test("the evidence is shown beside the proposal", async () => {
  await open();
  expect(screen.getByText(/undone 3 times/)).toBeInTheDocument();
  expect(screen.getByText(/wrong return date; driver was still at home/)).toBeInTheDocument();
});

test("agreeing sends the decision and any note", async () => {
  await open();
  fireEvent.change(screen.getByPlaceholderText(/a note, if you want one/), {
    target: { value: "it keeps picking the wrong cycle" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Good idea" }));
  await waitFor(() => expect(api.decideLearningSuggestion)
    .toHaveBeenCalledWith(4, "accepted", "it keeps picking the wrong cycle"));
});

test("declining is one click and needs no note", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "No" }));
  await waitFor(() => expect(api.decideLearningSuggestion).toHaveBeenCalledWith(4, "dismissed", null));
});

test("a decision already taken shows who took it, and can be undone", async () => {
  await open({
    suggestions: [{ ...WAITING, status: "dismissed", decidedBy: "boss", decisionNote: "those three were genuine" }],
  });
  expect(screen.getByText(/You said no · boss/)).toBeInTheDocument();
  expect(screen.getByText(/those three were genuine/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo that decision" }));
  await waitFor(() => expect(api.decideLearningSuggestion).toHaveBeenCalledWith(4, "proposed", null));
});

test("a decided proposal offers no Good idea / No buttons", async () => {
  await open({ suggestions: [{ ...WAITING, status: "accepted", decidedBy: "boss" }] });
  expect(screen.queryByRole("button", { name: "Good idea" })).toBeNull();
  expect(screen.queryByRole("button", { name: "No" })).toBeNull();
});

test("an empty list says so, and says how often Wenze looks", async () => {
  await open({ suggestions: [], summary: { proposed: 0, accepted: 0, dismissed: 0 } });
  expect(screen.getByText(/Nothing suggested/)).toBeInTheDocument();
  expect(screen.getByText(/twice a day/)).toBeInTheDocument();
});

test("a failed load flashes rather than rendering an empty all-clear", async () => {
  api.getLearningSuggestions.mockRejectedValue(new Error("service unavailable"));
  render(<LearningTab flash={flash} />);
  await waitFor(() => expect(flash).toHaveBeenCalledWith("error", "service unavailable"));
  expect(screen.queryByText(/Nothing suggested/)).toBeNull();
});
