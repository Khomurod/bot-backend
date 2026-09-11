/**
 * The recruiting-hours screen, on the two things it must say plainly.
 *
 * WOULD WENZE ANSWER SOMEBODY RIGHT NOW is the question an administrator is
 * actually deciding about, and it is not the same question as whether the
 * office is shut. The screen answers it in a sentence, from the server's clock
 * rather than the browser's.
 *
 * AND A REFUSED SAVE HAS TO SAY WHY. The dangerous save here is silent: an
 * unreadable window is read as "not a window", the office looks open forever,
 * and a feature somebody switched on never runs.
 */
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkingHoursCard from "./WorkingHoursCard";
import * as api from "../../../api";

vi.mock("../../../api", () => ({
  getRecruitingHours: vi.fn(),
  saveRecruitingHours: vi.fn(),
  setRecruitingConversationStatus: vi.fn(),
}));

const OFFICE = [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }];

function payload(over = {}) {
  return {
    settings: {
      timezone: "America/Chicago",
      windows: OFFICE,
      aiAfterHoursEnabled: false,
      maxRepliesPerConversation: 4,
      quietStartLocal: "21:00",
      quietEndLocal: "08:00",
      ...(over.settings || {}),
    },
    now: { open: true, reason: "inside_window", localTime: "Fri 10:00", aiWouldAnswer: false, ...(over.now || {}) },
    summary: "Mon, Tue, Wed, Thu, Fri 08:00–18:00 (America/Chicago)",
    conversations: over.conversations || [],
  };
}

const flash = vi.fn();

async function open(over = {}) {
  api.getRecruitingHours.mockResolvedValue(payload(over));
  render(<WorkingHoursCard flash={flash} />);
  await waitFor(() => expect(screen.getByText(/Working hours/)).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  api.saveRecruitingHours.mockResolvedValue(payload());
  api.setRecruitingConversationStatus.mockResolvedValue({});
});

test("an open office says so, and says Wenze is not answering", async () => {
  await open();
  expect(screen.getByText(/The office is open right now/)).toBeInTheDocument();
  expect(screen.getByText(/a candidate would wait for a recruiter/)).toBeInTheDocument();
});

test("a closed office with the feature ON says Wenze WOULD answer", async () => {
  await open({
    settings: { aiAfterHoursEnabled: true },
    now: { open: false, reason: "outside_hours", localTime: "Fri 19:30", aiWouldAnswer: true },
  });
  expect(screen.getByText(/The office is closed right now/)).toBeInTheDocument();
  expect(screen.getByText(/Wenze would answer a candidate who texted now/)).toBeInTheDocument();
});

test("a closed office with the feature OFF does NOT claim Wenze would answer", async () => {
  await open({ now: { open: false, reason: "outside_hours", localTime: "Sat 14:00", aiWouldAnswer: false } });
  expect(screen.getByText(/The office is closed right now/)).toBeInTheDocument();
  expect(screen.getByText(/Wenze would not answer/)).toBeInTheDocument();
});

test("the screen states the limit on what Wenze may say, not only that it speaks", async () => {
  await open();
  expect(screen.getByText(/only state what you have approved/i)).toBeInTheDocument();
  expect(screen.getByText(/never promises, approves, waives, hires/i)).toBeInTheDocument();
});

test("switching the feature on sends the hours with it, so the server can check them together", async () => {
  await open();
  fireEvent.click(screen.getByLabelText(/continue the conversation as the assigned recruiter/i));
  await waitFor(() => expect(api.saveRecruitingHours).toHaveBeenCalled());
  expect(api.saveRecruitingHours).toHaveBeenCalledWith({
    aiAfterHoursEnabled: true, windows: OFFICE,
  });
});

test("a refused save surfaces the server's own sentence", async () => {
  await open({ settings: { windows: [] } });
  api.saveRecruitingHours.mockRejectedValue(
    new Error("Add at least one working-hours window first — with none, Wenze treats the office as always open."),
  );
  fireEvent.click(screen.getByLabelText(/continue the conversation as the assigned recruiter/i));
  await waitFor(() => expect(flash).toHaveBeenCalledWith("error", expect.stringMatching(/window first/)));
});

test("a window can be added and saved", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Add a window" }));
  fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
  await waitFor(() => expect(api.saveRecruitingHours).toHaveBeenCalled());
  expect(api.saveRecruitingHours.mock.calls[0][0].windows).toHaveLength(2);
});

test("a conversation shows how many drafts were refused, which is the signal to teach Wenze more", async () => {
  await open({
    conversations: [{
      driverPhone: "+15551230000", leadName: "Sam Rivera", status: "active",
      repliesSent: 2, refusals: 3, lastRefusalReason: "unapproved_figure — used 92",
    }],
  });
  expect(screen.getByText(/3 draft\(s\) refused/)).toBeInTheDocument();
  expect(screen.getByText(/used 92/)).toBeInTheDocument();
});

test("a conversation can be stopped, and a stopped one resumed", async () => {
  await open({
    conversations: [{ driverPhone: "+15551230000", status: "active", repliesSent: 1, refusals: 0 }],
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop Wenze here" }));
  await waitFor(() => expect(api.setRecruitingConversationStatus)
    .toHaveBeenCalledWith("+15551230000", "stopped"));
});
