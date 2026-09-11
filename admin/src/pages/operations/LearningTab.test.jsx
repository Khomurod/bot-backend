/**
 * What Wenze has noticed about its own mistakes.
 *
 * THE ONE THING THIS SCREEN MUST NEVER DO is let an administrator believe a
 * change was made when it was not. That used to be guaranteed the easy way —
 * nothing was ever made — and the guarantee was inverted: somebody who clicked
 * "good idea" on "switch automatic correction off for this check" believed they
 * had switched it off, stopped looking, and the check kept correcting.
 *
 * Now some suggestions genuinely change a setting and most still do not, so the
 * screen has to say WHICH — before the click and after it. These tests are that
 * distinction, from both sides.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LearningTab from "./LearningTab";
import * as api from "../../api";

vi.mock("../../api", () => ({
  getLearningSuggestions: vi.fn(),
  decideLearningSuggestion: vi.fn(),
  acceptLearningSuggestion: vi.fn(),
  revertLearningSuggestion: vi.fn(),
}));

const WAITING = {
  id: 4, kind: "reverted_correction", subjectId: "home_time.close_cycle",
  title: '"home time close cycle" has been undone 3 times',
  suggestion: "Consider switching automatic correction OFF for this check.",
  evidence: { count: 3, reasons: ["wrong return date", "driver was still at home"] },
  status: "proposed",
  // This one names a setting, so agreeing will change something.
  applyAction: "disable_auto_apply",
  applyPayload: { checkKeys: ["home_time.closable_open_cycle"] },
};

/** One with nothing to apply — agreement and nothing else. */
const MANUAL = {
  ...WAITING, id: 5, kind: "recruiting_refusal",
  title: "Wenze's answer to candidates was refused 4 times",
  suggestion: "Adding the fact under Teach Wenze would let it answer instead of deferring.",
  applyAction: null, applyPayload: null,
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
  api.acceptLearningSuggestion.mockResolvedValue({ applied: true, detail: "switched off" });
  api.revertLearningSuggestion.mockResolvedValue({ reverted: true, detail: "1 setting(s) put back." });
});

test("THE SCREEN SAYS WHICH KIND EACH SUGGESTION IS, BEFORE ANYTHING IS PRESSED", async () => {
  await open();
  expect(screen.getByText(/Agreeing will switch this setting now/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Agree and apply" })).toBeInTheDocument();
});

test("a suggestion with nothing to apply says so, and its button is different", async () => {
  await open({ suggestions: [MANUAL] });
  expect(screen.getByText(/Nothing changes automatically/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Agree" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Agree and apply" })).toBeNull();
});

test("and nothing is ever changed without the administrator", async () => {
  await open();
  expect(screen.getByText(/Nothing is ever changed without you/i)).toBeInTheDocument();
});

test("the evidence is shown beside the proposal", async () => {
  await open();
  expect(screen.getByText(/undone 3 times/)).toBeInTheDocument();
  expect(screen.getByText(/wrong return date; driver was still at home/)).toBeInTheDocument();
});

test("agreeing goes to /accept with the note, not to /decide", async () => {
  await open();
  fireEvent.change(screen.getByPlaceholderText(/a note, if you want one/), {
    target: { value: "it keeps picking the wrong cycle" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Agree and apply" }));
  await waitFor(() => expect(api.acceptLearningSuggestion)
    .toHaveBeenCalledWith(4, "it keeps picking the wrong cycle"));
  expect(api.decideLearningSuggestion).not.toHaveBeenCalled();
});

test("the message shown is the SERVER's answer, not what the screen assumed", async () => {
  api.acceptLearningSuggestion.mockResolvedValue({
    applied: false, detail: "Agreement recorded. Nothing was changed automatically.",
  });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Agree and apply" }));
  await waitFor(() => expect(flash)
    .toHaveBeenCalledWith("info", "Agreement recorded. Nothing was changed automatically."));
});

test("a row whose setting IS changed offers an undo", async () => {
  await open({ suggestions: [{ ...WAITING, status: "accepted_active", decidedBy: "boss" }] });
  expect(screen.getByText(/Agreed — and the setting is changed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo the change" }));
  await waitFor(() => expect(api.revertLearningSuggestion).toHaveBeenCalledWith(4, null));
});

test("a row that needs a person says so, and offers no undo-the-change", async () => {
  await open({ suggestions: [{ ...MANUAL, status: "accepted_manual", decidedBy: "boss" }] });
  expect(screen.getByText(/Agreed — needs you to do it/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Undo the change" })).toBeNull();
});

test("an old 'accepted' row is labelled honestly rather than relabelled", async () => {
  await open({ suggestions: [{ ...WAITING, status: "accepted", decidedBy: "boss" }] });
  expect(screen.getByText(/before Wenze could apply anything/)).toBeInTheDocument();
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
  expect(screen.getByText(/You said no/)).toBeInTheDocument();
  expect(screen.getByText(/boss/)).toBeInTheDocument();
  expect(screen.getByText(/those three were genuine/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo that decision" }));
  await waitFor(() => expect(api.decideLearningSuggestion).toHaveBeenCalledWith(4, "proposed", null));
});

test("a decided proposal offers no agree / no buttons", async () => {
  await open({ suggestions: [{ ...WAITING, status: "accepted_active", decidedBy: "boss" }] });
  expect(screen.queryByRole("button", { name: "Agree and apply" })).toBeNull();
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
