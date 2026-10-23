/**
 * "What Wenze learned from you": the lessons in the person's own words, what
 * Wenze understood, taking one back, and skipping the question out now.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LessonsCard from "./LessonsCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getAiLessons: vi.fn(),
  removeAiLesson: vi.fn(),
  skipAiLearningQuestion: vi.fn(),
}));

const DATA = {
  lessons: [
    {
      id: 1, scope: "safety", source: "owner_answer", about: 'What did Safety decide? — "ok go"',
      statement: "ok go means approved", understoodAs: '"ok go" from Safety means approved.',
      createdByName: "Owner", createdAt: "2026-10-23T10:00:00Z", removedAt: null,
    },
    {
      id: 2, scope: "home_time", source: "accounting_reason", about: "A company driver came home early",
      statement: "family emergency", understoodAs: null,
      createdByName: "Ella", createdAt: "2026-10-22T10:00:00Z", removedAt: "2026-10-23T09:00:00Z",
    },
  ],
  current: { id: 9, ask: "Which stage has this candidate reached?" },
  counts: { queued: 2, asked: 1, answered: 5, skipped: 1 },
  scopes: { safety: "Safety Approvals", home_time: "Home time" },
};

async function open(props = {}) {
  api.getAiLessons.mockResolvedValue(DATA);
  render(<LessonsCard learningEnabled onToggle={vi.fn()} flash={vi.fn()} {...props} />);
  await waitFor(() => expect(screen.getByText("“ok go means approved”")).toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

test("each lesson shows the person's words, what Wenze understood, and where it came from", async () => {
  await open();
  expect(screen.getByText(/Understood: "ok go" from Safety means approved\./)).toBeInTheDocument();
  expect(screen.getByText(/Safety Approvals · Your answer · Owner/)).toBeInTheDocument();
  expect(screen.getByText(/Home time · Accounting's reason · Ella/)).toBeInTheDocument();
  expect(screen.getByText(/1 lesson\(s\) in use/)).toBeInTheDocument();
  // A removed lesson has no Remove button; the live one has.
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
});

test("Remove takes a lesson back after a confirmation", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  api.removeAiLesson.mockResolvedValue({ id: 1 });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(api.removeAiLesson).toHaveBeenCalledWith(1));
});

test("the question waiting in the group can be skipped, and the switch saves", async () => {
  api.skipAiLearningQuestion.mockResolvedValue({ skipped: true });
  const onToggle = vi.fn();
  await open({ onToggle });
  expect(screen.getByText("Which stage has this candidate reached?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Skip this question" }));
  await waitFor(() => expect(api.skipAiLearningQuestion).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText("Ask me when unsure"));
  expect(onToggle).toHaveBeenCalledWith(false);
});
